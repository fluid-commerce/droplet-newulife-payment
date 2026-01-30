class FluidOrderExternalIdUpdatedJob < WebhookEventJob
  # Inherits retry behavior from WebhookEventJob

  def process_webhook
    Rails.logger.info("[FluidOrderExternalIdUpdatedJob] Processing external_id update")

    # Extract order data from payload
    order_data = get_payload.dig("order") || get_payload

    cart_token = order_data["cart_token"]
    external_id = order_data["external_id"]  # ByDesign OrderID
    fluid_order_id = order_data["id"] || order_data["order_id"]

    unless cart_token.present? && external_id.present?
      Rails.logger.warn("[FluidOrderExternalIdUpdatedJob] Missing cart_token or external_id: " \
                        "cart_token=#{cart_token}, external_id=#{external_id}")
      return
    end

    Rails.logger.info("[FluidOrderExternalIdUpdatedJob] cart_token=#{cart_token}, external_id=#{external_id}")

    # Find the Moola payment record
    moola_payment = MoolaPayment.find_by(cart_token: cart_token)

    unless moola_payment
      # Create a placeholder if Moola webhook hasn't arrived yet
      moola_payment = MoolaPayment.create!(
        cart_token: cart_token,
        invoice_number: MoolaPayment.format_invoice_number(cart_token),
        fluid_order_id: fluid_order_id,
        bydesign_order_id: external_id,
        fluid_webhook_payload: get_payload,
        status: :pending
      )
      Rails.logger.info("[FluidOrderExternalIdUpdatedJob] Created placeholder payment record")
      return
    end

    # Update with Fluid order data
    moola_payment.assign_attributes(
      fluid_order_id: fluid_order_id,
      bydesign_order_id: external_id,
      fluid_webhook_payload: get_payload
    )

    # Use model's determine_status to handle race conditions correctly
    moola_payment.status = moola_payment.determine_status

    # Set matched_at timestamp if transitioning to matched
    moola_payment.matched_at = Time.current if moola_payment.matched? && moola_payment.matched_at.blank?

    moola_payment.save!

    # Trigger ByDesign recording if ready
    if moola_payment.ready_to_record?
      ByDesignPaymentRecordingJob.perform_later(moola_payment.id)
    end

    Rails.logger.info("[FluidOrderExternalIdUpdatedJob] Updated payment: status=#{moola_payment.status}")
  end
end
