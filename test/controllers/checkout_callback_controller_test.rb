require "test_helper"

describe CheckoutCallbackController do
  describe "payment_account_uuid" do
    # Helper to build a controller instance with real params parsing
    # (goes through actual callback_params strong parameters)
    def build_controller_with_params(payment_account_id:, available_payment_methods: nil)
      controller = CheckoutCallbackController.new

      raw_params = {
        payment_account_id: payment_account_id,
        cart: {
          cart_token: "ct_test123",
          amount_total: "100.00",
          tax_total: "10.00",
          currency_code: "USD",
          email: "test@example.com",
          ship_to: {
            first_name: "Test", last_name: "User",
            address1: "123 Main St", city: "Anytown", state: "CA",
            postal_code: "90210", country_code: "US",
            email: "test@example.com", name: "Test User",
          },
          items: [
            { product_title: "Test Product", quantity: 1, price: "100.00", product: { sku: "SKU1" } },
          ],
        },
      }

      # Only include available_payment_methods if explicitly provided
      # This lets us test backward compat (old payloads that don't include this field)
      if available_payment_methods
        raw_params[:cart][:available_payment_methods] = available_payment_methods
      end

      controller.define_singleton_method(:params) do
        ActionController::Parameters.new(raw_params)
      end

      controller
    end

    # === Backward compatibility: old behavior (before this PR) ===
    # These tests ensure that when available_payment_methods is NOT in the payload
    # (like it was before this change), the numeric ID is passed through unchanged.

    describe "backward compatibility (no available_payment_methods in payload)" do
      it "returns the numeric ID unchanged when available_payment_methods is absent" do
        controller = build_controller_with_params(
          payment_account_id: "52246"
        )
        _(controller.send(:payment_account_uuid)).must_equal "52246"
      end

      it "returns the numeric ID unchanged when available_payment_methods is empty" do
        controller = build_controller_with_params(
          payment_account_id: "52246",
          available_payment_methods: []
        )
        _(controller.send(:payment_account_uuid)).must_equal "52246"
      end

      it "returns the numeric ID when no matching payment method exists" do
        controller = build_controller_with_params(
          payment_account_id: "99999",
          available_payment_methods: [{ id: "52246", uuid: "pa_abc123def456" }]
        )
        _(controller.send(:payment_account_uuid)).must_equal "99999"
      end
    end

    # === New behavior: UUID resolution ===
    # These tests verify the new UUID resolution works when available_payment_methods
    # is present in the callback payload.

    describe "UUID resolution from available_payment_methods" do
      it "resolves UUID when numeric ID matches an available payment method" do
        controller = build_controller_with_params(
          payment_account_id: "52246",
          available_payment_methods: [
            { id: "52246", uuid: "pa_25fownp1h5y6dh4jdiztqjdhupm5ei0u0" },
          ]
        )
        _(controller.send(:payment_account_uuid)).must_equal "pa_25fownp1h5y6dh4jdiztqjdhupm5ei0u0"
      end

      it "resolves UUID when payment_account_id is already a UUID format" do
        controller = build_controller_with_params(
          payment_account_id: "pa_25fownp1h5y6dh4jdiztqjdhupm5ei0u0",
          available_payment_methods: [
            { id: "52246", uuid: "pa_25fownp1h5y6dh4jdiztqjdhupm5ei0u0" },
          ]
        )
        _(controller.send(:payment_account_uuid)).must_equal "pa_25fownp1h5y6dh4jdiztqjdhupm5ei0u0"
      end

      it "picks the correct method from multiple available payment methods" do
        controller = build_controller_with_params(
          payment_account_id: "52247",
          available_payment_methods: [
            { id: "52246", uuid: "pa_first" },
            { id: "52247", uuid: "pa_second" },
            { id: "52248", uuid: "pa_third" },
          ]
        )
        _(controller.send(:payment_account_uuid)).must_equal "pa_second"
      end
    end

    # === Edge cases and safety ===

    describe "edge cases" do
      it "returns nil when payment_account_id is nil" do
        controller = build_controller_with_params(
          payment_account_id: nil,
          available_payment_methods: [{ id: "52246", uuid: "pa_abc123def456" }]
        )
        _(controller.send(:payment_account_uuid)).must_be_nil
      end

      it "returns nil when payment_account_id is empty string" do
        controller = build_controller_with_params(
          payment_account_id: "",
          available_payment_methods: []
        )
        _(controller.send(:payment_account_uuid)).must_be_nil
      end
    end

    # === Security: input validation ===

    describe "input validation" do
      it "rejects path traversal in UUID and falls back to numeric_id" do
        controller = build_controller_with_params(
          payment_account_id: "52246",
          available_payment_methods: [
            { id: "52246", uuid: "../../admin/evil" },
          ]
        )
        _(controller.send(:payment_account_uuid)).must_equal "52246"
      end

      it "rejects UUIDs with special characters" do
        controller = build_controller_with_params(
          payment_account_id: "52246",
          available_payment_methods: [
            { id: "52246", uuid: "pa_valid; DROP TABLE" },
          ]
        )
        _(controller.send(:payment_account_uuid)).must_equal "52246"
      end

      it "accepts valid pa_ prefixed UUIDs" do
        controller = build_controller_with_params(
          payment_account_id: "52246",
          available_payment_methods: [
            { id: "52246", uuid: "pa_abc123def456xyz" },
          ]
        )
        _(controller.send(:payment_account_uuid)).must_equal "pa_abc123def456xyz"
      end
    end

    # === Integration: verify UUID flows into redirect URL ===

    describe "integration with UPaymentsOrderPayloadGenerator" do
      it "UUID is included in the redirect URL when resolved" do
        payload = UPaymentsOrderPayloadGenerator.generate_order_payload(
          cart: {
            cart_token: "ct_test123",
            amount_total: "100.00",
            tax_total: "10.00",
            currency_code: "USD",
            language_iso: "en",
            ship_to: {
              address1: "123 Main St", address2: "", city: "LA", state: "CA",
              country_code: "US", email: "t@t.com", name: "Test", postal_code: "90210",
            },
            items: [{ product_title: "P", quantity: 1, price: "100.00", product: { sku: "S1" } }],
          },
          external_id: "C123",
          payment_account_id: "pa_25fownp1h5y6dh4jdiztqjdhupm5ei0u0"
        )

        _(payload[:redirectUrl]).must_include "payment_account/pa_25fownp1h5y6dh4jdiztqjdhupm5ei0u0"
      end

      it "numeric ID is included in the redirect URL as fallback" do
        payload = UPaymentsOrderPayloadGenerator.generate_order_payload(
          cart: {
            cart_token: "ct_test123",
            amount_total: "100.00",
            tax_total: "10.00",
            currency_code: "USD",
            language_iso: "en",
            ship_to: {
              address1: "123 Main St", address2: "", city: "LA", state: "CA",
              country_code: "US", email: "t@t.com", name: "Test", postal_code: "90210",
            },
            items: [{ product_title: "P", quantity: 1, price: "100.00", product: { sku: "S1" } }],
          },
          external_id: "C123",
          payment_account_id: "52246"
        )

        _(payload[:redirectUrl]).must_include "payment_account/52246"
      end
    end
  end
end
