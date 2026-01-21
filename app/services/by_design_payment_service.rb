class ByDesignPaymentService
  include HTTParty

  base_uri ENV["BY_DESIGN_API_URL"]

  # HTTP timeout in seconds
  DEFAULT_TIMEOUT = 30

  # Payment type mapping from Moola to ByDesign
  PAYMENT_TYPE_MAP = {
    "LOAD_FUNDS_VIA_CARD" => { credit_card_account_id: 30, description: "Moola Card Payment" },
    "UWALLET_TRANSFER" => { credit_card_account_id: 30, description: "Moola Wallet Transfer" },
    "uwallet" => { credit_card_account_id: 30, description: "Moola Wallet" }
  }.freeze

  # Payment status mapping
  # Default to Pending (6) for unknown statuses to avoid accidentally marking payments as approved
  PAYMENT_STATUS_MAP = {
    "Success" => 1,      # Normal/Approved
    "Pending" => 6,      # Pending
    "Declined" => 18,    # Declined
    "Failed" => 18       # Declined
  }.freeze

  DEFAULT_PAYMENT_STATUS = 6  # Pending - safer default than Success

  class << self
    def record_payment(order_id:, payment_detail:, card_details: {})
      new.record_payment(order_id: order_id, payment_detail: payment_detail, card_details: card_details)
    end
  end

  def record_payment(order_id:, payment_detail:, card_details: {})
    payload = build_payment_payload(order_id, payment_detail, card_details)

    Rails.logger.info("[ByDesignPaymentService] Recording payment: OrderID=#{order_id}, " \
                      "Amount=#{payment_detail['amount']}, Type=#{payment_detail['type']}")
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

  def build_payment_payload(order_id, payment_detail, card_details)
    payment_type = payment_detail["type"]
    type_config = PAYMENT_TYPE_MAP[payment_type] || PAYMENT_TYPE_MAP["UWALLET_TRANSFER"]

    {
      OrderID: order_id.to_i,
      Amount: calculate_amount(payment_detail),
      PromissoryAmount: calculate_promissory_amount(payment_detail),
      PaymentStatusTypeID: map_payment_status(payment_detail["status"]),
      CreditCardAccountId: type_config[:credit_card_account_id],
      PaymentToken: payment_detail["id"],  # Moola payment ID as token
      PaymentDescription: "#{type_config[:description]} - #{payment_detail['id']}",
      Last4CCNumber: extract_last4(payment_detail, card_details),
      ExpirationDateMMYY: extract_expiry(card_details)
    }
  end

  def calculate_amount(payment_detail)
    # If payment is pending, set amount to 0
    return 0 if payment_detail["status"] == "Pending"

    payment_detail["amount"].to_f
  end

  def calculate_promissory_amount(payment_detail)
    # If payment is pending, use promissory amount
    return payment_detail["amount"].to_f if payment_detail["status"] == "Pending"

    0
  end

  def map_payment_status(status)
    # Default to Pending for unknown statuses - safer than defaulting to Success
    PAYMENT_STATUS_MAP[status] || DEFAULT_PAYMENT_STATUS
  end

  def extract_last4(payment_detail, card_details)
    # Try card_details first, then fall back to payment_detail id (last 4 chars)
    card_details["last4"] || payment_detail["id"]&.last(4) || "0000"
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

    # Default far-future expiry for non-card payments
    "1299"
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
