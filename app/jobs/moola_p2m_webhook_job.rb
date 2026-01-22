class MoolaP2mWebhookJob < ApplicationJob
  queue_as :moola_webhooks

  retry_on StandardError, attempts: 3, wait: :polynomially_longer

  def perform(payload)
    @payload = ActiveSupport::HashWithIndifferentAccess.new(payload)

    Rails.logger.info("[MoolaP2mWebhookJob] Processing: invoice=#{invoice_number}, type=#{transaction_type}")

    # Validate this is a P2M transaction
    unless valid_p2m_transaction?
      Rails.logger.warn("[MoolaP2mWebhookJob] Skipping non-P2M transaction: #{transaction_type}")
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

    # Update with Moola data
    update_payment_record(moola_payment)

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

  def valid_p2m_transaction?
    @payload[:type] == "transaction" && transaction_type == "p2m"
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
          "currency" => pd[:currency] || pd["currency"]
        }.compact
      end
  end

  def declined_payment?(payment_detail)
    status = payment_detail[:status] || payment_detail["status"]
    status == "Declined"
  end
end
