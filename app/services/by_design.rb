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

  def create_consumer
    Rails.logger.info("ByDesign create_consumer generate_consumer_payload #{generate_consumer_payload.to_json}")
    response = self.class.post(
      # "/api/rep/Create",
      "/api/users/customer",
      headers: headers,
      body: generate_consumer_payload.to_json
    )

    if response.code == 200
      JSON.parse(response.body)
    else
      { "Result" => { "IsSuccessful" => false, "Message" => response.body } }
    end
  end

private
  def headers
    { Authorization: authorization, "Content-Type": "application/json", Accept: "application/json" }
  end

  def authorization
    "Basic #{Base64.strict_encode64("#{ENV["BY_DESIGN_INTEGRATION_USERNAME"]}:#{ENV["BY_DESIGN_INTEGRATION_PASSWORD"]}").strip}" # rubocop:disable Layout/LineLength
  end

  def generate_consumer_payload
    {
      # SponsorRepDID: sponsor_rep_id,
      RepDID: sponsor_rep_id,
      FirstName: cart.dig(:ship_to, :first_name),
      LastName: cart.dig(:ship_to, :last_name),
      Email: cart.dig(:email),
      ShippingStreet1: cart.dig(:ship_to, :address1),
      ShippingStreet2: cart.dig(:ship_to, :address2),
      ShippingCity: cart.dig(:ship_to, :city),
      ShippingState: cart.dig(:ship_to, :state),
      ShippingPostalCode: cart.dig(:ship_to, :postal_code),
      ShippingCountry: cart.dig(:ship_to, :country_code),
      Password: "ByDesignTemporalPassword",
    }
  end
end
