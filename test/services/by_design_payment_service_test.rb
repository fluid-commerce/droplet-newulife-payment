require "test_helper"
require "webmock/minitest"

describe ByDesignPaymentService do
  before do
    ENV["BY_DESIGN_API_URL"] = "https://api.bydesign.test"
    ENV["BY_DESIGN_INTEGRATION_USERNAME"] = "test_user"
    ENV["BY_DESIGN_INTEGRATION_PASSWORD"] = "test_pass"
    # Allow any HTTP request to be stubbed with regex
    WebMock.disable_net_connect!(allow_localhost: false)
  end

  after do
    WebMock.reset!
  end

  describe ".should_skip_payment?" do
    it "returns true for Declined payment" do
      payment_detail = { "status" => "Declined", "type" => "LOAD_FUNDS_VIA_CARD" }
      _(ByDesignPaymentService.should_skip_payment?(payment_detail)).must_equal true
    end

    it "returns false for Success payment" do
      payment_detail = { "status" => "Success", "type" => "LOAD_FUNDS_VIA_CARD" }
      _(ByDesignPaymentService.should_skip_payment?(payment_detail)).must_equal false
    end

    it "returns false for Pending payment" do
      payment_detail = { "status" => "Pending", "type" => "LOAD_FUNDS_VIA_CARD" }
      _(ByDesignPaymentService.should_skip_payment?(payment_detail)).must_equal false
    end
  end

  describe "#record_payment" do
    it "skips declined payments and returns success" do
      payment_detail = {
        "type" => "LOAD_FUNDS_VIA_CARD",
        "amount" => "100.00",
        "id" => "PAY123",
        "status" => "Declined"
      }

      result = ByDesignPaymentService.record_payment(
        order_id: "12345",
        payment_detail: payment_detail,
        kyc_status: "APPROVE"
      )

      _(result[:success]).must_equal true
      _(result[:skipped]).must_equal true
      _(result[:reason]).must_equal "Payment declined at processor level"
    end

    it "makes API call for successful payments" do
      payment_detail = {
        "type" => "LOAD_FUNDS_VIA_CARD",
        "amount" => "100.00",
        "id" => "PAY123",
        "status" => "Success"
      }

      # Use regex to match any URL ending with the API path
      stub_request(:post, /\/api\/Personal\/Order\/Payment\/CreditCard\/Save/)
        .to_return(
          status: 200,
          body: { "Result" => { "IsSuccessful" => true } }.to_json,
          headers: { "Content-Type" => "application/json" }
        )

      result = ByDesignPaymentService.record_payment(
        order_id: "12345",
        payment_detail: payment_detail,
        card_details: { "last4" => "4242", "expiry_date" => "12/2025" },
        kyc_status: "APPROVE",
        invoice_number: "NULF-CT:test123"
      )

      _(result[:success]).must_equal true
      _(result[:skipped]).must_be_nil
    end

    it "handles API errors gracefully" do
      payment_detail = {
        "type" => "uwallet",
        "amount" => "50.00",
        "id" => "PAY456",
        "status" => "Success"
      }

      stub_request(:post, /\/api\/Personal\/Order\/Payment\/CreditCard\/Save/)
        .to_return(
          status: 500,
          body: "Internal Server Error"
        )

      result = ByDesignPaymentService.record_payment(
        order_id: "12345",
        payment_detail: payment_detail,
        kyc_status: "APPROVE"
      )

      _(result[:success]).must_equal false
      _(result[:error]).must_match(/HTTP 500/)
    end

    it "handles timeout errors" do
      payment_detail = {
        "type" => "uwallet",
        "amount" => "50.00",
        "id" => "PAY456",
        "status" => "Success"
      }

      stub_request(:post, /\/api\/Personal\/Order\/Payment\/CreditCard\/Save/)
        .to_timeout

      result = ByDesignPaymentService.record_payment(
        order_id: "12345",
        payment_detail: payment_detail,
        kyc_status: "APPROVE"
      )

      _(result[:success]).must_equal false
      _(result[:error]).must_match(/timeout/i)
    end
  end

  describe "payment status mapping" do
    let(:service) { ByDesignPaymentService.new }

    describe "#determine_effective_status" do
      it "uses KYC REVIEW status override" do
        payment_detail = { "type" => "uwallet", "status" => "Success" }
        result = service.send(:determine_effective_status, payment_detail, "REVIEW")
        _(result).must_equal 6  # Pending
      end

      it "uses KYC DECLINE status override" do
        payment_detail = { "type" => "uwallet", "status" => "Success" }
        result = service.send(:determine_effective_status, payment_detail, "DECLINE")
        _(result).must_equal 18  # Declined
      end

      it "uses payment status for KYC APPROVE" do
        payment_detail = { "type" => "uwallet", "status" => "Success" }
        result = service.send(:determine_effective_status, payment_detail, "APPROVE")
        _(result).must_equal 1  # Normal/Approved
      end

      it "returns Pending for LOAD_FUNDS_VIA_CASH regardless of status" do
        payment_detail = { "type" => "LOAD_FUNDS_VIA_CASH", "status" => "Success" }
        result = service.send(:determine_effective_status, payment_detail, "APPROVE")
        _(result).must_equal 6  # Pending
      end

      it "maps Success status to 1" do
        payment_detail = { "type" => "uwallet", "status" => "Success" }
        result = service.send(:determine_effective_status, payment_detail, "APPROVE")
        _(result).must_equal 1
      end

      it "maps Pending status to 6" do
        payment_detail = { "type" => "uwallet", "status" => "Pending" }
        result = service.send(:determine_effective_status, payment_detail, "APPROVE")
        _(result).must_equal 6
      end

      it "maps Failed status to 18" do
        payment_detail = { "type" => "uwallet", "status" => "Failed" }
        result = service.send(:determine_effective_status, payment_detail, "APPROVE")
        _(result).must_equal 18
      end

      it "defaults to Pending for unknown status" do
        payment_detail = { "type" => "uwallet", "status" => "Unknown" }
        result = service.send(:determine_effective_status, payment_detail, "APPROVE")
        _(result).must_equal 6  # Default to Pending
      end
    end
  end

  describe "payload building" do
    let(:service) { ByDesignPaymentService.new }

    describe "#build_payment_payload" do
      it "includes card fields only for LOAD_FUNDS_VIA_CARD" do
        payment_detail = {
          "type" => "LOAD_FUNDS_VIA_CARD",
          "amount" => "100.00",
          "id" => "PAY123",
          "status" => "Success"
        }
        card_details = { "last4" => "4242", "expiry_date" => "12/2025" }

        payload = service.send(:build_payment_payload, "12345", payment_detail, card_details, "APPROVE", "NULF-CT:test")

        _(payload[:PaymentToken]).must_equal "PAY123"
        _(payload[:Last4CCNumber]).must_equal "4242"
        _(payload[:ExpirationDateMMYY]).must_equal "1225"
      end

      it "excludes card fields for non-card payments" do
        payment_detail = {
          "type" => "uwallet",
          "amount" => "100.00",
          "id" => "PAY123",
          "status" => "Success"
        }

        payload = service.send(:build_payment_payload, "12345", payment_detail, {}, "APPROVE", "NULF-CT:test")

        _(payload.key?(:PaymentToken)).must_equal false
        _(payload.key?(:Last4CCNumber)).must_equal false
        _(payload.key?(:ExpirationDateMMYY)).must_equal false
      end

      it "includes common fields for all payment types" do
        payment_detail = {
          "type" => "uwallet",
          "amount" => "100.00",
          "id" => "PAY123",
          "status" => "Success"
        }

        payload = service.send(:build_payment_payload, "12345", payment_detail, {}, "APPROVE", "NULF-CT:test")

        _(payload[:OrderID]).must_equal 12345
        _(payload[:CreditCardAccountId]).must_equal 30
        _(payload[:TransactionID]).must_equal "PAY123"
        _(payload[:ReferenceNumber]).must_equal "NULF-CT:test"
        _(payload[:PaymentDate]).wont_be_nil
        _(payload[:PaymentDescription]).must_match(/Moola Wallet/)
      end

      it "uses promissory amount for Pending payments" do
        payment_detail = {
          "type" => "uwallet",
          "amount" => "100.00",
          "id" => "PAY123",
          "status" => "Pending"
        }

        payload = service.send(:build_payment_payload, "12345", payment_detail, {}, "APPROVE", "NULF-CT:test")

        _(payload[:Amount]).must_equal 0
        _(payload[:PromissoryAmount]).must_equal 100.0
      end

      it "uses regular amount for Success payments" do
        payment_detail = {
          "type" => "uwallet",
          "amount" => "100.00",
          "id" => "PAY123",
          "status" => "Success"
        }

        payload = service.send(:build_payment_payload, "12345", payment_detail, {}, "APPROVE", "NULF-CT:test")

        _(payload[:Amount]).must_equal 100.0
        _(payload[:PromissoryAmount]).must_equal 0
      end

      it "uses promissory for LOAD_FUNDS_VIA_CASH regardless of status" do
        payment_detail = {
          "type" => "LOAD_FUNDS_VIA_CASH",
          "amount" => "50.00",
          "id" => "PAY789",
          "status" => "Success"
        }

        payload = service.send(:build_payment_payload, "12345", payment_detail, {}, "APPROVE", "NULF-CT:test")

        _(payload[:Amount]).must_equal 0
        _(payload[:PromissoryAmount]).must_equal 50.0
        _(payload[:PaymentStatusTypeID]).must_equal 6  # Pending
      end
    end

    describe "#extract_last4" do
      it "extracts last4 from card_details" do
        result = service.send(:extract_last4, { "id" => "ABC123" }, { "last4" => "4242" })
        _(result).must_equal "4242"
      end

      it "falls back to last 4 chars of payment id" do
        result = service.send(:extract_last4, { "id" => "PAY123456" }, {})
        _(result).must_equal "3456"
      end

      it "returns nil when no data available" do
        result = service.send(:extract_last4, {}, {})
        _(result).must_be_nil
      end
    end

    describe "#extract_expiry" do
      it "parses expiry_date in MM/YYYY format" do
        result = service.send(:extract_expiry, { "expiry_date" => "8/2029" })
        _(result).must_equal "0829"
      end

      it "parses expiry_date in MM/YY format" do
        result = service.send(:extract_expiry, { "expiry_date" => "12/25" })
        _(result).must_equal "1225"
      end

      it "uses expiry_month and expiry_year fields" do
        result = service.send(:extract_expiry, { "expiry_month" => "3", "expiry_year" => "2028" })
        _(result).must_equal "0328"
      end

      it "returns nil when no expiry data" do
        result = service.send(:extract_expiry, {})
        _(result).must_be_nil
      end
    end
  end

  describe "response parsing" do
    let(:service) { ByDesignPaymentService.new }

    it "parses successful response" do
      response = OpenStruct.new(
        code: 200,
        body: { "Result" => { "IsSuccessful" => true } }.to_json
      )

      result = service.send(:parse_response, response)

      _(result[:success]).must_equal true
      _(result[:error]).must_be_nil
    end

    it "parses error response with message" do
      response = OpenStruct.new(
        code: 200,
        body: { "Result" => { "IsSuccessful" => false, "Message" => "Order not found" } }.to_json
      )

      result = service.send(:parse_response, response)

      _(result[:success]).must_equal false
      _(result[:error]).must_equal "Order not found"
    end

    it "handles non-200 HTTP status" do
      response = OpenStruct.new(
        code: 400,
        message: "Bad Request",
        body: "Invalid payload"
      )

      result = service.send(:parse_response, response)

      _(result[:success]).must_equal false
      _(result[:error]).must_match(/HTTP 400/)
    end
  end
end
