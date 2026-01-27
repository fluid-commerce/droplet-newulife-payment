require "test_helper"

describe MoolaP2mWebhookJob do
  include ActiveJob::TestHelper

  before do
    MoolaPayment.delete_all
  end

  describe "#perform" do
    it "creates a payment record from P2M webhook" do
      payload = {
        "type" => "transaction",
        "transaction_type" => "p2m",
        "invoice_number" => "NULF-CT:cart-123",
        "transaction_id" => "TXN456",
        "kycStatus" => "APPROVE",
        "payment_details" => [
          { "type" => "LOAD_FUNDS_VIA_CARD", "amount" => "100.00", "id" => "PAY789", "status" => "Success" }
        ]
      }

      _(-> { MoolaP2mWebhookJob.perform_now(payload) }).must_change "MoolaPayment.count", +1

      payment = MoolaPayment.last
      _(payment.cart_token).must_equal "cart-123"
      _(payment.invoice_number).must_equal "NULF-CT:cart-123"
      _(payment.moola_transaction_id).must_equal "TXN456"
      _(payment.kyc_status).must_equal "APPROVE"
      _(payment.transaction_type).must_equal "p2m"
      _(payment.payment_details.length).must_equal 1
      _(payment.status).must_equal "pending"
    end

    it "skips non-P2M transactions" do
      payload = {
        "type" => "transaction",
        "transaction_type" => "p2b",  # Not P2M
        "invoice_number" => "NULF-CT:cart-123",
        "kycStatus" => "APPROVE",
        "payment_details" => []
      }

      _(-> { MoolaP2mWebhookJob.perform_now(payload) }).wont_change "MoolaPayment.count"
    end

    it "skips invalid invoice number format" do
      payload = {
        "type" => "transaction",
        "transaction_type" => "p2m",
        "invoice_number" => "invalid-format",
        "kycStatus" => "APPROVE",
        "payment_details" => []
      }

      _(-> { MoolaP2mWebhookJob.perform_now(payload) }).wont_change "MoolaPayment.count"
    end

    it "filters out declined payments from payment_details" do
      payload = {
        "type" => "transaction",
        "transaction_type" => "p2m",
        "invoice_number" => "NULF-CT:cart-456",
        "kycStatus" => "APPROVE",
        "payment_details" => [
          { "type" => "LOAD_FUNDS_VIA_CARD", "amount" => "100.00", "id" => "PAY1", "status" => "Success" },
          { "type" => "uwallet", "amount" => "50.00", "id" => "PAY2", "status" => "Declined" },
          { "type" => "uwallet", "amount" => "25.00", "id" => "PAY3", "status" => "Pending" }
        ]
      }

      MoolaP2mWebhookJob.perform_now(payload)

      payment = MoolaPayment.last
      _(payment.payment_details.length).must_equal 2
      _(payment.payment_details.map { |pd| pd["id"] }).must_equal ["PAY1", "PAY3"]
    end

    it "sets status to kyc_pending when KYC is REVIEW" do
      payload = {
        "type" => "transaction",
        "transaction_type" => "p2m",
        "invoice_number" => "NULF-CT:cart-789",
        "kycStatus" => "REVIEW",
        "payment_details" => [
          { "type" => "uwallet", "amount" => "100.00", "id" => "PAY1", "status" => "Success" }
        ]
      }

      MoolaP2mWebhookJob.perform_now(payload)

      payment = MoolaPayment.last
      _(payment.status).must_equal "kyc_pending"
    end

    it "sets status to kyc_declined when KYC is DECLINE" do
      payload = {
        "type" => "transaction",
        "transaction_type" => "p2m",
        "invoice_number" => "NULF-CT:cart-declined",
        "kycStatus" => "DECLINE",
        "payment_details" => [
          { "type" => "uwallet", "amount" => "100.00", "id" => "PAY1", "status" => "Success" }
        ]
      }

      MoolaP2mWebhookJob.perform_now(payload)

      payment = MoolaPayment.last
      _(payment.status).must_equal "kyc_declined"
    end

    it "updates existing payment record" do
      # Create existing payment (from Fluid webhook arriving first)
      existing = MoolaPayment.create!(
        cart_token: "existing-cart",
        invoice_number: "NULF-CT:existing-cart",
        bydesign_order_id: "BD12345",
        status: :pending
      )

      payload = {
        "type" => "transaction",
        "transaction_type" => "p2m",
        "invoice_number" => "NULF-CT:existing-cart",
        "kycStatus" => "APPROVE",
        "transaction_id" => "TXN999",
        "payment_details" => [
          { "type" => "uwallet", "amount" => "75.00", "id" => "PAY999", "status" => "Success" }
        ]
      }

      _(-> { MoolaP2mWebhookJob.perform_now(payload) }).wont_change "MoolaPayment.count"

      existing.reload
      _(existing.kyc_status).must_equal "APPROVE"
      _(existing.moola_transaction_id).must_equal "TXN999"
      _(existing.payment_details.length).must_equal 1
      _(existing.status).must_equal "matched"  # Both webhooks received, KYC approved
      _(existing.matched_at).wont_be_nil
    end

    it "triggers ByDesignPaymentRecordingJob when ready to record" do
      # Create existing payment with ByDesign order ID
      MoolaPayment.create!(
        cart_token: "ready-cart",
        invoice_number: "NULF-CT:ready-cart",
        bydesign_order_id: "BD98765",
        status: :pending
      )

      payload = {
        "type" => "transaction",
        "transaction_type" => "p2m",
        "invoice_number" => "NULF-CT:ready-cart",
        "kycStatus" => "APPROVE",
        "payment_details" => [
          { "type" => "uwallet", "amount" => "100.00", "id" => "PAY123", "status" => "Success" }
        ]
      }

      assert_enqueued_with(job: ByDesignPaymentRecordingJob) do
        MoolaP2mWebhookJob.perform_now(payload)
      end
    end

    it "does not trigger recording when KYC is REVIEW" do
      MoolaPayment.create!(
        cart_token: "review-cart",
        invoice_number: "NULF-CT:review-cart",
        bydesign_order_id: "BD11111",
        status: :pending
      )

      payload = {
        "type" => "transaction",
        "transaction_type" => "p2m",
        "invoice_number" => "NULF-CT:review-cart",
        "kycStatus" => "REVIEW",
        "payment_details" => [
          { "type" => "uwallet", "amount" => "100.00", "id" => "PAY123", "status" => "Success" }
        ]
      }

      assert_no_enqueued_jobs(only: ByDesignPaymentRecordingJob) do
        MoolaP2mWebhookJob.perform_now(payload)
      end
    end

    it "stores the full webhook payload" do
      payload = {
        "type" => "transaction",
        "transaction_type" => "p2m",
        "invoice_number" => "NULF-CT:audit-cart",
        "kycStatus" => "APPROVE",
        "payment_details" => [],
        "extra_field" => "extra_value"
      }

      MoolaP2mWebhookJob.perform_now(payload)

      payment = MoolaPayment.last
      _(payment.moola_webhook_payload["extra_field"]).must_equal "extra_value"
    end
  end
end
