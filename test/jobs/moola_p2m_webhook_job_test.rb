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
          { "type" => "LOAD_FUNDS_VIA_CARD", "amount" => "100.00", "id" => "PAY789", "status" => "Success" },
        ],
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

    it "skips unsupported transaction types" do
      payload = {
        "type" => "transaction",
        "transaction_type" => "p2b",  # Unsupported type
        "invoice_number" => "NULF-CT:cart-123",
        "kycStatus" => "APPROVE",
        "payment_details" => [],
      }

      _(-> { MoolaP2mWebhookJob.perform_now(payload) }).wont_change "MoolaPayment.count"
    end

    it "skips invalid invoice number format" do
      payload = {
        "type" => "transaction",
        "transaction_type" => "p2m",
        "invoice_number" => "invalid-format",
        "kycStatus" => "APPROVE",
        "payment_details" => [],
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
          { "type" => "uwallet", "amount" => "25.00", "id" => "PAY3", "status" => "Pending" },
        ],
      }

      MoolaP2mWebhookJob.perform_now(payload)

      payment = MoolaPayment.last
      _(payment.payment_details.length).must_equal 2
      _(payment.payment_details.map { |pd| pd["id"] }).must_equal %w[PAY1 PAY3]
    end

    it "sets status to kyc_pending when KYC is REVIEW" do
      payload = {
        "type" => "transaction",
        "transaction_type" => "p2m",
        "invoice_number" => "NULF-CT:cart-789",
        "kycStatus" => "REVIEW",
        "payment_details" => [
          { "type" => "uwallet", "amount" => "100.00", "id" => "PAY1", "status" => "Success" },
        ],
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
          { "type" => "uwallet", "amount" => "100.00", "id" => "PAY1", "status" => "Success" },
        ],
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
          { "type" => "uwallet", "amount" => "75.00", "id" => "PAY999", "status" => "Success" },
        ],
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
          { "type" => "uwallet", "amount" => "100.00", "id" => "PAY123", "status" => "Success" },
        ],
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
          { "type" => "uwallet", "amount" => "100.00", "id" => "PAY123", "status" => "Success" },
        ],
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
        "extra_field" => "extra_value",
      }

      MoolaP2mWebhookJob.perform_now(payload)

      payment = MoolaPayment.last
      _(payment.moola_webhook_payload["extra_field"]).must_equal "extra_value"
    end

    describe "payment status preservation" do
      it "preserves Success status when later webhook has Pending" do
        # First webhook arrives with Success
        MoolaPayment.create!(
          cart_token: "status-test-cart",
          invoice_number: "NULF-CT:status-test-cart",
          payment_details: [
            { "type" => "LOAD_FUNDS_VIA_CARD", "amount" => "100.00", "id" => "PAY123", "status" => "Success" },
          ],
          status: :pending
        )

        # Later webhook arrives with Pending status (should NOT downgrade)
        payload = {
          "type" => "transaction",
          "transaction_type" => "p2m",
          "invoice_number" => "NULF-CT:status-test-cart",
          "kycStatus" => "APPROVE",
          "payment_details" => [
            { "type" => "LOAD_FUNDS_VIA_CARD", "amount" => "100.00", "id" => "PAY123", "status" => "Pending" },
          ],
        }

        MoolaP2mWebhookJob.perform_now(payload)

        payment = MoolaPayment.find_by(cart_token: "status-test-cart")
        # Status should remain Success, not be downgraded to Pending
        _(payment.payment_details.first["status"]).must_equal "Success"
      end

      it "upgrades Pending status to Success when better webhook arrives" do
        # First webhook arrives with Pending
        MoolaPayment.create!(
          cart_token: "upgrade-test-cart",
          invoice_number: "NULF-CT:upgrade-test-cart",
          payment_details: [
            { "type" => "LOAD_FUNDS_VIA_CARD", "amount" => "100.00", "id" => "PAY456", "status" => "Pending" },
          ],
          status: :pending
        )

        # Later webhook arrives with Success status (should upgrade)
        payload = {
          "type" => "transaction",
          "transaction_type" => "p2m",
          "invoice_number" => "NULF-CT:upgrade-test-cart",
          "kycStatus" => "APPROVE",
          "payment_details" => [
            { "type" => "LOAD_FUNDS_VIA_CARD", "amount" => "100.00", "id" => "PAY456", "status" => "Success" },
          ],
        }

        MoolaP2mWebhookJob.perform_now(payload)

        payment = MoolaPayment.find_by(cart_token: "upgrade-test-cart")
        _(payment.payment_details.first["status"]).must_equal "Success"
      end
    end

    describe "load_funds_via_card transaction type" do
      it "processes load_funds_via_card webhooks and extracts card details" do
        # First create a payment record (from P2M webhook)
        MoolaPayment.create!(
          cart_token: "card-cart",
          invoice_number: "NULF-CT:card-cart",
          status: :pending
        )

        payload = {
          "type" => "transaction",
          "transaction_type" => "load_funds_via_card",
          "invoice_number" => "NULF-CT:card-cart",
          "id" => "CARD123",
          "kycStatus" => "APPROVE",
          "card_number_last4" => "1111",
          "expiry_date" => "12/2032",
          "payment_instrument_uuid" => "uuid-abc-123",
          "parent_reference" => "P2M456",
        }

        _(-> { MoolaP2mWebhookJob.perform_now(payload) }).wont_change "MoolaPayment.count"

        payment = MoolaPayment.find_by(cart_token: "card-cart")
        _(payment.card_details["card_number_last4"]).must_equal "1111"
        _(payment.card_details["expiry_date"]).must_equal "12/2032"
        _(payment.card_details["payment_instrument_uuid"]).must_equal "uuid-abc-123"
        _(payment.card_details["transaction_id"]).must_equal "CARD123"
        _(payment.card_details["parent_reference"]).must_equal "P2M456"
      end

      it "creates a new payment record if one doesn't exist for card details" do
        payload = {
          "type" => "transaction",
          "transaction_type" => "load_funds_via_card",
          "invoice_number" => "NULF-CT:new-card-cart",
          "id" => "CARD789",
          "kycStatus" => "APPROVE",
          "card_number_last4" => "4242",
          "expiry_date" => "08/2029",
          "payment_instrument_uuid" => "uuid-xyz-456",
        }

        _(-> { MoolaP2mWebhookJob.perform_now(payload) }).must_change "MoolaPayment.count", +1

        payment = MoolaPayment.last
        _(payment.cart_token).must_equal "new-card-cart"
        _(payment.card_details["card_number_last4"]).must_equal "4242"
      end

      it "updates KYC status from card webhook if not already set" do
        MoolaPayment.create!(
          cart_token: "kyc-card-cart",
          invoice_number: "NULF-CT:kyc-card-cart",
          status: :pending,
          kyc_status: nil
        )

        payload = {
          "type" => "transaction",
          "transaction_type" => "load_funds_via_card",
          "invoice_number" => "NULF-CT:kyc-card-cart",
          "id" => "CARD999",
          "kycStatus" => "APPROVE",
          "card_number_last4" => "5555",
        }

        MoolaP2mWebhookJob.perform_now(payload)

        payment = MoolaPayment.find_by(cart_token: "kyc-card-cart")
        _(payment.kyc_status).must_equal "APPROVE"
      end

      it "does not overwrite existing KYC status from card webhook" do
        MoolaPayment.create!(
          cart_token: "existing-kyc-cart",
          invoice_number: "NULF-CT:existing-kyc-cart",
          status: :pending,
          kyc_status: "REVIEW"
        )

        payload = {
          "type" => "transaction",
          "transaction_type" => "load_funds_via_card",
          "invoice_number" => "NULF-CT:existing-kyc-cart",
          "id" => "CARD111",
          "kycStatus" => "APPROVE",
          "card_number_last4" => "6666",
        }

        MoolaP2mWebhookJob.perform_now(payload)

        payment = MoolaPayment.find_by(cart_token: "existing-kyc-cart")
        _(payment.kyc_status).must_equal "REVIEW"  # Should not be overwritten
      end

      it "triggers recording when card details complete the ready state" do
        # Payment with ByDesign order ID and payment_details, just missing card details
        MoolaPayment.create!(
          cart_token: "ready-for-card",
          invoice_number: "NULF-CT:ready-for-card",
          bydesign_order_id: "BD55555",
          kyc_status: "APPROVE",
          payment_details: [ { "type" => "LOAD_FUNDS_VIA_CARD", "amount" => "100.00", "id" => "PAY555",
"status" => "Success", } ],
          status: :pending
        )

        payload = {
          "type" => "transaction",
          "transaction_type" => "load_funds_via_card",
          "invoice_number" => "NULF-CT:ready-for-card",
          "id" => "PAY555",
          "kycStatus" => "APPROVE",
          "card_number_last4" => "7777",
          "expiry_date" => "01/2030",
          "payment_instrument_uuid" => "uuid-ready-123",
        }

        assert_enqueued_with(job: ByDesignPaymentRecordingJob) do
          MoolaP2mWebhookJob.perform_now(payload)
        end
      end
    end
  end
end
