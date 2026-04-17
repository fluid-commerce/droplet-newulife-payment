class ByDesign
  attr_reader :cart, :sponsor_rep_id
  include HTTParty

  base_uri ENV["BY_DESIGN_API_URL"]

  def initialize(cart:, sponsor_rep_id:)
    @cart = ActiveSupport::HashWithIndifferentAccess.new(cart)
    @sponsor_rep_id = sponsor_rep_id
  end

  def self.create_consumer(cart:, sponsor_rep_id:)
    new(cart:, sponsor_rep_id:).create_consumer
  end

  def self.downline_lookup(rep_did:, search: nil)
    response = get(
      "/api/Personal/Enrollment/DownlineLookup",
      query: { repDID: rep_did, searchString: search },
      headers: api_headers
    )

    if response.code == 200
      JSON.parse(response.body)
    else
      Rails.logger.error("ByDesign downline lookup error (#{response.code}): #{response.body}")
      { "IsSuccessful" => false, "Message" => "ByDesign API error (#{response.code})", "Result" => [] }
    end
  end

  def create_consumer
    payload = generate_consumer_payload
    Rails.logger.info("ByDesign create_consumer payload: #{payload.to_json}")

    response = self.class.post(
      "/api/users/customer",
      headers: headers,
      body: payload.to_json
    )

    Rails.logger.info("ByDesign create_consumer response code: #{response.code}")
    Rails.logger.info("ByDesign create_consumer response body: #{response.body}")

    if response.code == 200
      # Wrap success response to include Result structure for consistent handling
      customer_data = JSON.parse(response.body)
      customer_data.merge("Result" => { "IsSuccessful" => true })
    else
      error_message = "ByDesign API error (#{response.code}): #{response.body}"
      Rails.logger.error(error_message)
      { "Result" => { "IsSuccessful" => false, "Message" => error_message } }
    end
  end

  def self.api_headers
    auth = "Basic #{Base64.strict_encode64("#{ENV["BY_DESIGN_INTEGRATION_USERNAME"]}:#{ENV["BY_DESIGN_INTEGRATION_PASSWORD"]}").strip}"
    { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" }
  end

private
  def headers
    self.class.api_headers
  end

  def generate_consumer_payload
    {
      RepDID: sponsor_rep_id,
      FirstName: cart.dig(:ship_to, :first_name),
      LastName: cart.dig(:ship_to, :last_name),
      Email: cart.dig(:email),
      ShippingStreet1: cart.dig(:ship_to, :address1),
      ShippingStreet2: cart.dig(:ship_to, :address2),
      ShippingCity: cart.dig(:ship_to, :city),
      ShippingState: cart.dig(:ship_to, :state),
      ShippingPostalCode: normalize_postal_code(cart.dig(:ship_to, :postal_code)),
      ShippingCountry: map_country_code_to_bydesign(cart.dig(:ship_to, :country_code)),
      BillingStreet1: cart.dig(:ship_to, :address1),
      BillingStreet2: cart.dig(:ship_to, :address2),
      BillingCity: cart.dig(:ship_to, :city),
      BillingState: cart.dig(:ship_to, :state),
      BillingPostalCode: normalize_postal_code(cart.dig(:ship_to, :postal_code)),
      BillingCountry: map_country_code_to_bydesign(cart.dig(:ship_to, :country_code)),
      Password: "ByDesignTemporalPassword",
    }
  end

  # Normalize postal code - remove spaces for Canadian postal codes
  # Canadian format: "V9R 5G1" -> "V9R5G1"
  def normalize_postal_code(postal_code)
    return postal_code if postal_code.blank?

    postal_code.to_s.gsub(/\s+/, "")
  end

  # Map ISO country codes to ByDesign's expected country names
  # Uses shared COUNTRY_CODE_MAP from ByDesignPaymentService for consistency
  def map_country_code_to_bydesign(country_code)
    return country_code if country_code.blank?

    ByDesignPaymentService::COUNTRY_CODE_MAP[country_code.upcase] || country_code
  end

  # Full list of ByDesign active countries (for future reference):
  # AUSTRALIA, BELGIUM, CANADA, CHINA, GERMANY, HONG KONG, JAPAN, Jersey,
  # KOREA (THE REPUBLIC OF), MALAYSIA, NETHERLANDS, NEW ZEALAND, SINGAPORE,
  # TAIWAN, THAILAND, UNITED KINGDOM, USA
  #
  # Special rules from ByDesign:
  # - China should be displayed as "Hong Kong Cross Market" but sent as "CHINA"
  # - Korea needs the full string "KOREA (THE REPUBLIC OF)" (not just "Korea")
  #
  # Potential full mapping (if needed in the future):
  # "AU" => "AUSTRALIA", "BE" => "BELGIUM", "CA" => "CANADA", "CN" => "CHINA",
  # "DE" => "GERMANY", "HK" => "HONG KONG", "JP" => "JAPAN", "JE" => "Jersey",
  # "KR" => "KOREA (THE REPUBLIC OF)", "MY" => "MALAYSIA", "NL" => "NETHERLANDS",
  # "NZ" => "NEW ZEALAND", "SG" => "SINGAPORE", "TW" => "TAIWAN", "TH" => "THAILAND",
  # "GB" => "UNITED KINGDOM", "US" => "USA"
end
