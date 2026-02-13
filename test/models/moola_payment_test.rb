require "test_helper"

describe MoolaPayment do
  describe "validations" do
    it "is valid with required attributes" do
      payment = MoolaPayment.new(
        cart_token: "test-cart-token",
        invoice_number: "NULF-CT:test-cart-token"
      )
      _(payment.valid?).must_equal true
    end

    it "is invalid without cart_token" do
      payment = MoolaPayment.new(
        invoice_number: "NULF-CT:test-cart-token"
      )
      _(payment.valid?).must_equal false
      _(payment.errors[:cart_token]).wont_be_empty
    end

    it "is invalid without invoice_number" do
      payment = MoolaPayment.new(
        cart_token: "test-cart-token"
      )
      _(payment.valid?).must_equal false
      _(payment.errors[:invoice_number]).wont_be_empty
    end

    it "requires unique cart_token" do
      MoolaPayment.create!(
        cart_token: "unique-token",
        invoice_number: "NULF-CT:unique-token"
      )
      payment = MoolaPayment.new(
        cart_token: "unique-token",
        invoice_number: "NULF-CT:unique-token-2"
      )
      _(payment.valid?).must_equal false
      _(payment.errors[:cart_token]).wont_be_empty
    end
  end

  describe "status enum" do
    it "has the correct status values" do
      _(MoolaPayment.statuses["pending"]).must_equal 0
      _(MoolaPayment.statuses["matched"]).must_equal 1
      _(MoolaPayment.statuses["recording"]).must_equal 2
      _(MoolaPayment.statuses["recorded"]).must_equal 3
      _(MoolaPayment.statuses["failed"]).must_equal 4
      _(MoolaPayment.statuses["kyc_pending"]).must_equal 5
      _(MoolaPayment.statuses["kyc_declined"]).must_equal 6
    end

    it "defaults to pending" do
      payment = MoolaPayment.new(
        cart_token: "test",
        invoice_number: "NULF-CT:test"
      )
      _(payment.status).must_equal "pending"
    end
  end

  describe ".extract_cart_token" do
    it "extracts cart_token from valid NULF-CT format" do
      result = MoolaPayment.extract_cart_token("NULF-CT:abc123")
      _(result).must_equal "abc123"
    end

    it "handles complex cart tokens" do
      result = MoolaPayment.extract_cart_token("NULF-CT:a1b2-c3d4-e5f6")
      _(result).must_equal "a1b2-c3d4-e5f6"
    end

    it "returns nil for invalid format" do
      _(MoolaPayment.extract_cart_token("invalid-format")).must_be_nil
      _(MoolaPayment.extract_cart_token("CT:abc123")).must_be_nil
      _(MoolaPayment.extract_cart_token("NULF:abc123")).must_be_nil
    end

    it "returns nil for empty or nil input" do
      _(MoolaPayment.extract_cart_token(nil)).must_be_nil
      _(MoolaPayment.extract_cart_token("")).must_be_nil
    end
  end

  describe ".format_invoice_number" do
    it "formats cart_token with NULF-CT prefix" do
      result = MoolaPayment.format_invoice_number("abc123")
      _(result).must_equal "NULF-CT:abc123"
    end
  end

  describe "#determine_status" do
    it "returns kyc_declined when KYC is DECLINE" do
      payment = MoolaPayment.new(
        cart_token: "test",
        invoice_number: "NULF-CT:test",
        kyc_status: "DECLINE",
        bydesign_order_id: "12345",
        payment_details: [ { "type" => "uwallet", "amount" => "100" } ]
      )
      _(payment.determine_status).must_equal :kyc_declined
    end

    it "returns kyc_pending when KYC is REVIEW" do
      payment = MoolaPayment.new(
        cart_token: "test",
        invoice_number: "NULF-CT:test",
        kyc_status: "REVIEW",
        bydesign_order_id: "12345",
        payment_details: [ { "type" => "uwallet", "amount" => "100" } ]
      )
      _(payment.determine_status).must_equal :kyc_pending
    end

    it "returns matched when KYC is APPROVE and both webhooks received" do
      payment = MoolaPayment.new(
        cart_token: "test",
        invoice_number: "NULF-CT:test",
        kyc_status: "APPROVE",
        bydesign_order_id: "12345",
        payment_details: [ { "type" => "uwallet", "amount" => "100" } ]
      )
      _(payment.determine_status).must_equal :matched
    end

    it "returns pending when missing bydesign_order_id" do
      payment = MoolaPayment.new(
        cart_token: "test",
        invoice_number: "NULF-CT:test",
        kyc_status: "APPROVE",
        payment_details: [ { "type" => "uwallet", "amount" => "100" } ]
      )
      _(payment.determine_status).must_equal :pending
    end

    it "returns pending when missing payment_details" do
      payment = MoolaPayment.new(
        cart_token: "test",
        invoice_number: "NULF-CT:test",
        kyc_status: "APPROVE",
        bydesign_order_id: "12345",
        payment_details: []
      )
      _(payment.determine_status).must_equal :pending
    end
  end

  describe "#ready_to_record?" do
    it "returns true when matched with all required data" do
      payment = MoolaPayment.new(
        cart_token: "test",
        invoice_number: "NULF-CT:test",
        kyc_status: "APPROVE",
        bydesign_order_id: "12345",
        payment_details: [ { "type" => "uwallet", "amount" => "100" } ],
        status: :matched
      )
      _(payment.ready_to_record?).must_equal true
    end

    it "returns false when not matched" do
      payment = MoolaPayment.new(
        cart_token: "test",
        invoice_number: "NULF-CT:test",
        kyc_status: "APPROVE",
        bydesign_order_id: "12345",
        payment_details: [ { "type" => "uwallet", "amount" => "100" } ],
        status: :pending
      )
      _(payment.ready_to_record?).must_equal false
    end

    it "returns false when KYC not approved" do
      payment = MoolaPayment.new(
        cart_token: "test",
        invoice_number: "NULF-CT:test",
        kyc_status: "REVIEW",
        bydesign_order_id: "12345",
        payment_details: [ { "type" => "uwallet", "amount" => "100" } ],
        status: :matched
      )
      _(payment.ready_to_record?).must_equal false
    end
  end

  describe "#kyc_approved?" do
    it "returns true when kyc_status is APPROVE" do
      payment = MoolaPayment.new(kyc_status: "APPROVE")
      _(payment.kyc_approved?).must_equal true
    end

    it "returns false when kyc_status is REVIEW" do
      payment = MoolaPayment.new(kyc_status: "REVIEW")
      _(payment.kyc_approved?).must_equal false
    end

    it "returns false when kyc_status is DECLINE" do
      payment = MoolaPayment.new(kyc_status: "DECLINE")
      _(payment.kyc_approved?).must_equal false
    end
  end

  describe "#total_amount" do
    it "sums all payment amounts" do
      payment = MoolaPayment.new(
        payment_details: [
          { "amount" => "50.00" },
          { "amount" => "30.00" },
          { "amount" => "20.00" },
        ]
      )
      _(payment.total_amount).must_equal 100.0
    end

    it "returns 0 for empty payment_details" do
      payment = MoolaPayment.new(payment_details: [])
      _(payment.total_amount).must_equal 0.0
    end
  end

  describe "#max_attempts_reached?" do
    it "returns false when under max attempts" do
      payment = MoolaPayment.new(bydesign_recording_attempts: 4)
      _(payment.max_attempts_reached?).must_equal false
    end

    it "returns true when at max attempts" do
      payment = MoolaPayment.new(bydesign_recording_attempts: 5)
      _(payment.max_attempts_reached?).must_equal true
    end

    it "returns true when over max attempts" do
      payment = MoolaPayment.new(bydesign_recording_attempts: 10)
      _(payment.max_attempts_reached?).must_equal true
    end
  end

  describe "#update_status_and_enqueue_if_ready!" do
    include ActiveJob::TestHelper

    before do
      MoolaPayment.delete_all
    end

    it "updates status to recording when ready to record" do
      payment = MoolaPayment.create!(
        cart_token: "status-update-test",
        invoice_number: "NULF-CT:status-update-test",
        kyc_status: "APPROVE",
        bydesign_order_id: "12345",
        payment_details: [ { "type" => "uwallet", "amount" => "100" } ],
        status: :pending
      )

      payment.update_status_and_enqueue_if_ready!

      # Status transitions to :recording when ready (prevents duplicate job enqueues)
      _(payment.reload.status).must_equal "recording"
    end

    it "sets matched_at when transitioning to matched" do
      payment = MoolaPayment.create!(
        cart_token: "matched-at-test",
        invoice_number: "NULF-CT:matched-at-test",
        kyc_status: "APPROVE",
        bydesign_order_id: "12345",
        payment_details: [ { "type" => "uwallet", "amount" => "100" } ],
        status: :pending,
        matched_at: nil
      )

      payment.update_status_and_enqueue_if_ready!

      _(payment.reload.matched_at).wont_be_nil
    end

    it "does not overwrite existing matched_at" do
      original_time = 1.hour.ago
      payment = MoolaPayment.create!(
        cart_token: "existing-matched-at-test",
        invoice_number: "NULF-CT:existing-matched-at-test",
        kyc_status: "APPROVE",
        bydesign_order_id: "12345",
        payment_details: [ { "type" => "uwallet", "amount" => "100" } ],
        status: :pending,
        matched_at: original_time
      )

      payment.update_status_and_enqueue_if_ready!

      _(payment.reload.matched_at.to_i).must_equal original_time.to_i
    end

    it "enqueues ByDesignPaymentRecordingJob when ready to record" do
      payment = MoolaPayment.create!(
        cart_token: "enqueue-test",
        invoice_number: "NULF-CT:enqueue-test",
        kyc_status: "APPROVE",
        bydesign_order_id: "12345",
        payment_details: [ { "type" => "uwallet", "amount" => "100" } ],
        status: :pending
      )

      assert_enqueued_with(job: ByDesignPaymentRecordingJob, args: [ payment.id ]) do
        payment.update_status_and_enqueue_if_ready!
      end
    end

    it "returns true when job is enqueued" do
      payment = MoolaPayment.create!(
        cart_token: "return-true-test",
        invoice_number: "NULF-CT:return-true-test",
        kyc_status: "APPROVE",
        bydesign_order_id: "12345",
        payment_details: [ { "type" => "uwallet", "amount" => "100" } ],
        status: :pending
      )

      result = payment.update_status_and_enqueue_if_ready!

      _(result).must_equal true
    end

    it "returns false when job is not enqueued" do
      payment = MoolaPayment.create!(
        cart_token: "return-false-test",
        invoice_number: "NULF-CT:return-false-test",
        kyc_status: "REVIEW",  # KYC pending, so not ready to record
        payment_details: [ { "type" => "uwallet", "amount" => "100" } ],
        status: :pending
      )

      result = payment.update_status_and_enqueue_if_ready!

      _(result).must_equal false
    end

    it "does not enqueue job when not ready to record" do
      payment = MoolaPayment.create!(
        cart_token: "no-enqueue-test",
        invoice_number: "NULF-CT:no-enqueue-test",
        kyc_status: "APPROVE",
        bydesign_order_id: nil,  # Missing ByDesign order ID
        payment_details: [ { "type" => "uwallet", "amount" => "100" } ],
        status: :pending
      )

      assert_no_enqueued_jobs(only: ByDesignPaymentRecordingJob) do
        payment.update_status_and_enqueue_if_ready!
      end
    end
  end

  describe "concurrent webhook handling" do
    include ActiveJob::TestHelper

    before do
      MoolaPayment.delete_all
    end

    it "only enqueues one job when concurrent webhooks arrive" do
      # Create a payment that's ready to record
      payment = MoolaPayment.create!(
        cart_token: "concurrent-test",
        invoice_number: "NULF-CT:concurrent-test",
        kyc_status: "APPROVE",
        bydesign_order_id: "12345",
        payment_details: [ { "type" => "uwallet", "amount" => "100" } ],
        status: :pending
      )

      # Simulate concurrent webhook processing with threads
      threads = []
      results = []
      mutex = Mutex.new

      5.times do
        threads << Thread.new do
          # Each thread tries to claim the payment for recording
          result = payment.update_status_and_enqueue_if_ready!
          mutex.synchronize { results << result }
        end
      end

      threads.each(&:join)

      # Only ONE thread should have successfully claimed (returned true)
      _(results.count(true)).must_equal 1
      _(results.count(false)).must_equal 4

      # Payment should be in recording status
      _(payment.reload.status).must_equal "recording"
    end

    it "prevents double-processing when payment already recording" do
      payment = MoolaPayment.create!(
        cart_token: "already-recording",
        invoice_number: "NULF-CT:already-recording",
        kyc_status: "APPROVE",
        bydesign_order_id: "12345",
        payment_details: [ { "type" => "uwallet", "amount" => "100" } ],
        status: :recording  # Already being processed
      )

      # Attempting to claim should return false
      result = payment.update_status_and_enqueue_if_ready!
      _(result).must_equal false

      # No job should be enqueued
      assert_no_enqueued_jobs(only: ByDesignPaymentRecordingJob)
    end

    it "prevents re-processing of recorded payments" do
      payment = MoolaPayment.create!(
        cart_token: "already-recorded",
        invoice_number: "NULF-CT:already-recorded",
        kyc_status: "APPROVE",
        bydesign_order_id: "12345",
        payment_details: [ { "type" => "uwallet", "amount" => "100" } ],
        status: :recorded,
        recorded_at: Time.current
      )

      result = payment.update_status_and_enqueue_if_ready!
      _(result).must_equal false

      assert_no_enqueued_jobs(only: ByDesignPaymentRecordingJob)
    end

    it "prevents re-processing of failed payments" do
      payment = MoolaPayment.create!(
        cart_token: "already-failed",
        invoice_number: "NULF-CT:already-failed",
        kyc_status: "APPROVE",
        bydesign_order_id: "12345",
        payment_details: [ { "type" => "uwallet", "amount" => "100" } ],
        status: :failed,
        last_error: "Max attempts reached"
      )

      result = payment.update_status_and_enqueue_if_ready!
      _(result).must_equal false

      assert_no_enqueued_jobs(only: ByDesignPaymentRecordingJob)
    end
  end

  describe "scopes" do
    before do
      MoolaPayment.delete_all
    end

    it "awaiting_match returns pending payments" do
      pending_payment = MoolaPayment.create!(
        cart_token: "pending-1",
        invoice_number: "NULF-CT:pending-1",
        status: :pending
      )
      MoolaPayment.create!(
        cart_token: "matched-1",
        invoice_number: "NULF-CT:matched-1",
        status: :matched
      )

      results = MoolaPayment.awaiting_match
      _(results.count).must_equal 1
      _(results.first).must_equal pending_payment
    end

    it "ready_to_record returns matched payments" do
      MoolaPayment.create!(
        cart_token: "pending-1",
        invoice_number: "NULF-CT:pending-1",
        status: :pending
      )
      matched_payment = MoolaPayment.create!(
        cart_token: "matched-1",
        invoice_number: "NULF-CT:matched-1",
        status: :matched
      )

      results = MoolaPayment.ready_to_record
      _(results.count).must_equal 1
      _(results.first).must_equal matched_payment
    end

    it "failed_recordings returns failed payments" do
      MoolaPayment.create!(
        cart_token: "pending-1",
        invoice_number: "NULF-CT:pending-1",
        status: :pending
      )
      failed_payment = MoolaPayment.create!(
        cart_token: "failed-1",
        invoice_number: "NULF-CT:failed-1",
        status: :failed
      )

      results = MoolaPayment.failed_recordings
      _(results.count).must_equal 1
      _(results.first).must_equal failed_payment
    end

    it "stuck_in_recording returns payments stuck in recording status" do
      # Recent recording - should NOT be returned
      MoolaPayment.create!(
        cart_token: "recent-recording",
        invoice_number: "NULF-CT:recent-recording",
        status: :recording
      )

      # Stuck recording (updated > 30 mins ago) - should be returned
      stuck_payment = MoolaPayment.create!(
        cart_token: "stuck-recording",
        invoice_number: "NULF-CT:stuck-recording",
        status: :recording
      )
      # Manually set updated_at to simulate stuck payment
      stuck_payment.update_columns(updated_at: 45.minutes.ago)

      results = MoolaPayment.stuck_in_recording
      _(results.count).must_equal 1
      _(results.first).must_equal stuck_payment
    end

    it "stuck_in_recording accepts custom minutes threshold" do
      stuck_payment = MoolaPayment.create!(
        cart_token: "stuck-custom",
        invoice_number: "NULF-CT:stuck-custom",
        status: :recording
      )
      stuck_payment.update_columns(updated_at: 15.minutes.ago)

      # Default 30 minutes - should not find it
      _(MoolaPayment.stuck_in_recording.count).must_equal 0

      # Custom 10 minutes - should find it
      _(MoolaPayment.stuck_in_recording(10).count).must_equal 1
    end
  end

  describe "stuck payment recovery" do
    include ActiveJob::TestHelper

    before do
      MoolaPayment.delete_all
    end

    it "reset_stuck_to_matched! resets stuck payments and re-enqueues" do
      stuck_payment = MoolaPayment.create!(
        cart_token: "stuck-recovery",
        invoice_number: "NULF-CT:stuck-recovery",
        kyc_status: "APPROVE",
        bydesign_order_id: "12345",
        payment_details: [ { "type" => "uwallet", "amount" => "100" } ],
        status: :recording
      )
      stuck_payment.update_columns(updated_at: 45.minutes.ago)

      assert_enqueued_with(job: ByDesignPaymentRecordingJob, args: [ stuck_payment.id ]) do
        count = MoolaPayment.reset_stuck_to_matched!
        _(count).must_equal 1
      end

      stuck_payment.reload
      _(stuck_payment.status).must_equal "recording"  # Re-claimed immediately
    end

    it "reset_stuck_to_matched! does not affect recent recordings" do
      recent_payment = MoolaPayment.create!(
        cart_token: "recent-recovery",
        invoice_number: "NULF-CT:recent-recovery",
        kyc_status: "APPROVE",
        bydesign_order_id: "12345",
        payment_details: [ { "type" => "uwallet", "amount" => "100" } ],
        status: :recording
      )

      assert_no_enqueued_jobs(only: ByDesignPaymentRecordingJob) do
        count = MoolaPayment.reset_stuck_to_matched!
        _(count).must_equal 0
      end

      recent_payment.reload
      _(recent_payment.status).must_equal "recording"
    end
  end
end
