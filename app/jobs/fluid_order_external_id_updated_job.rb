class FluidOrderExternalIdUpdatedJob < WebhookEventJob
  # Inherits retry behavior from WebhookEventJob

  def process_webhook
    Rails.logger.info("[FluidOrderExternalIdUpdatedJob] Processing order update")

    # Extract order data from payload
    # Handle both root-level order and nested under "payload" key
    order_data = get_payload.dig("order") || get_payload.dig("payload", "order") || get_payload

    cart_token = order_data["cart_token"]
    external_id = order_data["external_id"]  # ByDesign OrderID
    fluid_order_id = order_data["id"] || order_data["order_id"]
    # Normalize to string for consistent database lookups (column is string type)
    fluid_order_id = fluid_order_id.to_s if fluid_order_id.present?

    # external_id is required - this is the ByDesign Order ID we need
    unless external_id.present?
      Rails.logger.info("[FluidOrderExternalIdUpdatedJob] No external_id in payload, skipping (order not yet synced to ByDesign)")
      return
    end

    Rails.logger.info("[FluidOrderExternalIdUpdatedJob] fluid_order_id=#{fluid_order_id}, external_id=#{external_id}, cart_token=#{cart_token || 'not provided'}")

    # Find the Moola payment record
    # Try cart_token first (if provided), then fall back to fluid_order_id
    moola_payment = if cart_token.present?
      MoolaPayment.find_by(cart_token: cart_token)
    else
      MoolaPayment.find_by(fluid_order_id: fluid_order_id)
    end

    unless moola_payment
      # No existing record found - this shouldn't happen if checkout callback ran correctly
      # Log warning but don't create a record without cart_token (we need it for Moola webhook matching)
      Rails.logger.warn("[FluidOrderExternalIdUpdatedJob] No MoolaPayment found for fluid_order_id=#{fluid_order_id}. " \
                        "Checkout callback may not have created the record.")
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
