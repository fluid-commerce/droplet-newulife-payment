class MoolaPayment < ApplicationRecord
  # Status enum for tracking payment lifecycle
  enum :status, {
    pending: 0,           # Waiting for both webhooks or KYC approval
    matched: 1,           # Both webhooks received, ready to record
    recording: 2,         # Currently recording to ByDesign
    recorded: 3,          # Successfully recorded in ByDesign
    failed: 4,            # Recording failed after max attempts
    kyc_pending: 5,       # KYC status is REVIEW
    kyc_declined: 6,       # KYC status is DECLINE
  }, default: :pending

  # Callbacks
  # Enqueue recording job after commit to ensure database changes are persisted
  # This prevents issues with nested transactions and rollbacks
  after_commit :enqueue_recording_job_if_just_claimed, on: :update

  # Validations
  validates :cart_token, presence: true, uniqueness: true
  validates :invoice_number, presence: true
  validates :status, presence: true

  # Scopes
  scope :awaiting_match, -> { where(status: :pending) }
  scope :ready_to_record, -> { where(status: :matched) }
  scope :failed_recordings, -> { where(status: :failed) }
  scope :stale, ->(hours = 24) { awaiting_match.where("created_at < ?", hours.hours.ago) }
  scope :stuck_in_recording, ->(minutes = 30) { where(status: :recording).where("updated_at < ?", minutes.minutes.ago) }

  # Constants
  MAX_RECORDING_ATTEMPTS = 5
  STALE_THRESHOLD_HOURS = 48
  INVOICE_NUMBER_PREFIX = "NULF-CT".freeze
  RETRY_DELAY_MINUTES = 5

  # Generate invoice number from cart token
  def self.format_invoice_number(cart_token)
    "#{INVOICE_NUMBER_PREFIX}:#{cart_token}"
  end

  # Extract cart_token from invoice_number format "NULF-CT:{cart_token}"
  def self.extract_cart_token(invoice_number)
    return nil unless invoice_number.present?

    match = invoice_number.match(/^#{Regexp.escape(INVOICE_NUMBER_PREFIX)}:(.+)$/)
    match ? match[1] : nil
  end

  # Determine the correct status based on current state
  # Call this after updating payment data to ensure status is correct
  def determine_status
    return :kyc_declined if kyc_status == "DECLINE"
    return :kyc_pending if kyc_status == "REVIEW"

    # If we have both Moola data and ByDesign order ID, and KYC is approved, we're matched
    if moola_data_present? && bydesign_order_id.present? && kyc_approved?
      :matched
    else
      :pending
    end
  end

  # Check if Moola webhook data has been received
  def moola_data_present?
    payment_details.present? && payment_details.any?
  end

  # Check if ready for ByDesign recording (requires matched status)
  def ready_to_record?
    matched? && data_ready_for_recording?
  end

  # Check if all data is present for recording (independent of status)
  # This is used in Phase 2 locking to avoid race conditions where
  # another thread's Phase 1 save overwrites the status
  def data_ready_for_recording?
    bydesign_order_id.present? && kyc_approved? && moola_data_present?
  end

  def kyc_approved?
    kyc_status == "APPROVE"
  end

  # Check if KYC status blocks recording
  def kyc_blocked?
    kyc_status == "DECLINE" || kyc_status == "REVIEW"
  end

  def total_amount
    payment_details.sum { |pd| pd["amount"].to_f }
  end

  def increment_recording_attempt!
    increment!(:bydesign_recording_attempts)
  end

  def max_attempts_reached?
    bydesign_recording_attempts >= MAX_RECORDING_ATTEMPTS
  end

  # Update status based on current state, save, and enqueue recording job if ready.
  # This consolidates the repeated pattern across controllers and jobs.
  #
  # Uses database locking to prevent race conditions when multiple webhooks
  # (Moola P2M and Fluid order) arrive simultaneously for the same payment.
  # Without locking, both could determine status as :matched and enqueue
  # duplicate ByDesignPaymentRecordingJob instances.
  #
  # The method works in two phases:
  # 1. Save all in-memory attribute changes (status, matched_at, etc.)
  # 2. Use pessimistic locking to atomically claim for recording
  #
  # Job enqueue happens via after_commit callback to ensure it only fires
  # after the transaction (including any outer transaction) commits.
  #
  # @return [Boolean] true if recording job will be enqueued (after commit)
  def update_status_and_enqueue_if_ready!
    # Phase 1: Save all attribute changes
    self.status = determine_status
    self.matched_at = Time.current if matched? && matched_at.blank?
    save!

    # Phase 2: Atomically claim for recording with pessimistic lock
    # Uses data_ready_for_recording? instead of ready_to_record? to avoid
    # race condition where another thread's Phase 1 overwrites status
    claimed = false
    self.class.transaction do
      locked_record = self.class.lock.find(id)

      # Skip if already processing or in a terminal state
      break if locked_record.recording? || locked_record.recorded? || locked_record.failed?

      # Skip if KYC is blocking
      break if locked_record.kyc_blocked?

      # Atomically transition to :recording if data is ready
      # Uses update! to trigger after_commit callback for job enqueue
      if locked_record.data_ready_for_recording?
        locked_record.update!(status: :recording)
        claimed = true
      end
    end

    claimed
  end

  # Mark a specific payment_detail as recorded to prevent duplicate recording on retry
  # @param payment_id [String] The payment_detail id that was successfully recorded
  def mark_payment_detail_recorded!(payment_id)
    return unless payment_details.present?

    updated_details = payment_details.map do |pd|
      if pd["id"] == payment_id && pd["recorded_at"].blank?
        pd.merge("recorded_at" => Time.current.iso8601)
      else
        pd
      end
    end

    update_columns(payment_details: updated_details)
  end

  # Get payment_details that haven't been recorded yet
  def unrecorded_payment_details
    return [] unless payment_details.present?

    payment_details.reject { |pd| pd["recorded_at"].present? }
  end

  # Check if all payment_details have been recorded
  def all_payments_recorded?
    return true unless payment_details.present?

    payment_details.all? { |pd| pd["recorded_at"].present? }
  end

private

  # Callback: Enqueue recording job after commit when status changes to :recording
  # This ensures the job is only enqueued after database changes are persisted,
  # preventing issues with nested transactions (like WebhookEventJob) and rollbacks
  def enqueue_recording_job_if_just_claimed
    return unless saved_change_to_status?
    return unless recording?

    ByDesignPaymentRecordingJob.perform_later(id)
  end
end
