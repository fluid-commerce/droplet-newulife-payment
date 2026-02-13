require "test_helper"
require "rake"

describe "moola_payments rake tasks" do
  before do
    MoolaPayment.delete_all
    # Load rake tasks only once
    @rake_loaded ||= begin
      Rake.application.rake_require("moola_payments", [ Rails.root.join("lib/tasks").to_s ])
      true
    end
    Rake::Task.define_task(:environment)
  end

  describe "moola_payments:recover_stuck" do
    it "recovers stuck payments" do
      stuck_payment = MoolaPayment.create!(
        cart_token: "rake-stuck",
        invoice_number: "NULF-CT:rake-stuck",
        kyc_status: "APPROVE",
        bydesign_order_id: "12345",
        payment_details: [ { "type" => "uwallet", "amount" => "100" } ],
        status: :recording
      )
      stuck_payment.update_columns(updated_at: 45.minutes.ago)

      # Capture output
      output = capture_io do
        Rake::Task["moola_payments:recover_stuck"].reenable
        Rake::Task["moola_payments:recover_stuck"].invoke
      end

      _(output.first).must_include "Recovered 1 stuck payment"
    end

    it "reports no stuck payments when none exist" do
      output = capture_io do
        Rake::Task["moola_payments:recover_stuck"].reenable
        Rake::Task["moola_payments:recover_stuck"].invoke
      end

      _(output.first).must_include "No stuck payments found"
    end
  end

  describe "moola_payments:status" do
    it "shows status summary" do
      MoolaPayment.create!(cart_token: "status-1", invoice_number: "NULF-CT:status-1", status: :pending)
      MoolaPayment.create!(cart_token: "status-2", invoice_number: "NULF-CT:status-2", status: :matched)
      MoolaPayment.create!(cart_token: "status-3", invoice_number: "NULF-CT:status-3", status: :recorded)

      output = capture_io do
        Rake::Task["moola_payments:status"].reenable
        Rake::Task["moola_payments:status"].invoke
      end

      _(output.first).must_include "MoolaPayment Status Summary"
      _(output.first).must_include "pending"
      _(output.first).must_include "matched"
      _(output.first).must_include "recorded"
      _(output.first).must_include "Total:"
    end
  end
end
