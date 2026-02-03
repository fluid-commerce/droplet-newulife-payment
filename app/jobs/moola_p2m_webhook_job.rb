class MoolaP2mWebhookJob < ApplicationJob
  queue_as :moola_webhooks

  retry_on StandardError, attempts: 3, wait: :polynomially_longer

  # Supported transaction types from Moola webhooks
  TRANSACTION_TYPE_P2M = "p2m".freeze
  TRANSACTION_TYPE_CARD = "load_funds_via_card".freeze

  def perform(payload)
    @payload = ActiveSupport::HashWithIndifferentAccess.new(payload)

    Rails.logger.info("[MoolaP2mWebhookJob] Processing: invoice=#{invoice_number}, type=#{transaction_type}")

    # Validate this is a supported transaction type
    unless valid_transaction?
      Rails.logger.warn("[MoolaP2mWebhookJob] Skipping unsupported transaction type: #{transaction_type}")
      return
    end

    # Extract cart_token from invoice_number
    cart_token = MoolaPayment.extract_cart_token(invoice_number)
    unless cart_token.present?
      Rails.logger.error("[MoolaP2mWebhookJob] Invalid invoice_number format: #{invoice_number}")
      return
    end

    # Find or create payment record
    moola_payment = find_or_create_payment(cart_token)

    # Process based on transaction type
    if card_details_transaction?
      update_card_details(moola_payment)
    else
      update_payment_record(moola_payment)
    end

    # Check if we can proceed to recording (if Fluid webhook already arrived)
    if moola_payment.ready_to_record?
      ByDesignPaymentRecordingJob.perform_later(moola_payment.id)
    end

    Rails.logger.info("[MoolaP2mWebhookJob] Completed: cart_token=#{cart_token}, status=#{moola_payment.status}")
  end

private

  def invoice_number
    @payload[:invoice_number]
  end

  def transaction_type
    @payload[:transaction_type]
  end

  def kyc_status
    @payload[:kycStatus] || @payload[:kyc_status]
  end

  def payment_details
    @payload[:payment_details] || []
  end

  def valid_transaction?
    @payload[:type] == "transaction" && (p2m_transaction? || card_details_transaction?)
  end

  def p2m_transaction?
    transaction_type == TRANSACTION_TYPE_P2M
  end

  def card_details_transaction?
    transaction_type == TRANSACTION_TYPE_CARD
  end

  def find_or_create_payment(cart_token)
    MoolaPayment.find_or_initialize_by(cart_token: cart_token).tap do |payment|
      # Always set invoice_number from the actual webhook if not set
      payment.invoice_number = invoice_number if payment.invoice_number.blank?
    end
  end

  def update_payment_record(payment)
    payment.assign_attributes(
      moola_transaction_id: @payload[:transaction_id] || @payload[:id],
      kyc_status: kyc_status,
      transaction_type: transaction_type,
      payment_details: normalize_payment_details,
      moola_webhook_payload: @payload
    )

    # Use model's determine_status to handle race conditions correctly
    payment.status = payment.determine_status

    # Set matched_at timestamp if transitioning to matched
    payment.matched_at = Time.current if payment.matched? && payment.matched_at.blank?

    payment.save!
  end

  # Update card details from load_funds_via_card webhook
  # These webhooks contain: card_number_last4, expiry_date, payment_instrument_uuid
  def update_card_details(payment)
    card_details = extract_card_details
    return if card_details.empty?

    Rails.logger.info("[MoolaP2mWebhookJob] Updating card details for cart_token=#{payment.cart_token}")

    # Merge with existing card details (in case of multiple card payments)
    existing_details = payment.card_details || {}
    payment.card_details = existing_details.merge(card_details)

    # Also update KYC status if present (it's included in card webhooks too)
    payment.kyc_status = kyc_status if kyc_status.present? && payment.kyc_status.blank?

    # Re-evaluate status after updating card details
    payment.status = payment.determine_status
    payment.matched_at = Time.current if payment.matched? && payment.matched_at.blank?

    payment.save!
  end

  def extract_card_details
    {
      "card_number_last4" => @payload[:card_number_last4],
      "expiry_date" => @payload[:expiry_date],
      "payment_instrument_uuid" => @payload[:payment_instrument_uuid],
      "transaction_id" => @payload[:id],
      "parent_reference" => @payload[:parent_reference],
    }.compact
  end

  def normalize_payment_details
    # Filter out declined payments and normalize the remaining ones
    payment_details
      .reject { |pd| declined_payment?(pd) }
      .map do |pd|
        {
          "type" => pd[:type] || pd["type"],
          "amount" => pd[:amount] || pd["amount"],
          "id" => pd[:id] || pd["id"],
          "status" => pd[:status] || pd["status"],
          "currency" => pd[:currency] || pd["currency"],
          "order_reference" => pd[:order_reference] || pd["order_reference"],
        }.compact
      end
  end

  def declined_payment?(payment_detail)
    status = payment_detail[:status] || payment_detail["status"]
    status == "Declined"
  end
end
