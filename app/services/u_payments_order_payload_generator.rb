class UPaymentsOrderPayloadGenerator
  attr_reader :cart, :external_id, :payment_account_id

  def initialize(cart:, external_id:, payment_account_id:)
    @cart = ActiveSupport::HashWithIndifferentAccess.new(cart)
    @external_id = external_id
    @payment_account_id = payment_account_id
  end

  def self.generate_order_payload(cart:, external_id:, payment_account_id:)
    new(cart:, external_id:, payment_account_id:).generate_order_payload
  end

  def generate_order_payload
    {
      invoiceNumber: Time.now.to_i.to_s,
      totalAmount: format("%.2f", cart[:amount_total]),
      **conditional_sales_tax,
      currency: cart[:currency_code],
      redirectUrl: "#{ENV['DROPLET_HOST_URL']}/checkout/success/#{cart[:cart_token]}/payment_account/#{payment_account_id}", # rubocop:disable Layout/LineLength
      cancelUrl: "#{ENV['CHECKOUT_HOST_URL']}/checkouts/#{cart[:cart_token]}",
      orderTime: Time.now.to_i.to_s,
      externalId: external_id,
      language: cart[:language_iso],
      tipAllowed: false,
      autoshipRequired: cart[:recurring].present?,
      shippingInformation: {
        AddressLine1: cart[:ship_to][:address1],
        AddressLine2: cart[:ship_to][:address2],
        city: cart[:ship_to][:city],
        country: cart[:ship_to][:country_code],
        emailaddress: cart[:ship_to][:email],
        recipientName: cart[:ship_to][:name],
        postalCode: cart[:ship_to][:postal_code],
        phoneNumber: nil,
        state: cart[:ship_to][:state],
        # shippingType:   #Same Day = SD, Next Day = ND, Second Day = 2D, Standard = ST, Delivery = DE, Pick-up = PU
      },
      productDetails: cart[:items].map do |item|
        {
          productId: item[:product][:sku],
          description: item[:product_title],
          quantity: item[:quantity].to_s,
          unitPrice: item[:price].to_s,
        }
      end,
    }
  end

  private

  def conditional_sales_tax
    return {} unless cart[:tax_total].present?

    formatted_tax = format("%.2f", cart[:tax_total])
    formatted_tax == "0.00" ? {} : { salesTax: formatted_tax }
  end
end
