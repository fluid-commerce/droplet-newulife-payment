class CheckoutCallbackController < ApplicationController
  skip_before_action :verify_authenticity_token

  def get_redirect_url
    Rails.logger.info("CheckoutCallbackController START get_redirect_url")
    consumer_external_id = external_id
    # consumer_external_id = no_prefix_external_id
    user_check_response = UPaymentsUserApiClient.check_user_exists(
      email: callback_params[:cart][:email],
      external_id: consumer_external_id
    )

    Rails.logger.info("CheckoutCallbackController user_check_response #{user_check_response.inspect}")

    user = user_check_response

    Rails.logger.info("CheckoutCallbackController user_check_response.dig('status') #{user_check_response.dig('status')}")
    if user_check_response.dig("status")&.zero?
      # Create consumer in ByDesign
      sponsor_rep_id = callback_params[:attribution]&.dig(:external_id) || "1"
      by_design_consumer = ByDesign.create_consumer(
        cart: cart_payload,
        sponsor_rep_id: sponsor_rep_id
      )

      Rails.logger.info("CheckoutCallbackController by_design_consumer #{by_design_consumer.inspect}")

      by_design_successful = by_design_consumer.dig("Result", "IsSuccessful")
      by_design_customer_id = by_design_consumer.dig("CustomerID")
      Rails.logger.info("CheckoutCallbackController by_design_consumer response #{by_design_successful}")

      # Check if customer already exists in Fluid
      Rails.logger.info("CheckoutCallbackController fluid_customer")
      fluid_customer = fluid_client.get("/api/customers?search_query=#{customer_payload.dig(:email)}&page=1&per_page=1")
      Rails.logger.info("CheckoutCallbackController fluid_customer #{fluid_customer.inspect}")

      if fluid_customer["customers"].present?
        # Customer already exists in Fluid, use their external_id
        consumer_external_id = fluid_customer["customers"].first["external_id"]
        Rails.logger.info("CheckoutCallbackController using existing Fluid customer external_id: #{consumer_external_id}")
      elsif by_design_successful && by_design_customer_id.present?
        # ByDesign succeeded, create new Fluid customer with ByDesign ID
        consumer_external_id = "C#{by_design_customer_id}"
        response = fluid_client.post("/api/customers", body: customer_payload.merge(external_id: consumer_external_id))
        Rails.logger.info("CheckoutCallbackController post /api/customers response #{response.inspect}")
      else
        # ByDesign failed and no existing Fluid customer - cannot proceed
        error_message = by_design_consumer.dig("Result", "Message") || "Failed to create customer in ByDesign"
        Rails.logger.error("ByDesign customer creation failed and no existing Fluid customer: #{error_message}")
        return render json: { redirect_url: nil, error_message: error_message }
      end

      # Create consumer in UPayments
      user_payload = UPaymentsConsumerPayloadGenerator.generate_consumer_payload(
        cart: cart_payload,
        external_id: consumer_external_id
      )
      Rails.logger.info("CheckoutCallbackController user_payload #{user_payload.inspect}")
      user_onboard_response = UPaymentsUserApiClient.onboard_consumer(payload: user_payload)
      if user_onboard_response.dig("status")&.zero?
        error_message = user_onboard_response.dig("error", "message")
        return render json: { redirect_url: nil, error_message: error_message }
      end
      user = user_onboard_response
      Rails.logger.info("CheckoutCallbackController user #{user.inspect}")
      user
    end

    order_payload = UPaymentsOrderPayloadGenerator.generate_order_payload(
      cart: cart_payload,
      external_id: consumer_external_id,
      payment_account_id: callback_params[:payment_account_id]
    )
    Rails.logger.info("CheckoutCallbackController order_payload #{order_payload.inspect}")

    redirect_url_response = UPaymentsCheckoutApiClient.create_order(payload: order_payload)

    Rails.logger.info("CheckoutCallbackController redirect_url_response #{redirect_url_response.inspect}")
    if redirect_url_response.dig("status")&.zero?
      error_message = redirect_url_response.dig("error", "message")

      Rails.logger.info("CheckoutCallbackController error_message #{error_message.inspect}")
      return render json: { redirect_url: nil, error_message: error_message }
    end

    uuid = user.dig("data", "uuid")
    base_redirect_url = redirect_url_response.dig("data", "redirectUrl")
    final_redirect_url = "#{base_redirect_url}&uuid=#{uuid}"

    Rails.logger.info("Final Step uuid #{uuid}")
    Rails.logger.info("Final Step base_redirect_url #{base_redirect_url}")
    Rails.logger.info("Final Step final_redirect_url #{final_redirect_url}")

    render json: { redirect_url: final_redirect_url, error_message: nil }
  end

  def success
    status = extract_status
    if status == "SUCCESS"
      cart_token = success_params[:cart_token]
      payment_account_id = extract_payment_account_id

      # Call the fluid checkout api to create payment and payment_methods
      payment_payload = {
        cart_token: cart_token,
        payment_method: {
          integration_class: "Droplet",
          source: "droplet",
        },
      }
      payment_response = fluid_client.post("/api/v202506/payments/#{payment_account_id}", body: payment_payload)
      payment_uuid = payment_response["payment"]["uuid"]

      Rails.logger.info("payment_response #{payment_response.inspect}")
      Rails.logger.info("payment_response['payment']['uuid'] #{payment_response['payment']['uuid']}")

      # Call the fluid checkout api to create the order
      checkout_response = fluid_client.post("/api/carts/#{cart_token}/checkout?payment_uuid=#{payment_uuid}")

      Rails.logger.info("Final Step checkout_response #{checkout_response.inspect}")
      Rails.logger.info("Final Step checkout_response['order']['order_confirmation_url'] #{checkout_response['order']['order_confirmation_url']}")

      # Fallback: set ByDesign OrderID on MoolaPayment from checkout response (if Fluid includes it)
      # Primary source is Fluid order.external_id_updated webhook; this avoids waiting for that webhook
      update_moola_payment_from_checkout_response(cart_token, checkout_response)

      order_confirmation_url = checkout_response["order"]["order_confirmation_url"]
      redirect_to order_confirmation_url, allow_other_host: true
    else
      cart_token = success_params[:cart_token]
      fluid_checkout_url = "#{ENV['CHECKOUT_HOST_URL']}/checkouts/#{cart_token}"
      redirect_to fluid_checkout_url, allow_other_host: true
    end
  end

private

  def external_id
    Rails.logger.info("CheckoutCallbackController external_id")
    Rails.logger.info("external_id: #{callback_params.inspect}")
    if callback_params[:customer].present? && callback_params[:customer][:external_id].present?
      "C#{callback_params[:customer][:external_id]}" # C prefix for customers
    elsif callback_params[:user_company].present? && callback_params[:user_company][:external_id].present?
      "R#{callback_params[:user_company][:external_id]}" # R prefix for representatives/distributors
    end
  end

  # def no_prefix_external_id
  #   Rails.logger.info("CheckoutCallbackController no_prefix_external_id")
  #   Rails.logger.info("no_prefix_external_id: #{callback_params.inspect}")
  #   if callback_params[:customer].present? && callback_params[:customer][:external_id].present?
  #     callback_params[:customer][:external_id]
  #   elsif callback_params[:user_company].present? && callback_params[:user_company][:external_id].present?
  #     callback_params[:user_company][:external_id]
  #   end
  # end

  def callback_params
    params.permit(
      :payment_account_id,
      :attributable_rep_id,
      customer: {},
      user_company: {},
      cart: [
        :cart_token,
        :amount_total,
        :tax_total,
        :currency_code,
        :language_iso,
        :recurring,
        :email,
        ship_to: %i[
          first_name
          last_name
          address1
          address2
          city
          state
          postal_code
          country_code
          email
          name
        ],
        items: [
          :product_title,
          :quantity,
          :price,
          { product: [ :sku ] },
        ],
      ],
      attribution: %i[name email external_id share_guid]
    )
  end

  def success_params
    params.permit(:cart_token, :payment_account_id, :status)
  end

  def extract_status
    # First try to get status as a separate parameter
    return success_params[:status] if success_params[:status].present?

    # If not found, check if it's concatenated in payment_account_id
    payment_account_id_param = params[:payment_account_id] || params["payment_account_id"]
    if payment_account_id_param.present? && payment_account_id_param.include?("&status=")
      # Extract status from payment_account_id (e.g., "223&status=SUCCESS")
      match = payment_account_id_param.match(/&status=([^&]+)/)
      return match[1] if match
    end

    nil
  end

  def extract_payment_account_id
    payment_account_id_param = params[:payment_account_id] || params["payment_account_id"]
    return nil unless payment_account_id_param.present?

    # If payment_account_id contains &status=, extract just the ID part
    if payment_account_id_param.include?("&status=")
      # Extract just the ID part before &status=
      payment_account_id_param.split("&status=").first
    else
      payment_account_id_param
    end
  end

  def cart_payload
    callback_params[:cart]
  end

  def fluid_client
    @fluid_client ||= FluidClient.new
  end

  def customer_payload
    {
      first_name: cart_payload.dig(:ship_to, :first_name),
      last_name: cart_payload.dig(:ship_to, :last_name),
      email: cart_payload.dig(:email),
      notes: "Created by NewULife Payment Redirect Droplet",
      default_address_attributes: {
        address1: cart_payload.dig(:ship_to, :address1),
        address2: cart_payload.dig(:ship_to, :address2),
        city: cart_payload.dig(:ship_to, :city),
        state: cart_payload.dig(:ship_to, :state),
        postal_code: cart_payload.dig(:ship_to, :postal_code),
        country_code: cart_payload.dig(:ship_to, :country_code),
        default: true,
      },
      customer_notes_attributes: [
        {
          note: "Created by NewULife Payment Redirect Droplet",
        },
      ],
    }
  end

  # Extract ByDesign OrderID from Fluid checkout response (order.external_id).
  # Used when we want to set it immediately from checkout response instead of waiting for order.external_id_updated webhook.
  def bydesign_order_id_from_checkout_response(checkout_response)
    order_data = checkout_response.is_a?(Hash) ? checkout_response["order"] : nil
    return nil if order_data.blank?

    value = order_data["external_id"] || order_data[:external_id]
    value.present? ? value.to_s : nil
  end

  # Update MoolaPayment with ByDesign OrderID (and Fluid order id) from checkout response when present.
  # Enqueues ByDesignPaymentRecordingJob if the payment becomes ready_to_record?
  def update_moola_payment_from_checkout_response(cart_token, checkout_response)
    bydesign_order_id = bydesign_order_id_from_checkout_response(checkout_response)
    return if bydesign_order_id.blank?

    moola_payment = MoolaPayment.find_by(cart_token: cart_token)
    unless moola_payment
      # Create placeholder so when Moola P2M arrives we can match by cart_token (FluidOrderExternalIdUpdatedJob will also create/update)
      moola_payment = MoolaPayment.create!(
        cart_token: cart_token,
        invoice_number: MoolaPayment.format_invoice_number(cart_token),
        bydesign_order_id: bydesign_order_id,
        fluid_order_id: checkout_response.dig("order", "id") || checkout_response.dig("order", "order_id"),
        fluid_webhook_payload: checkout_response,
        status: :pending,
      )
      Rails.logger.info("[CheckoutCallback] Created MoolaPayment placeholder cart_token=#{cart_token} bydesign_order_id=#{bydesign_order_id}")
      return
    end

    moola_payment.assign_attributes(
      bydesign_order_id: bydesign_order_id,
      fluid_order_id: checkout_response.dig("order", "id") ||
                      checkout_response.dig("order", "order_id") ||
                      moola_payment.fluid_order_id,
      fluid_webhook_payload: checkout_response,
    )
    moola_payment.status = moola_payment.determine_status
    moola_payment.matched_at = Time.current if moola_payment.matched? && moola_payment.matched_at.blank?
    moola_payment.save!

    if moola_payment.ready_to_record?
      ByDesignPaymentRecordingJob.perform_later(moola_payment.id)
      Rails.logger.info("[CheckoutCallback] Enqueued ByDesignPaymentRecordingJob for MoolaPayment id=#{moola_payment.id}")
    end
  end
end
