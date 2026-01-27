class ByDesignPaymentRecordingJob < ApplicationJob
  queue_as :bydesign_payments

  retry_on StandardError, attempts: 5, wait: :polynomially_longer
  discard_on ActiveRecord::RecordNotFound

  def perform(moola_payment_id)
    @moola_payment = MoolaPayment.find(moola_payment_id)

    Rails.logger.info("[ByDesignPaymentRecordingJob] Recording payment: #{@moola_payment.cart_token}, " \
                      "OrderID=#{@moola_payment.bydesign_order_id}")

    # Validate state
    unless @moola_payment.ready_to_record? || @moola_payment.matched?
      Rails.logger.warn("[ByDesignPaymentRecordingJob] Payment not ready: status=#{@moola_payment.status}")
      return
    end

    # Mark as recording
    @moola_payment.update!(status: :recording)

    # Record each payment detail to ByDesign
    results = record_payments_to_bydesign

    # Check results
    if results.all? { |r| r[:success] }
      @moola_payment.update!(
        status: :recorded,
        recorded_at: Time.current
      )
      Rails.logger.info("[ByDesignPaymentRecordingJob] Successfully recorded all payments")
    else
      handle_recording_failure(results)
    end
  rescue StandardError => e
    handle_error(e)
    raise # Re-raise for retry
  end

private

  def record_payments_to_bydesign
    # Filter out any declined payments that might have slipped through
    recordable_payments = @moola_payment.payment_details.reject do |pd|
      ByDesignPaymentService.should_skip_payment?(pd)
    end

    if recordable_payments.empty?
      Rails.logger.info("[ByDesignPaymentRecordingJob] No recordable payments (all declined)")
      return [{ payment_id: nil, success: true, skipped: true }]
    end

    # Extract P2M webhook data for API field mapping
    p2m_data = build_p2m_data

    recordable_payments.map do |payment_detail|
      result = ByDesignPaymentService.record_payment(
        order_id: @moola_payment.bydesign_order_id,
        payment_detail: payment_detail,
        p2m_data: p2m_data,
        card_details: @moola_payment.card_details,
        kyc_status: @moola_payment.kyc_status
      )

      Rails.logger.info("[ByDesignPaymentRecordingJob] Payment #{payment_detail['id']}: " \
                        "success=#{result[:success]}, skipped=#{result[:skipped]}, error=#{result[:error]}")

      {
        payment_id: payment_detail["id"],
        success: result[:success],
        skipped: result[:skipped],
        response: result[:response],
        error: result[:error]
      }
    end
  end

  # Build P2M data hash from stored webhook payload
  # Per API docs, this includes: order_reference, client_uuid, invoice_number, autoship_reference, completed_at
  def build_p2m_data
    payload = @moola_payment.moola_webhook_payload || {}

    {
      "order_reference" => payload["order_reference"],
      "client_uuid" => payload["client_uuid"],
      "invoice_number" => @moola_payment.invoice_number,
      "autoship_reference" => payload["autoship_reference"],
      "completed_at" => payload["completed_at"]
    }
  end

  def handle_recording_failure(results)
    @moola_payment.increment_recording_attempt!

    failed_payments = results.reject { |r| r[:success] }
    error_message = failed_payments.map { |r| "#{r[:payment_id]}: #{r[:error]}" }.join("; ")

    @moola_payment.update!(
      last_error: error_message,
      status: @moola_payment.max_attempts_reached? ? :failed : :matched
    )

    Rails.logger.error("[ByDesignPaymentRecordingJob] Recording failed: #{error_message}")
  end

  def handle_error(error)
    @moola_payment.increment_recording_attempt!
    @moola_payment.update!(
      last_error: "#{error.class}: #{error.message}",
      status: @moola_payment.max_attempts_reached? ? :failed : :matched
    )
  end
end
