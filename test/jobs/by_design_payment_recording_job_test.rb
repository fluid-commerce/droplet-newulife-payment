require "test_helper"
require "webmock/minitest"

describe ByDesignPaymentRecordingJob do
  include ActiveJob::TestHelper

  before do
    MoolaPayment.delete_all
    ENV["BY_DESIGN_API_URL"] = "https://api.bydesign.test"
    ENV["BY_DESIGN_INTEGRATION_USERNAME"] = "test_user"
    ENV["BY_DESIGN_INTEGRATION_PASSWORD"] = "test_pass"
    WebMock.disable_net_connect!(allow_localhost: false)
  end

  after do
    WebMock.reset!
  end

  describe "#perform" do
    it "records payment to ByDesign successfully" do
      payment = MoolaPayment.create!(
        cart_token: "test-cart",
        invoice_number: "NULF-CT:test-cart",
        bydesign_order_id: "12345",
        kyc_status: "APPROVE",
        payment_details: [
          { "type" => "uwallet", "amount" => "100.00", "id" => "PAY123", "status" => "Success" }
        ],
        status: :matched
      )

      stub_request(:post, /\/api\/Personal\/Order\/Payment\/CreditCard\/Save/)
        .to_return(
          status: 200,
          body: { "Result" => { "IsSuccessful" => true } }.to_json,
          headers: { "Content-Type" => "application/json" }
        )

      ByDesignPaymentRecordingJob.perform_now(payment.id)

      payment.reload
      _(payment.status).must_equal "recorded"
      _(payment.recorded_at).wont_be_nil
    end

    it "skips recording when payment not ready" do
      payment = MoolaPayment.create!(
        cart_token: "not-ready",
        invoice_number: "NULF-CT:not-ready",
        status: :pending
      )

      # No HTTP request should be made
      ByDesignPaymentRecordingJob.perform_now(payment.id)

      payment.reload
      _(payment.status).must_equal "pending"
    end

    it "filters out declined payments before recording" do
      payment = MoolaPayment.create!(
        cart_token: "mixed-payments",
        invoice_number: "NULF-CT:mixed-payments",
        bydesign_order_id: "12345",
        kyc_status: "APPROVE",
        payment_details: [
          { "type" => "uwallet", "amount" => "100.00", "id" => "PAY1", "status" => "Success" },
          { "type" => "uwallet", "amount" => "50.00", "id" => "PAY2", "status" => "Declined" }
        ],
        status: :matched
      )

      # Only one API call should be made (for PAY1, not PAY2)
      stub = stub_request(:post, /\/api\/Personal\/Order\/Payment\/CreditCard\/Save/)
        .to_return(
          status: 200,
          body: { "Result" => { "IsSuccessful" => true } }.to_json,
          headers: { "Content-Type" => "application/json" }
        )

      ByDesignPaymentRecordingJob.perform_now(payment.id)

      # Verify only one request was made
      assert_requested(stub, times: 1)

      payment.reload
      _(payment.status).must_equal "recorded"
    end

    it "handles all payments declined scenario" do
      payment = MoolaPayment.create!(
        cart_token: "all-declined",
        invoice_number: "NULF-CT:all-declined",
        bydesign_order_id: "12345",
        kyc_status: "APPROVE",
        payment_details: [
          { "type" => "uwallet", "amount" => "100.00", "id" => "PAY1", "status" => "Declined" }
        ],
        status: :matched
      )

      # No HTTP request should be made
      ByDesignPaymentRecordingJob.perform_now(payment.id)

      payment.reload
      _(payment.status).must_equal "recorded"
    end

    it "handles API failure and increments attempts" do
      payment = MoolaPayment.create!(
        cart_token: "api-fail",
        invoice_number: "NULF-CT:api-fail",
        bydesign_order_id: "12345",
        kyc_status: "APPROVE",
        payment_details: [
          { "type" => "uwallet", "amount" => "100.00", "id" => "PAY123", "status" => "Success" }
        ],
        status: :matched
      )

      stub_request(:post, /\/api\/Personal\/Order\/Payment\/CreditCard\/Save/)
        .to_return(
          status: 200,
          body: { "Result" => { "IsSuccessful" => false, "Message" => "Order not found" } }.to_json,
          headers: { "Content-Type" => "application/json" }
        )

      # API returns failure - job handles gracefully, increments attempts, stays matched
      ByDesignPaymentRecordingJob.perform_now(payment.id)

      payment.reload
      _(payment.bydesign_recording_attempts).must_equal 1
      _(payment.last_error).must_match(/Order not found/)
      _(payment.status).must_equal "matched"  # Still matched for retry
    end

    it "marks payment as failed after max attempts" do
      payment = MoolaPayment.create!(
        cart_token: "max-fail",
        invoice_number: "NULF-CT:max-fail",
        bydesign_order_id: "12345",
        kyc_status: "APPROVE",
        payment_details: [
          { "type" => "uwallet", "amount" => "100.00", "id" => "PAY123", "status" => "Success" }
        ],
        status: :matched,
        bydesign_recording_attempts: 4  # One below max
      )

      stub_request(:post, /\/api\/Personal\/Order\/Payment\/CreditCard\/Save/)
        .to_return(
          status: 200,
          body: { "Result" => { "IsSuccessful" => false, "Message" => "Persistent error" } }.to_json,
          headers: { "Content-Type" => "application/json" }
        )

      # Should fail on this attempt (5th) and mark as failed
      ByDesignPaymentRecordingJob.perform_now(payment.id)

      payment.reload
      _(payment.status).must_equal "failed"
      _(payment.bydesign_recording_attempts).must_equal 5
    end

    it "passes kyc_status to service for LOAD_FUNDS_VIA_CASH" do
      payment = MoolaPayment.create!(
        cart_token: "kyc-test",
        invoice_number: "NULF-CT:kyc-test",
        bydesign_order_id: "12345",
        kyc_status: "APPROVE",
        payment_details: [
          { "type" => "LOAD_FUNDS_VIA_CASH", "amount" => "100.00", "id" => "PAY123", "status" => "Success" }
        ],
        status: :matched
      )

      # Capture the request body to verify kyc_status is being used
      request_body = nil
      stub_request(:post, /\/api\/Personal\/Order\/Payment\/CreditCard\/Save/)
        .with { |request| request_body = JSON.parse(request.body); true }
        .to_return(
          status: 200,
          body: { "Result" => { "IsSuccessful" => true } }.to_json,
          headers: { "Content-Type" => "application/json" }
        )

      ByDesignPaymentRecordingJob.perform_now(payment.id)

      # LOAD_FUNDS_VIA_CASH should always be Pending (status 6)
      _(request_body["PaymentStatusTypeID"]).must_equal 6
      # Amount should be 0, PromissoryAmount should be 100
      _(request_body["Amount"]).must_equal 0
      _(request_body["PromissoryAmount"]).must_equal 100.0
    end

    it "records multiple payments" do
      payment = MoolaPayment.create!(
        cart_token: "multi-pay",
        invoice_number: "NULF-CT:multi-pay",
        bydesign_order_id: "12345",
        kyc_status: "APPROVE",
        payment_details: [
          { "type" => "uwallet", "amount" => "50.00", "id" => "PAY1", "status" => "Success" },
          { "type" => "LOAD_FUNDS_VIA_CARD", "amount" => "50.00", "id" => "PAY2", "status" => "Success" }
        ],
        card_details: { "card_number_last4" => "4242", "expiry_date" => "12/2025", "payment_instrument_uuid" => "abc-uuid" },
        status: :matched
      )

      stub = stub_request(:post, /\/api\/Personal\/Order\/Payment\/CreditCard\/Save/)
        .to_return(
          status: 200,
          body: { "Result" => { "IsSuccessful" => true } }.to_json,
          headers: { "Content-Type" => "application/json" }
        )

      ByDesignPaymentRecordingJob.perform_now(payment.id)

      # Two API calls should be made
      assert_requested(stub, times: 2)

      payment.reload
      _(payment.status).must_equal "recorded"
    end

    it "sends correct P2M data field mappings per API docs" do
      payment = MoolaPayment.create!(
        cart_token: "p2m-mapping-test",
        invoice_number: "NULF-CT:p2m-mapping-test",
        bydesign_order_id: "12345",
        kyc_status: "APPROVE",
        payment_details: [
          { "type" => "uwallet", "amount" => "100.00", "id" => "VW1TMS2ZR6", "status" => "Success", "order_reference" => "TKW2BRL2OP" }
        ],
        moola_webhook_payload: {
          "order_reference" => "TKW2BRL2OP",
          "client_uuid" => "94d15bf3-0518-4a53-ab0b-e7b8c7d797e0",
          "autoship_reference" => "G2XYS6ZBBZ",
          "completed_at" => "1767187441840"
        },
        status: :matched
      )

      request_body = nil
      stub_request(:post, /\/api\/Personal\/Order\/Payment\/CreditCard\/Save/)
        .with { |request| request_body = JSON.parse(request.body); true }
        .to_return(
          status: 200,
          body: { "Result" => { "IsSuccessful" => true } }.to_json,
          headers: { "Content-Type" => "application/json" }
        )

      ByDesignPaymentRecordingJob.perform_now(payment.id)

      # Verify correct field mappings per API documentation
      _(request_body["TransactionID"]).must_equal "TKW2BRL2OP"              # order_reference
      _(request_body["ReferenceNumber"]).must_equal "VW1TMS2ZR6"            # payment_detail.id
      _(request_body["PersistentToken"]).must_equal "94d15bf3-0518-4a53-ab0b-e7b8c7d797e0"
      _(request_body["ProfileIDUsedForProcessor"]).must_equal "94d15bf3-0518-4a53-ab0b-e7b8c7d797e0"
      _(request_body["ProcessorSpecificDetail1"]).must_equal "NULF-CT:p2m-mapping-test"  # invoice_number
      _(request_body["ProcessorSpecificDetail2"]).must_equal "G2XYS6ZBBZ"   # autoship_reference
      _(request_body["ProcessorSpecificDetail3"]).must_equal "uwallet"      # payment type (lowercase)
      _(request_body["ProcessorSpecificDetail4"]).must_equal "TKW2BRL2OP"   # order_reference
    end

    it "sends correct card fields for LOAD_FUNDS_VIA_CARD payments" do
      payment = MoolaPayment.create!(
        cart_token: "card-mapping-test",
        invoice_number: "NULF-CT:card-mapping-test",
        bydesign_order_id: "12345",
        kyc_status: "APPROVE",
        payment_details: [
          { "type" => "LOAD_FUNDS_VIA_CARD", "amount" => "878.00", "id" => "EZC1236EQI", "status" => "Success", "order_reference" => "TKW2BRL2OP" }
        ],
        card_details: {
          "card_number_last4" => "7999",
          "expiry_date" => "8/2029",
          "payment_instrument_uuid" => "50713565-6801-4064-b3a4-ea5a27bbab1c"
        },
        moola_webhook_payload: {
          "order_reference" => "TKW2BRL2OP",
          "client_uuid" => "94d15bf3-0518-4a53-ab0b-e7b8c7d797e0"
        },
        status: :matched
      )

      request_body = nil
      stub_request(:post, /\/api\/Personal\/Order\/Payment\/CreditCard\/Save/)
        .with { |request| request_body = JSON.parse(request.body); true }
        .to_return(
          status: 200,
          body: { "Result" => { "IsSuccessful" => true } }.to_json,
          headers: { "Content-Type" => "application/json" }
        )

      ByDesignPaymentRecordingJob.perform_now(payment.id)

      # Verify card-specific fields per API documentation
      _(request_body["PaymentToken"]).must_equal "50713565-6801-4064-b3a4-ea5a27bbab1c"  # payment_instrument_uuid
      _(request_body["Last4CCNumber"]).must_equal "7999"                                  # card_number_last4
      _(request_body["ExpirationDateMMYY"]).must_equal "0829"                            # expiry_date converted
      _(request_body["ProcessorSpecificDetail3"]).must_equal "load_funds_via_card"       # payment type (lowercase)
    end

    it "discards job when payment record not found" do
      # Should not raise error, just discard
      ByDesignPaymentRecordingJob.perform_now(999999)
      # Test passes if no exception is raised
      assert true
    end
  end
end
