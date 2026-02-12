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

  # Validations
  validates :cart_token, presence: true, uniqueness: true
  validates :invoice_number, presence: true
  validates :status, presence: true

  # Scopes
  scope :awaiting_match, -> { where(status: :pending) }
  scope :ready_to_record, -> { where(status: :matched) }
  scope :failed_recordings, -> { where(status: :failed) }
  scope :stale, ->(hours = 24) { awaiting_match.where("created_at < ?", hours.hours.ago) }

  # Constants
  MAX_RECORDING_ATTEMPTS = 5
  STALE_THRESHOLD_HOURS = 48
  INVOICE_NUMBER_PREFIX = "NULF-CT".freeze

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

  # Check if ready for ByDesign recording
  def ready_to_record?
    matched? && bydesign_order_id.present? && kyc_approved? && moola_data_present?
  end

  def kyc_approved?
    kyc_status == "APPROVE"
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
  # 2. Use pessimistic locking to atomically check and enqueue
  #
  # @return [Boolean] true if recording job was enqueued
  def update_status_and_enqueue_if_ready!
    # Phase 1: Save all attribute changes
    self.status = determine_status
    self.matched_at = Time.current if matched? && matched_at.blank?
    save!

    # Phase 2: Atomically check and enqueue with pessimistic lock
    # This prevents duplicate job enqueues when concurrent webhooks race
    self.class.transaction do
      locked_record = self.class.lock.find(id)

      # Skip if already processing or in a terminal state
      return false if locked_record.recording? || locked_record.recorded? || locked_record.failed?

      # Only enqueue if the saved state is ready for recording
      if locked_record.ready_to_record?
        ByDesignPaymentRecordingJob.perform_later(id)
        return true
      end
    end
    false
  end
end
