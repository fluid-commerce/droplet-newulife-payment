class ByDesignPaymentRecordingJob < ApplicationJob
  queue_as :bydesign_payments

  retry_on StandardError, attempts: 5, wait: :polynomially_longer
  discard_on ActiveRecord::RecordNotFound

  def perform(moola_payment_id)
    @moola_payment = MoolaPayment.find(moola_payment_id)

    Rails.logger.info("[ByDesignPaymentRecordingJob] Recording payment: #{@moola_payment.cart_token}, " \
                      "OrderID=#{@moola_payment.bydesign_order_id}")

    # Use database lock to prevent race conditions with duplicate webhooks
    # This ensures only one job can claim and process this payment
    unless claim_for_recording
      Rails.logger.info("[ByDesignPaymentRecordingJob] Payment already processing or not ready: status=#{@moola_payment.status}")
      return
    end

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

  # Atomically claim this payment for recording using database lock
  # Returns true if successfully claimed, false if already processing or not ready
  #
  # Accepts :recording status (set by update_status_and_enqueue_if_ready!)
  # or :matched status (legacy path / retry after failure sets back to matched)
  def claim_for_recording
    claimed = false

    @moola_payment.with_lock do
      if @moola_payment.recording? || @moola_payment.matched?
        @moola_payment.update!(status: :recording) unless @moola_payment.recording?
        claimed = true
      end
    end

    claimed
  end

  def record_payments_to_bydesign
    # Use unrecorded_payment_details to avoid re-recording payments that succeeded
    # on a previous attempt (prevents duplicates on partial failure retry)
    recordable_payments = @moola_payment.unrecorded_payment_details.reject do |pd|
      ByDesignPaymentService.should_skip_payment?(pd)
    end

    if recordable_payments.empty?
      Rails.logger.info("[ByDesignPaymentRecordingJob] No recordable payments (all recorded or declined)")
      return [ { payment_id: nil, success: true, skipped: true } ]
    end

    # Extract P2M webhook data for API field mapping
    p2m_data = build_p2m_data

    # Extract billing address from Fluid webhook payload
    billing_address = build_billing_address

    recordable_payments.map do |payment_detail|
      result = ByDesignPaymentService.record_payment(
        order_id: @moola_payment.bydesign_order_id,
        payment_detail: payment_detail,
        p2m_data: p2m_data,
        card_details: @moola_payment.card_details,
        billing_address: billing_address,
        kyc_status: @moola_payment.kyc_status
      )

      Rails.logger.info("[ByDesignPaymentRecordingJob] Payment #{payment_detail['id']}: " \
                        "success=#{result[:success]}, skipped=#{result[:skipped]}, error=#{result[:error]}")

      # Mark as recorded immediately on success to prevent duplicates on retry
      if result[:success] && !result[:skipped]
        @moola_payment.mark_payment_detail_recorded!(payment_detail["id"])
      end

      {
        payment_id: payment_detail["id"],
        success: result[:success],
        skipped: result[:skipped],
        response: result[:response],
        error: result[:error],
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
      "completed_at" => payload["completed_at"],
      "from_account_name" => payload["from_account_name"],
    }
  end

  # Build billing address hash from Fluid webhook payload
  # Uses ship_to address from the Fluid order as billing address
  def build_billing_address
    fluid_payload = @moola_payment.fluid_webhook_payload || {}
    order_data = fluid_payload["order"] || fluid_payload

    # Try ship_to first (preferred), then shipping_address as fallback
    address = order_data["ship_to"] || order_data["shipping_address"] || {}

    {
      "name" => address["name"],
      "first_name" => address["first_name"] || order_data["first_name"],
      "last_name" => address["last_name"] || order_data["last_name"],
      "address1" => address["address1"],
      "address2" => address["address2"],
      "city" => address["city"],
      "state" => address["state"],
      "subdivision_code" => address["subdivision_code"],
      "country_code" => address["country_code"],
      "postal_code" => address["postal_code"],
    }
  end

  def handle_recording_failure(results)
    @moola_payment.increment_recording_attempt!

    failed_payments = results.reject { |r| r[:success] }
    error_message = failed_payments.map { |r| "#{r[:payment_id]}: #{r[:error]}" }.join("; ")

    if @moola_payment.max_attempts_reached?
      @moola_payment.update!(last_error: error_message, status: :failed)
      Rails.logger.error("[ByDesignPaymentRecordingJob] Recording failed permanently: #{error_message}")
    else
      @moola_payment.update!(last_error: error_message, status: :matched)
      # Re-enqueue with delay to retry remaining unrecorded payments
      ByDesignPaymentRecordingJob.set(wait: MoolaPayment::RETRY_DELAY_MINUTES.minutes).perform_later(@moola_payment.id)
      Rails.logger.warn("[ByDesignPaymentRecordingJob] Recording failed, scheduled retry: #{error_message}")
    end
  end

  def handle_error(error)
    @moola_payment.increment_recording_attempt!

    if @moola_payment.max_attempts_reached?
      @moola_payment.update!(last_error: "#{error.class}: #{error.message}", status: :failed)
    else
      @moola_payment.update!(last_error: "#{error.class}: #{error.message}", status: :matched)
      # Re-enqueue with delay for retry
      ByDesignPaymentRecordingJob.set(wait: MoolaPayment::RETRY_DELAY_MINUTES.minutes).perform_later(@moola_payment.id)
    end
  end
end
