class FluidOrderExternalIdUpdatedJob < WebhookEventJob
  # Inherits retry behavior from WebhookEventJob

  def process_webhook
    Rails.logger.info("[FluidOrderExternalIdUpdatedJob] Processing order.external_id_synced webhook")

    # Extract order data from payload
    # Expected structure: { "order": { ... } } or { "payload": { "order": { ... } } }
    order_data = get_payload.dig("order") || get_payload.dig("payload", "order")

    unless order_data
      Rails.logger.warn("[FluidOrderExternalIdUpdatedJob] Unexpected payload structure - missing 'order' key. " \
                        "Keys present: #{get_payload.keys.join(', ')}")
      return
    end

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

    # Find the Moola payment record by cart_token first, then fall back to fluid_order_id
    moola_payment = MoolaPayment.find_by(cart_token: cart_token) || MoolaPayment.find_by(fluid_order_id: fluid_order_id)

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

    # Update status and enqueue recording job if ready
    enqueued = moola_payment.update_status_and_enqueue_if_ready!

    Rails.logger.info("[FluidOrderExternalIdUpdatedJob] Updated payment: status=#{moola_payment.status}, recording_enqueued=#{enqueued}")
  end
end
