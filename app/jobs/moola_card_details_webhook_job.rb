class MoolaCardDetailsWebhookJob < ApplicationJob
  queue_as :moola_webhooks

  retry_on StandardError, attempts: 3, wait: :polynomially_longer

  def perform(payload)
    @payload = ActiveSupport::HashWithIndifferentAccess.new(payload)

    Rails.logger.info("[MoolaCardDetailsWebhookJob] Processing card details")

    # Find the payment record by transaction ID
    transaction_id = @payload[:transaction_id] || @payload[:id]
    moola_payment = MoolaPayment.find_by(moola_transaction_id: transaction_id)

    unless moola_payment
      # Try to find by matching payment detail ID
      moola_payment = find_by_payment_detail_id(transaction_id)
    end

    unless moola_payment
      Rails.logger.warn("[MoolaCardDetailsWebhookJob] No payment found for transaction: #{transaction_id}")
      return
    end

    # Update card details
    moola_payment.update!(
      card_details: extract_card_details
    )

    Rails.logger.info("[MoolaCardDetailsWebhookJob] Updated card details for: #{moola_payment.cart_token}")
  end

private

  def extract_card_details
    {
      "last4" => @payload[:card_number_last4] || @payload[:last4] || @payload.dig(:card, :last4),
      "expiry_date" => @payload[:expiry_date] || @payload.dig(:card, :expiry_date),
      "expiry_month" => @payload[:expiry_month] || @payload.dig(:card, :expiry_month),
      "expiry_year" => @payload[:expiry_year] || @payload.dig(:card, :expiry_year),
      "card_type" => @payload[:card_type] || @payload.dig(:card, :type),
      "brand" => @payload[:brand] || @payload.dig(:card, :brand),
      "payment_instrument_uuid" => @payload[:payment_instrument_uuid]
    }.compact
  end

  def find_by_payment_detail_id(transaction_id)
    # Search for payments where payment_details contains this transaction ID
    MoolaPayment.where("payment_details @> ?", [{ "id" => transaction_id }].to_json).first
  end
end
