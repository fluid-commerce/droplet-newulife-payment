class UPaymentsConsumerPayloadGenerator
  attr_reader :cart, :external_id

  # TODO: These are Sandbox product ids, need to replace with production ids
  PRODUCT_IDS = {
    CAD: "8d7106c8-3ec9-4e1f-9942-7ab04359b234", # Canada uses USD product
    CNY: "a8c5a3ca-e5cc-46d8-97d9-8dbc7a391ba7",
    EUR: "f5c806e6-ad3e-44d6-b8c7-baf19aad0227",
    GBP: "ba5c93f9-fca6-4c06-babf-ffa41732b96b",
    HKD: "3285a071-8aed-4ab0-8164-e6877111153d",
    JPY: "a5a0d5bb-fc36-478b-bb7a-69997300fcc9",
    KRW: "48d534a0-9238-4da5-bf4c-4bed332ca4f3",
    MYR: "25a392df-ac72-4a6b-a59b-e300232288bc",
    SGD: "1fc7b689-1270-48f8-a0f5-19783787d183",
    THB: "97ee0547-2e65-43cf-a4b2-2cc25725edda",
    TWD: "565a6912-058b-444a-bbc7-6a8f34b62dd7",
    USD: "8d7106c8-3ec9-4e1f-9942-7ab04359b234",
  }.freeze

  def initialize(cart:, external_id:)
    @cart = ActiveSupport::HashWithIndifferentAccess.new(cart)
    @external_id = external_id
  end

  def self.generate_consumer_payload(cart:, external_id:)
    new(cart:, external_id:).generate_consumer_payload
  end

  def generate_consumer_payload
    {
      first_name: cart[:ship_to][:first_name],
      last_name: cart[:ship_to][:last_name],
      email: cart[:email],
      phone: nil,
      product_uuid: PRODUCT_IDS[cart[:currency_code].to_sym],
      dob: nil,
      address1: cart[:ship_to][:address1],
      address2: cart[:ship_to][:address2],
      city: cart[:ship_to][:city],
      state: cart[:ship_to][:state],
      zipcode: cart[:ship_to][:postal_code],
      country_code: "+1", # TODO: Add country code, how to get this?
      ssn: nil, # TODO: Add SSN, how to get this?
      primaryWallet: cart[:currency_code],
      business_name: nil,
      external_id: external_id,
      hkcm: false,
    }
  end
end
