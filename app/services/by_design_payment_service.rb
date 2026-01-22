class ByDesignPaymentService
  include HTTParty

  base_uri ENV["BY_DESIGN_API_URL"]

  # HTTP timeout in seconds
  DEFAULT_TIMEOUT = 30

  # Payment type mapping from Moola to ByDesign
  # All Moola payments use CreditCardAccountId 30
  PAYMENT_TYPE_MAP = {
    "LOAD_FUNDS_VIA_CARD" => { credit_card_account_id: 30, description: "Moola Card Payment" },
    "UWALLET_TRANSFER" => { credit_card_account_id: 30, description: "Moola Wallet Transfer" },
    "uwallet" => { credit_card_account_id: 30, description: "Moola Wallet" },
    "LOAD_FUNDS_VIA_CASH" => { credit_card_account_id: 30, description: "Moola Cash Payment" }
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
    def record_payment(order_id:, payment_detail:, card_details: {}, kyc_status: nil, invoice_number: nil)
      new.record_payment(
        order_id: order_id,
        payment_detail: payment_detail,
        card_details: card_details,
        kyc_status: kyc_status,
        invoice_number: invoice_number
      )
    end

    # Check if a payment should be skipped (not recorded)
    def should_skip_payment?(payment_detail)
      payment_detail["status"] == "Declined"
    end
  end

  def record_payment(order_id:, payment_detail:, card_details: {}, kyc_status: nil, invoice_number: nil)
    # Skip declined payments at processor level
    if self.class.should_skip_payment?(payment_detail)
      Rails.logger.info("[ByDesignPaymentService] Skipping declined payment: #{payment_detail['id']}")
      return { success: true, skipped: true, reason: "Payment declined at processor level" }
    end

    payload = build_payment_payload(order_id, payment_detail, card_details, kyc_status, invoice_number)

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

  def build_payment_payload(order_id, payment_detail, card_details, kyc_status, invoice_number)
    payment_type = payment_detail["type"]
    type_config = PAYMENT_TYPE_MAP[payment_type] || PAYMENT_TYPE_MAP["UWALLET_TRANSFER"]
    is_card_payment = payment_type == "LOAD_FUNDS_VIA_CARD"

    payload = {
      OrderID: order_id.to_i,
      Amount: calculate_amount(payment_detail, kyc_status),
      PromissoryAmount: calculate_promissory_amount(payment_detail, kyc_status),
      PaymentStatusTypeID: map_payment_status(payment_detail, kyc_status),
      CreditCardAccountId: type_config[:credit_card_account_id],
      PaymentDescription: "#{type_config[:description]} - #{payment_detail['id']}",
      PaymentDate: Time.current.iso8601,
      TransactionID: payment_detail["id"],
      ReferenceNumber: invoice_number
    }

    # Card fields only for LOAD_FUNDS_VIA_CARD payments
    if is_card_payment
      payload[:PaymentToken] = payment_detail["id"]
      payload[:Last4CCNumber] = extract_last4(payment_detail, card_details)
      payload[:ExpirationDateMMYY] = extract_expiry(card_details)
    end

    payload
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
    # KYC status overrides payment status
    return KYC_STATUS_MAP[kyc_status] if KYC_STATUS_MAP[kyc_status].present?

    # LOAD_FUNDS_VIA_CASH is always Pending regardless of status
    return 6 if payment_detail["type"] == "LOAD_FUNDS_VIA_CASH"

    # Use payment status for approved KYC
    PAYMENT_STATUS_MAP[payment_detail["status"]] || DEFAULT_PAYMENT_STATUS
  end

  def map_payment_status(payment_detail, kyc_status)
    determine_effective_status(payment_detail, kyc_status)
  end

  def extract_last4(payment_detail, card_details)
    # Try card_details first, then fall back to payment_detail id (last 4 chars)
    # Only called for LOAD_FUNDS_VIA_CARD payments
    card_details["last4"] || payment_detail["id"]&.last(4)
  end

  def extract_expiry(card_details)
    # Try explicit expiry_date field first
    if card_details["expiry_date"].present?
      # Parse formats like "8/2029" or "08/29"
      parts = card_details["expiry_date"].to_s.split("/")
      if parts.length == 2
        month = parts[0].rjust(2, "0")
        year = parts[1].last(2)
        return "#{month}#{year}"
      end
    end

    # Try month/year fields
    if card_details["expiry_month"].present? && card_details["expiry_year"].present?
      month = card_details["expiry_month"].to_s.rjust(2, "0")
      year = card_details["expiry_year"].to_s.last(2)
      return "#{month}#{year}"
    end

    # No default - return nil if no expiry data available
    nil
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
