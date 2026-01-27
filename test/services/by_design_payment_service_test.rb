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

  # Sample P2M webhook data for testing
  let(:sample_p2m_data) do
    {
      "order_reference" => "TKW2BRL2OP",
      "client_uuid" => "94d15bf3-0518-4a53-ab0b-e7b8c7d797e0",
      "invoice_number" => "NULF-CT:test123",
      "autoship_reference" => "G2XYS6ZBBZ",
      "completed_at" => "1767187441840"
    }
  end

  # Sample card details from load_funds_via_card webhook
  let(:sample_card_details) do
    {
      "card_number_last4" => "7999",
      "expiry_date" => "8/2029",
      "payment_instrument_uuid" => "50713565-6801-4064-b3a4-ea5a27bbab1c"
    }
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

  describe ".payment_type_checks" do
    it "identifies card payments" do
      _(ByDesignPaymentService.card_payment?("LOAD_FUNDS_VIA_CARD")).must_equal true
      _(ByDesignPaymentService.card_payment?("uwallet")).must_equal false
    end

    it "identifies cash payments" do
      _(ByDesignPaymentService.cash_payment?("LOAD_FUNDS_VIA_CASH")).must_equal true
      _(ByDesignPaymentService.cash_payment?("uwallet")).must_equal false
    end

    it "identifies wallet payments" do
      _(ByDesignPaymentService.wallet_payment?("uwallet")).must_equal true
      _(ByDesignPaymentService.wallet_payment?("UWALLET_TRANSFER")).must_equal true
      _(ByDesignPaymentService.wallet_payment?("LOAD_FUNDS_VIA_CARD")).must_equal false
    end

    it "identifies supported payment types" do
      _(ByDesignPaymentService.supported_payment_type?("LOAD_FUNDS_VIA_CARD")).must_equal true
      _(ByDesignPaymentService.supported_payment_type?("LOAD_FUNDS_VIA_CASH")).must_equal true
      _(ByDesignPaymentService.supported_payment_type?("uwallet")).must_equal true
      _(ByDesignPaymentService.supported_payment_type?("UWALLET_TRANSFER")).must_equal true
      _(ByDesignPaymentService.supported_payment_type?("UNKNOWN_TYPE")).must_equal false
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

    it "makes API call for successful card payments with correct fields" do
      payment_detail = {
        "type" => "LOAD_FUNDS_VIA_CARD",
        "amount" => "878.00",
        "id" => "EZC1236EQI",
        "status" => "Success",
        "order_reference" => "TKW2BRL2OP"
      }

      stub_request(:post, /\/api\/Personal\/Order\/Payment\/CreditCard\/Save/)
        .with { |request|
          body = JSON.parse(request.body)
          # Verify correct field mappings per API docs
          body["TransactionID"] == "TKW2BRL2OP" &&                    # order_reference
          body["ReferenceNumber"] == "EZC1236EQI" &&                  # payment_detail.id
          body["PaymentToken"] == "50713565-6801-4064-b3a4-ea5a27bbab1c" &&  # payment_instrument_uuid
          body["Last4CCNumber"] == "7999" &&                          # card_number_last4
          body["ExpirationDateMMYY"] == "0829" &&                     # expiry_date converted
          body["PersistentToken"] == "94d15bf3-0518-4a53-ab0b-e7b8c7d797e0" &&
          body["ProcessorSpecificDetail1"] == "NULF-CT:test123" &&    # invoice_number
          body["ProcessorSpecificDetail2"] == "G2XYS6ZBBZ" &&         # autoship_reference
          body["ProcessorSpecificDetail3"] == "load_funds_via_card" && # payment type (lowercase)
          body["ProcessorSpecificDetail4"] == "TKW2BRL2OP"            # order_reference
        }
        .to_return(
          status: 200,
          body: { "Result" => { "IsSuccessful" => true } }.to_json,
          headers: { "Content-Type" => "application/json" }
        )

      result = ByDesignPaymentService.record_payment(
        order_id: "12345",
        payment_detail: payment_detail,
        p2m_data: sample_p2m_data,
        card_details: sample_card_details,
        kyc_status: "APPROVE"
      )

      _(result[:success]).must_equal true
      _(result[:skipped]).must_be_nil
    end

    it "makes API call for wallet payments without card fields" do
      payment_detail = {
        "type" => "uwallet",
        "amount" => "2309.00",
        "id" => "VW1TMS2ZR6",
        "status" => "Success",
        "order_reference" => "TKW2BRL2OP"
      }

      stub_request(:post, /\/api\/Personal\/Order\/Payment\/CreditCard\/Save/)
        .with { |request|
          body = JSON.parse(request.body)
          # Wallet payments should NOT have card fields
          !body.key?("PaymentToken") &&
          !body.key?("Last4CCNumber") &&
          !body.key?("ExpirationDateMMYY") &&
          body["ProcessorSpecificDetail3"] == "uwallet"
        }
        .to_return(
          status: 200,
          body: { "Result" => { "IsSuccessful" => true } }.to_json,
          headers: { "Content-Type" => "application/json" }
        )

      result = ByDesignPaymentService.record_payment(
        order_id: "12345",
        payment_detail: payment_detail,
        p2m_data: sample_p2m_data,
        kyc_status: "APPROVE"
      )

      _(result[:success]).must_equal true
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
          "status" => "Success",
          "order_reference" => "TKW2BRL2OP"
        }
        card_details = {
          "card_number_last4" => "4242",
          "expiry_date" => "12/2025",
          "payment_instrument_uuid" => "abc-123-uuid"
        }
        p2m_data = { "order_reference" => "TKW2BRL2OP", "invoice_number" => "NULF-CT:test" }

        payload = service.send(:build_payment_payload, "12345", payment_detail, p2m_data, card_details, "APPROVE")

        _(payload[:PaymentToken]).must_equal "abc-123-uuid"
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
        p2m_data = { "order_reference" => "TKW2BRL2OP", "invoice_number" => "NULF-CT:test" }

        payload = service.send(:build_payment_payload, "12345", payment_detail, p2m_data, {}, "APPROVE")

        _(payload.key?(:PaymentToken)).must_equal false
        _(payload.key?(:Last4CCNumber)).must_equal false
        _(payload.key?(:ExpirationDateMMYY)).must_equal false
      end

      it "includes correct field mappings per API docs" do
        payment_detail = {
          "type" => "uwallet",
          "amount" => "100.00",
          "id" => "VW1TMS2ZR6",
          "status" => "Success",
          "order_reference" => "TKW2BRL2OP"
        }
        p2m_data = {
          "order_reference" => "TKW2BRL2OP",
          "client_uuid" => "94d15bf3-0518-4a53-ab0b-e7b8c7d797e0",
          "invoice_number" => "NULF-CT:test123",
          "autoship_reference" => "G2XYS6ZBBZ"
        }

        payload = service.send(:build_payment_payload, "12345", payment_detail, p2m_data, {}, "APPROVE")

        # Required fields
        _(payload[:OrderID]).must_equal 12345
        _(payload[:CreditCardAccountId]).must_equal 30
        _(payload[:PaymentDate]).wont_be_nil

        # Transaction identifiers (per API docs)
        _(payload[:TransactionID]).must_equal "TKW2BRL2OP"      # order_reference
        _(payload[:ReferenceNumber]).must_equal "VW1TMS2ZR6"    # payment_detail.id

        # Token fields
        _(payload[:PersistentToken]).must_equal "94d15bf3-0518-4a53-ab0b-e7b8c7d797e0"
        _(payload[:ProfileIDUsedForProcessor]).must_equal "94d15bf3-0518-4a53-ab0b-e7b8c7d797e0"

        # Processor-specific fields
        _(payload[:ProcessorSpecificDetail1]).must_equal "NULF-CT:test123"  # invoice_number
        _(payload[:ProcessorSpecificDetail2]).must_equal "G2XYS6ZBBZ"       # autoship_reference
        _(payload[:ProcessorSpecificDetail3]).must_equal "uwallet"          # payment type (lowercase)
        _(payload[:ProcessorSpecificDetail4]).must_equal "TKW2BRL2OP"       # order_reference
      end

      it "uses promissory amount for Pending payments" do
        payment_detail = {
          "type" => "uwallet",
          "amount" => "100.00",
          "id" => "PAY123",
          "status" => "Pending"
        }
        p2m_data = { "invoice_number" => "NULF-CT:test" }

        payload = service.send(:build_payment_payload, "12345", payment_detail, p2m_data, {}, "APPROVE")

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
        p2m_data = { "invoice_number" => "NULF-CT:test" }

        payload = service.send(:build_payment_payload, "12345", payment_detail, p2m_data, {}, "APPROVE")

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
        p2m_data = { "invoice_number" => "NULF-CT:test" }

        payload = service.send(:build_payment_payload, "12345", payment_detail, p2m_data, {}, "APPROVE")

        _(payload[:Amount]).must_equal 0
        _(payload[:PromissoryAmount]).must_equal 50.0
        _(payload[:PaymentStatusTypeID]).must_equal 6  # Pending
        _(payload[:ProcessorSpecificDetail3]).must_equal "load_funds_via_cash"
      end
    end

    describe "#extract_last4_for_card" do
      it "extracts card_number_last4 from card_details" do
        result = service.send(:extract_last4_for_card, { "card_number_last4" => "7999" })
        _(result).must_equal "7999"
      end

      it "falls back to last4 field" do
        result = service.send(:extract_last4_for_card, { "last4" => "4242" })
        _(result).must_equal "4242"
      end

      it "returns nil when no data available" do
        result = service.send(:extract_last4_for_card, {})
        _(result).must_be_nil
      end
    end

    describe "#extract_expiry_for_card" do
      it "parses expiry_date in M/YYYY format" do
        result = service.send(:extract_expiry_for_card, { "expiry_date" => "8/2029" })
        _(result).must_equal "0829"
      end

      it "parses expiry_date in MM/YY format" do
        result = service.send(:extract_expiry_for_card, { "expiry_date" => "12/25" })
        _(result).must_equal "1225"
      end

      it "uses expiry_month and expiry_year fields" do
        result = service.send(:extract_expiry_for_card, { "expiry_month" => "3", "expiry_year" => "2028" })
        _(result).must_equal "0328"
      end

      it "returns nil when no expiry data" do
        result = service.send(:extract_expiry_for_card, {})
        _(result).must_be_nil
      end
    end

    describe "#extract_payment_token" do
      it "extracts payment_instrument_uuid" do
        result = service.send(:extract_payment_token, { "payment_instrument_uuid" => "abc-123-uuid" })
        _(result).must_equal "abc-123-uuid"
      end

      it "returns nil when no uuid available" do
        result = service.send(:extract_payment_token, {})
        _(result).must_be_nil
      end
    end

    describe "#normalize_payment_type" do
      it "converts payment type to lowercase" do
        _(service.send(:normalize_payment_type, "LOAD_FUNDS_VIA_CARD")).must_equal "load_funds_via_card"
        _(service.send(:normalize_payment_type, "UWALLET_TRANSFER")).must_equal "uwallet_transfer"
        _(service.send(:normalize_payment_type, "uwallet")).must_equal "uwallet"
      end

      it "returns nil for blank input" do
        _(service.send(:normalize_payment_type, nil)).must_be_nil
        _(service.send(:normalize_payment_type, "")).must_be_nil
      end
    end

    describe "#payment_date" do
      it "converts completed_at timestamp to ISO8601" do
        p2m_data = { "completed_at" => "1767187441840" }
        result = service.send(:payment_date, p2m_data)
        # Should be a valid ISO8601 date string
        _(result).must_match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
      end

      it "returns current time when completed_at is missing" do
        result = service.send(:payment_date, {})
        _(result).must_match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
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
