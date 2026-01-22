require "test_helper"


describe WebhooksController do
  fixtures(:companies)

  describe "company_droplet events" do
    it "handles company_droplet uninstalled event with valid authentication token in header" do
      company = companies(:acme)
      post webhook_url, params: {
        resource: "droplet",
        event: "uninstalled",
        company: {
          company_droplet_uuid: company.company_droplet_uuid,
          fluid_company_id: company.fluid_company_id,
        },
      }, headers: { "AUTH_TOKEN" => company.webhook_verification_token }, as: :json

      _(response.status).must_equal 202

      perform_enqueued_jobs

      company.reload
      _(company.uninstalled_at).wont_be_nil
    end

    it "handles company_droplet installed event with valid token" do
      # First mark the company as uninstalled
      company = companies(:acme)
      company.update(uninstalled_at: Time.current)

      post webhook_url, params: {
        resource: "droplet",
        event: "installed",
        company: {
          fluid_shop: company.fluid_shop,
          droplet_uuid: company.company_droplet_uuid,
          fluid_company_id: company.fluid_company_id,
          webhook_verification_token: company.webhook_verification_token,
        },
      }, headers: { "AUTH_TOKEN" => company.webhook_verification_token }, as: :json

      _(response.status).must_equal 202

      perform_enqueued_jobs

      company.reload
      _(company.uninstalled_at).must_be_nil
    end

    it "rejects event when webhook verification token is invalid" do
      company = companies(:acme)
      post webhook_url, params: {
        resource: "droplet",
        event: "uninstalled",
        company: {
          company_droplet_uuid: company.company_droplet_uuid,
          fluid_company_id: company.fluid_company_id,
          webhook_verification_token: "invalid-token",
        },
      }, headers: { "AUTH_TOKEN" => "invalid-token" }, as: :json

      _(response.status).must_equal 401
      _(JSON.parse(response.body)["error"]).must_equal "Unauthorized"
    end

    it "rejects event when authentication token in header is invalid" do
      company = companies(:acme)
      post webhook_url, params: {
        resource: "droplet",
        event: "uninstalled",
        company: {
          company_droplet_uuid: company.company_droplet_uuid,
          fluid_company_id: company.fluid_company_id,
        },
      }, headers: { "AUTH_TOKEN" => "invalid-token" }, as: :json

      _(response.status).must_equal 401
      _(JSON.parse(response.body)["error"]).must_equal "Unauthorized"
    end

    it "returns 404 when company is not found" do
      post webhook_url, params: {
        resource: "droplet",
        event: "uninstalled",
        company: {
          company_droplet_uuid: "non-existent-uuid",
          fluid_company_id: 999999,
          webhook_verification_token: "any-token",
        },
      }, headers: { "AUTH_TOKEN" => "any-token" }, as: :json

      _(response.status).must_equal 404
      _(JSON.parse(response.body)["error"]).must_equal "Company not found"
    end

    it "relies on company payload for authentication if auth token is not provided" do
      company = companies(:acme)
      post webhook_url, params: {
        resource: "droplet",
        event: "uninstalled",
        company: {
          company_droplet_uuid: company.company_droplet_uuid,
          fluid_company_id: company.fluid_company_id,
          webhook_verification_token: company.webhook_verification_token,
        },
      }, as: :json

      _(response.status).must_equal 202

      perform_enqueued_jobs

      company.reload
      _(company.uninstalled_at).wont_be_nil
    end
  end

  describe "unknown events" do
    it "handles unknown event types with no content" do
      company = companies(:acme)

      post webhook_url, params: {
        resource: "unknown_resource",
        event: "unknown_event",
        company: {
          company_droplet_uuid: company.company_droplet_uuid,
          fluid_company_id: company.fluid_company_id,
          webhook_verification_token: company.webhook_verification_token,
        },
      }, as: :json

      _(response.status).must_equal 204
    end
  end
end
