class ByDesignPaymentService
  include HTTParty

  base_uri ENV["BY_DESIGN_API_URL"]

  # HTTP timeout in seconds
  DEFAULT_TIMEOUT = 30

  # Supported payment types - explicitly enumerated for clarity
  CARD_PAYMENT_TYPE = "LOAD_FUNDS_VIA_CARD"
  CASH_PAYMENT_TYPE = "LOAD_FUNDS_VIA_CASH"
  WALLET_PAYMENT_TYPES = %w[UWALLET_TRANSFER uwallet].freeze
  SUPPORTED_PAYMENT_TYPES = ([CARD_PAYMENT_TYPE, CASH_PAYMENT_TYPE] + WALLET_PAYMENT_TYPES).freeze

  # Payment type mapping from Moola to ByDesign
  # All Moola payments use CreditCardAccountId 30
  PAYMENT_TYPE_MAP = {
    CARD_PAYMENT_TYPE => { credit_card_account_id: 30, description: "Moola Card Payment" },
    "UWALLET_TRANSFER" => { credit_card_account_id: 30, description: "Moola Wallet Transfer" },
    "uwallet" => { credit_card_account_id: 30, description: "Moola Wallet" },
    CASH_PAYMENT_TYPE => { credit_card_account_id: 30, description: "Moola Cash Payment" }
  }.freeze

  # Payment status mapping based on Moola guide:
  # - KYC status OVERRIDES payment status (handled in map_payment_status)
  # - LOAD_FUNDS_VIA_CASH is always Pending regardless of status
  # - Declined payments at processor level should be skipped (not recorded)
  PAYMENT_STATUS_MAP = {
    "Success" => 1,      # Normal/Approved
    "Pending" => 6,      # Pending
    "Declined" => 18,    # Declined - but these should typically be skipped
    "Failed" => 18       # Declined
  }.freeze

  # KYC status to PaymentStatusTypeID mapping
  # KYC status overrides payment status per Moola guide
  KYC_STATUS_MAP = {
    "APPROVE" => nil,    # Use payment status
    "REVIEW" => 6,       # Pending
    "DECLINE" => 18      # Declined
  }.freeze

  DEFAULT_PAYMENT_STATUS = 6  # Pending - safer default than Success

  class << self
    # Record a payment to ByDesign
    #
    # @param order_id [String, Integer] The ByDesign OrderID
    # @param payment_detail [Hash] Individual payment from P2M webhook payment_details[]
    #   - "id" => Payment ID (e.g., "EZC1236EQI")
    #   - "amount" => Payment amount (e.g., "878.00")
    #   - "type" => Payment type (e.g., "LOAD_FUNDS_VIA_CARD", "uwallet")
    #   - "status" => Payment status (e.g., "Success", "Pending")
    #   - "order_reference" => Order reference (e.g., "TKW2BRL2OP")
    # @param p2m_data [Hash] Root-level data from P2M webhook
    #   - "order_reference" => Order reference (e.g., "TKW2BRL2OP")
    #   - "client_uuid" => Client UUID for PersistentToken (e.g., "94d15bf3-...")
    #   - "invoice_number" => Invoice number with prefix (e.g., "NULF-CT:cart123")
    #   - "autoship_reference" => Autoship reference if present (e.g., "G2XYS6ZBBZ")
    # @param card_details [Hash] Card details from load_funds_via_card webhook (card payments only)
    #   - "card_number_last4" => Last 4 digits (e.g., "7999")
    #   - "expiry_date" => Expiry date (e.g., "8/2029")
    #   - "payment_instrument_uuid" => Payment token UUID
    # @param kyc_status [String] KYC status from webhook ("APPROVE", "REVIEW", "DECLINE")
    def record_payment(order_id:, payment_detail:, p2m_data: {}, card_details: {}, kyc_status: nil)
      new.record_payment(
        order_id: order_id,
        payment_detail: payment_detail,
        p2m_data: p2m_data,
        card_details: card_details,
        kyc_status: kyc_status
      )
    end

    # Check if a payment should be skipped (not recorded)
    def should_skip_payment?(payment_detail)
      payment_detail["status"] == "Declined"
    end

    # Payment type check methods - explicitly identify each payment type
    def card_payment?(payment_type)
      payment_type == CARD_PAYMENT_TYPE
    end

    def cash_payment?(payment_type)
      payment_type == CASH_PAYMENT_TYPE
    end

    def wallet_payment?(payment_type)
      WALLET_PAYMENT_TYPES.include?(payment_type)
    end

    def supported_payment_type?(payment_type)
      SUPPORTED_PAYMENT_TYPES.include?(payment_type)
    end
  end

  def record_payment(order_id:, payment_detail:, p2m_data: {}, card_details: {}, kyc_status: nil)
    # Skip declined payments at processor level
    if self.class.should_skip_payment?(payment_detail)
      Rails.logger.info("[ByDesignPaymentService] Skipping declined payment: #{payment_detail['id']}")
      return { success: true, skipped: true, reason: "Payment declined at processor level" }
    end

    payload = build_payment_payload(order_id, payment_detail, p2m_data, card_details, kyc_status)

    Rails.logger.info("[ByDesignPaymentService] Recording payment: OrderID=#{order_id}, " \
                      "Amount=#{payment_detail['amount']}, Type=#{payment_detail['type']}, KYC=#{kyc_status}")
    Rails.logger.debug("[ByDesignPaymentService] Payload: #{payload.to_json}")

    response = self.class.post(
      "/api/Personal/Order/Payment/CreditCard/Save",
      headers: headers,
      body: payload.to_json,
      timeout: DEFAULT_TIMEOUT
    )

    Rails.logger.info("[ByDesignPaymentService] Response: code=#{response.code}")
    Rails.logger.debug("[ByDesignPaymentService] Response body: #{sanitize_response_for_log(response.body)}")

    parse_response(response)
  rescue Net::OpenTimeout, Net::ReadTimeout => e
    Rails.logger.error("[ByDesignPaymentService] Timeout error: #{e.class} - #{e.message}")
    { success: false, error: "Request timeout: #{e.message}", response: nil }
  rescue StandardError => e
    Rails.logger.error("[ByDesignPaymentService] Error: #{e.class} - #{e.message}")
    { success: false, error: e.message, response: nil }
  end

private

  def headers
    {
      "Authorization" => authorization,
      "Content-Type" => "application/json",
      "Accept" => "application/json"
    }
  end

  def authorization
    credentials = "#{ENV['BY_DESIGN_INTEGRATION_USERNAME']}:#{ENV['BY_DESIGN_INTEGRATION_PASSWORD']}"
    "Basic #{Base64.strict_encode64(credentials).strip}"
  end

  def build_payment_payload(order_id, payment_detail, p2m_data, card_details, kyc_status)
    payment_type = payment_detail["type"]
    type_config = get_payment_type_config(payment_type)

    # Build base payload common to all payment types
    payload = build_base_payload(order_id, payment_detail, p2m_data, type_config, kyc_status)

    # Add type-specific fields based on the payment type
    if self.class.card_payment?(payment_type)
      add_card_payment_fields(payload, payment_detail, card_details)
    elsif self.class.cash_payment?(payment_type)
      # Cash payments use base payload only - no additional fields
      Rails.logger.debug("[ByDesignPaymentService] Processing cash payment: #{payment_detail['id']}")
    elsif self.class.wallet_payment?(payment_type)
      # Wallet payments use base payload only - no additional fields
      Rails.logger.debug("[ByDesignPaymentService] Processing wallet payment: #{payment_detail['id']}")
    end

    payload
  end

  def get_payment_type_config(payment_type)
    unless self.class.supported_payment_type?(payment_type)
      Rails.logger.warn("[ByDesignPaymentService] Unknown payment type '#{payment_type}', defaulting to wallet configuration")
    end

    # Explicit lookup - only use default for truly unknown types
    PAYMENT_TYPE_MAP.fetch(payment_type) do
      PAYMENT_TYPE_MAP["UWALLET_TRANSFER"]
    end
  end

  def build_base_payload(order_id, payment_detail, p2m_data, type_config, kyc_status)
    # Extract P2M webhook data with safe fallbacks
    order_reference = extract_order_reference(payment_detail, p2m_data)
    client_uuid = p2m_data["client_uuid"]
    invoice_number = p2m_data["invoice_number"]
    autoship_reference = p2m_data["autoship_reference"]
    payment_type = payment_detail["type"]

    {
      # Required fields
      OrderID: order_id.to_i,
      Amount: calculate_amount(payment_detail, kyc_status),
      PromissoryAmount: calculate_promissory_amount(payment_detail, kyc_status),
      PaymentStatusTypeID: map_payment_status(payment_detail, kyc_status),
      CreditCardAccountId: type_config[:credit_card_account_id],
      PaymentDate: payment_date(p2m_data),

      # Transaction identifiers (per API docs)
      TransactionID: order_reference,                    # order_reference from P2M webhook
      ReferenceNumber: payment_detail["id"],             # payment_detail.id (unique per payment)

      # Token fields for recurring/profile tracking
      PersistentToken: client_uuid,                      # client_uuid from P2M webhook
      ProfileIDUsedForProcessor: client_uuid,            # Same as PersistentToken

      # Processor-specific detail fields (for tracking/debugging)
      ProcessorSpecificDetail1: invoice_number,          # invoice_number (e.g., "NULF-CT:cart123")
      ProcessorSpecificDetail2: autoship_reference,      # autoship_reference if present
      ProcessorSpecificDetail3: normalize_payment_type(payment_type),  # Payment type for differentiation
      ProcessorSpecificDetail4: order_reference          # order_reference (same as TransactionID)
    }
  end

  # Extract order_reference - can come from payment_detail or p2m_data
  def extract_order_reference(payment_detail, p2m_data)
    # Payment detail may have its own order_reference, or use P2M root level
    payment_detail["order_reference"].presence || p2m_data["order_reference"]
  end

  # Normalize payment type to lowercase with underscores (per API docs examples)
  def normalize_payment_type(payment_type)
    return nil unless payment_type.present?

    # API docs show lowercase: "load_funds_via_card", "uwallet_transfer", "uwallet"
    payment_type.downcase
  end

  # Get payment date from webhook completed_at or use current time
  def payment_date(p2m_data)
    completed_at = p2m_data["completed_at"]
    if completed_at.present?
      # completed_at is a timestamp in milliseconds (e.g., "2767187441840")
      begin
        Time.at(completed_at.to_i / 1000).iso8601
      rescue StandardError
        Time.current.iso8601
      end
    else
      Time.current.iso8601
    end
  end

  def add_card_payment_fields(payload, payment_detail, card_details)
    # PaymentToken should be payment_instrument_uuid from load_funds_via_card webhook
    payload[:PaymentToken] = extract_payment_token(card_details)
    payload[:Last4CCNumber] = extract_last4_for_card(card_details)
    payload[:ExpirationDateMMYY] = extract_expiry_for_card(card_details)
    Rails.logger.debug("[ByDesignPaymentService] Processing card payment: #{payment_detail['id']}")
  end

  # Extract payment token (payment_instrument_uuid) from card details
  def extract_payment_token(card_details)
    card_details["payment_instrument_uuid"]
  end

  def calculate_amount(payment_detail, kyc_status)
    # Use promissory (amount = 0) when:
    # - Payment status is Pending
    # - KYC is REVIEW (not yet approved)
    # - Payment type is LOAD_FUNDS_VIA_CASH (always Pending)
    effective_status = determine_effective_status(payment_detail, kyc_status)
    return 0 if effective_status == 6  # Pending

    payment_detail["amount"].to_f
  end

  def calculate_promissory_amount(payment_detail, kyc_status)
    # Use promissory amount when effective status is Pending
    effective_status = determine_effective_status(payment_detail, kyc_status)
    return payment_detail["amount"].to_f if effective_status == 6  # Pending

    0
  end

  def determine_effective_status(payment_detail, kyc_status)
    # Priority 1: KYC status overrides payment status (if KYC status maps to a value)
    kyc_override = KYC_STATUS_MAP[kyc_status]
    if kyc_override.present?
      return kyc_override
    end

    # Priority 2: LOAD_FUNDS_VIA_CASH is always Pending regardless of status
    if self.class.cash_payment?(payment_detail["type"])
      return 6  # Pending
    end

    # Priority 3: Use payment status mapping (with safe default for unknown statuses)
    payment_status = payment_detail["status"]
    if payment_status.present? && PAYMENT_STATUS_MAP.key?(payment_status)
      return PAYMENT_STATUS_MAP[payment_status]
    end

    # Default: Pending (safer than Success for unknown statuses)
    DEFAULT_PAYMENT_STATUS
  end

  def map_payment_status(payment_detail, kyc_status)
    determine_effective_status(payment_detail, kyc_status)
  end

  # Extract last4 for card payments only
  # Uses explicit .present? checks to avoid empty string issues
  # Card details come from load_funds_via_card webhook with field "card_number_last4"
  def extract_last4_for_card(card_details)
    # Check for card_number_last4 (actual webhook field name)
    if card_details["card_number_last4"].present?
      return card_details["card_number_last4"]
    end

    # Fallback: check for "last4" (alternative field name)
    if card_details["last4"].present?
      return card_details["last4"]
    end

    # No valid data available
    nil
  end

  # Extract expiry for card payments only
  # Uses explicit .present? checks to avoid empty string issues
  def extract_expiry_for_card(card_details)
    # Priority 1: Explicit expiry_date field (formats: "8/2029" or "08/29")
    expiry_date = card_details["expiry_date"]
    if expiry_date.present?
      parsed = parse_expiry_date(expiry_date)
      return parsed if parsed.present?
    end

    # Priority 2: Separate month/year fields
    expiry_month = card_details["expiry_month"]
    expiry_year = card_details["expiry_year"]
    if expiry_month.present? && expiry_year.present?
      return format_expiry(expiry_month, expiry_year)
    end

    # No valid expiry data available
    nil
  end

  # Alias for backward compatibility with existing tests
  def extract_expiry(card_details)
    extract_expiry_for_card(card_details)
  end

  def parse_expiry_date(expiry_date)
    parts = expiry_date.to_s.split("/")
    return nil unless parts.length == 2

    month = parts[0]
    year = parts[1]
    return nil unless month.present? && year.present?

    format_expiry(month, year)
  end

  def format_expiry(month, year)
    formatted_month = month.to_s.rjust(2, "0")
    formatted_year = year.to_s.last(2)
    "#{formatted_month}#{formatted_year}"
  end

  def parse_response(response)
    if response.code == 200
      body = parse_json_safely(response.body)

      if body.dig("Result", "IsSuccessful") || body["success"]
        { success: true, response: body, error: nil }
      else
        error_msg = body.dig("Result", "Message") || body["message"] || "Unknown error"
        { success: false, response: body, error: error_msg }
      end
    else
      { success: false, response: response.body, error: "HTTP #{response.code}: #{response.message}" }
    end
  end

  def parse_json_safely(json_string)
    JSON.parse(json_string)
  rescue JSON::ParserError => e
    Rails.logger.error("[ByDesignPaymentService] JSON parse error: #{e.message}")
    {}
  end

  def sanitize_response_for_log(response_body)
    # Don't log potentially sensitive response data at debug level
    return "[Response body too large]" if response_body.to_s.length > 1000

    response_body
  end
end
