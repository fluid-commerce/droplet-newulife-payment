class CheckoutCallbackController < ApplicationController
  skip_before_action :verify_authenticity_token

  def get_redirect_url
    # upayments_external_id: prefixed ID for UPayments (C/R prefix)
    # fluid_external_id: raw ByDesign ID stored in Fluid (no prefix)
    upayments_external_id = upayments_prefixed_external_id
    fluid_external_id = raw_external_id

    user_check_response = UPaymentsUserApiClient.check_user_exists(
      email: callback_params[:cart][:email],
      external_id: upayments_external_id
    )

    user = user_check_response

    if user_check_response.dig("status")&.zero?
      # Create consumer in ByDesign
      sponsor_rep_id = callback_params[:attribution]&.dig(:external_id) || "1"
      by_design_consumer = ByDesign.create_consumer(
        cart: cart_payload,
        sponsor_rep_id: sponsor_rep_id
      )

      by_design_successful = by_design_consumer.dig("Result", "IsSuccessful")
      by_design_customer_id = by_design_consumer.dig("CustomerID")

      # Check if customer already exists in Fluid
      fluid_customer = fluid_client.get("/api/customers?search_query=#{customer_payload.dig(:email)}&page=1&per_page=1")

      if fluid_customer["customers"].present?
        # Customer already exists in Fluid, use their external_id
        fluid_external_id = fluid_customer["customers"].first["external_id"]
        upayments_external_id = upayments_prefix_for(fluid_external_id)
      elsif by_design_successful && by_design_customer_id.present?
        # ByDesign succeeded, create new Fluid customer with raw ByDesign ID
        fluid_external_id = by_design_customer_id.to_s
        upayments_external_id = "C#{fluid_external_id}"
        begin
          fluid_client.post("/api/customers", body: customer_payload.merge(external_id: fluid_external_id))
        rescue FluidClient::Error => e
          Rails.logger.error("Fluid customer creation failed for external_id=#{fluid_external_id}: #{e.message}")
          return render json: { redirect_url: nil, error_message: "Failed to create customer in Fluid" }
        end
      else
        # ByDesign failed and no existing Fluid customer - cannot proceed
        error_message = by_design_consumer.dig("Result", "Message") || "Failed to create customer in ByDesign"
        Rails.logger.error("ByDesign customer creation failed and no existing Fluid customer: #{error_message}")
        return render json: { redirect_url: nil, error_message: error_message }
      end

      # Create consumer in UPayments (skip if paying on behalf of another user)
      unless order_on_behalf_of?
        user_payload = UPaymentsConsumerPayloadGenerator.generate_consumer_payload(
          cart: cart_payload,
          external_id: upayments_external_id
        )
        user_onboard_response = UPaymentsUserApiClient.onboard_consumer(payload: user_payload)
        if user_onboard_response.dig("status")&.zero?
          error_message = user_onboard_response.dig("error", "message")
          return render json: { redirect_url: nil, error_message: error_message }
        end
        user = user_onboard_response
      end
    end

    # For order on behalf of, validate the payer and use their wallet UUID and external_id
    if order_on_behalf_of?
      login_uuid = payer_wallet_uuid
      payer_upayments_external_id = payer_metadata_external_id

      # Validate payer exists in UPayments
      payer_check = UPaymentsUserApiClient.check_user_exists(
        email: callback_params[:cart][:email],
        external_id: payer_upayments_external_id
      )
      if payer_check.dig("status")&.zero?
        Rails.logger.error("CheckoutCallbackController payer not found in UPayments: external_id=#{payer_upayments_external_id}, payer_wallet_uuid=#{login_uuid}")
        return render json: { redirect_url: nil, error_message: "Payer account not found" }
      end

      Rails.logger.info("CheckoutCallbackController order on behalf of: payer_external_id=#{payer_upayments_external_id}, payer_wallet_uuid=#{login_uuid}")
    else
      login_uuid = user.dig("data", "uuid")
      payer_upayments_external_id = upayments_external_id
    end

    order_payload = UPaymentsOrderPayloadGenerator.generate_order_payload(
      cart: cart_payload,
      external_id: payer_upayments_external_id,
      payment_account_id: callback_params[:payment_account_id],
      login_uuid: login_uuid
    )
    Rails.logger.info("CheckoutCallbackController order_payload #{order_payload.inspect}")

    redirect_url_response = UPaymentsCheckoutApiClient.create_order(payload: order_payload)

    Rails.logger.info("CheckoutCallbackController redirect_url_response #{redirect_url_response.inspect}")
    if redirect_url_response.dig("status")&.zero?
      error_message = redirect_url_response.dig("error", "message")

      Rails.logger.info("CheckoutCallbackController error_message #{error_message.inspect}")
      return render json: { redirect_url: nil, error_message: error_message }
    end

    redirect_url = redirect_url_response.dig("data", "redirectUrl")

    Rails.logger.info("Final Step redirect_url #{redirect_url}")

    render json: { redirect_url: redirect_url }
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
      begin
        payment_response = fluid_client.post("/api/v202506/payments/#{payment_account_id}", body: payment_payload)
        payment_uuid = payment_response["payment"]["uuid"]

        Rails.logger.info("payment_response #{payment_response.inspect}")
        Rails.logger.info("payment_response['payment']['uuid'] #{payment_response['payment']['uuid']}")

        # Call the fluid checkout api to create the order
        checkout_response = fluid_client.post("/api/carts/#{cart_token}/checkout?payment_uuid=#{payment_uuid}")

        Rails.logger.info("Final Step checkout_response #{checkout_response.inspect}")
        Rails.logger.info("Final Step checkout_response['order']['order_confirmation_url'] #{checkout_response['order']['order_confirmation_url']}")

        # Always create/update MoolaPayment to link cart_token with fluid_order_id
        # This ensures the record exists when the order.external_id_synced webhook arrives
        ensure_moola_payment_link(cart_token, checkout_response)

        order_confirmation_url = checkout_response["order"]["order_confirmation_url"]
        redirect_to order_confirmation_url, allow_other_host: true
      rescue FluidClient::Error => e
        Rails.logger.error("Fluid API error during checkout success for cart_token=#{cart_token}: #{e.message}")
        fluid_checkout_url = "#{ENV['CHECKOUT_HOST_URL']}/checkouts/#{cart_token}"
        redirect_to fluid_checkout_url, allow_other_host: true
      end
    else
      cart_token = success_params[:cart_token]
      fluid_checkout_url = "#{ENV['CHECKOUT_HOST_URL']}/checkouts/#{cart_token}"
      redirect_to fluid_checkout_url, allow_other_host: true
    end
  end

private

  # Raw external_id from Fluid (no prefix) — this is what gets stored in Fluid
  def raw_external_id
    if callback_params[:customer].present? && callback_params[:customer][:external_id].present?
      callback_params[:customer][:external_id].to_s
    elsif callback_params[:user_company].present? && callback_params[:user_company][:external_id].present?
      callback_params[:user_company][:external_id].to_s
    end
  end

  # Prefixed external_id for UPayments — C for customers, R for reps
  def upayments_prefixed_external_id
    if callback_params[:customer].present? && callback_params[:customer][:external_id].present?
      "C#{callback_params[:customer][:external_id]}"
    elsif callback_params[:user_company].present? && callback_params[:user_company][:external_id].present?
      "R#{callback_params[:user_company][:external_id]}"
    end
  end

  # Add UPayments prefix to a Fluid external_id based on whether it looks like a rep or customer
  def upayments_prefix_for(fluid_external_id)
    return fluid_external_id if fluid_external_id.blank?
    return fluid_external_id if fluid_external_id.start_with?("C", "R")

    if callback_params[:user_company].present?
      "R#{fluid_external_id}"
    else
      "C#{fluid_external_id}"
    end
  end

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
        metadata: %i[payer_wallet_uuid external_id],
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

  def cart_metadata
    @cart_metadata ||= cart_payload[:metadata] || {}
  end

  def payer_wallet_uuid
    cart_metadata.dig("payer_wallet_uuid") || cart_metadata.dig(:payer_wallet_uuid)
  end

  def payer_metadata_external_id
    cart_metadata.dig("external_id") || cart_metadata.dig(:external_id)
  end

  def order_on_behalf_of?
    payer_wallet_uuid.present? && payer_metadata_external_id.present?
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
  def bydesign_order_id_from_checkout_response(checkout_response)
    order_data = checkout_response.is_a?(Hash) ? checkout_response["order"] : nil
    return nil if order_data.blank?

    value = order_data["external_id"] || order_data[:external_id]
    value.present? ? value.to_s : nil
  end

  # Always create or update MoolaPayment to link cart_token with fluid_order_id.
  # This ensures the record exists when the order.external_id_synced webhook arrives.
  # Also sets bydesign_order_id if present in checkout response (fallback path).
  def ensure_moola_payment_link(cart_token, checkout_response)
    fluid_order_id = checkout_response.dig("order", "id") || checkout_response.dig("order", "order_id")
    # Normalize to string for consistent database lookups (column is string type)
    fluid_order_id = fluid_order_id.to_s if fluid_order_id.present?
    bydesign_order_id = bydesign_order_id_from_checkout_response(checkout_response)

    moola_payment = MoolaPayment.find_by(cart_token: cart_token)

    if moola_payment
      # Update existing record with fluid_order_id and bydesign_order_id if available
      moola_payment.assign_attributes(
        fluid_order_id: fluid_order_id || moola_payment.fluid_order_id,
        bydesign_order_id: bydesign_order_id || moola_payment.bydesign_order_id,
        fluid_webhook_payload: checkout_response
      )
      enqueued = moola_payment.update_status_and_enqueue_if_ready!
      Rails.logger.info("[CheckoutCallback] Updated MoolaPayment id=#{moola_payment.id} with fluid_order_id=#{fluid_order_id}, recording_enqueued=#{enqueued}")
    else
      # Create new record linking cart_token to fluid_order_id
      moola_payment = MoolaPayment.create!(
        cart_token: cart_token,
        invoice_number: MoolaPayment.format_invoice_number(cart_token),
        fluid_order_id: fluid_order_id,
        bydesign_order_id: bydesign_order_id,
        fluid_webhook_payload: checkout_response,
        status: :pending
      )
      Rails.logger.info("[CheckoutCallback] Created MoolaPayment id=#{moola_payment.id} cart_token=#{cart_token} fluid_order_id=#{fluid_order_id}")

      # Use consistent locking mechanism for enqueue decision
      # (e.g., if Moola webhook arrived before checkout completed)
      enqueued = moola_payment.update_status_and_enqueue_if_ready!
      Rails.logger.info("[CheckoutCallback] Checked for recording: enqueued=#{enqueued}")
    end
  end
end
