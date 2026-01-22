require "test_helper"

describe FluidClient do
  describe "#payload" do
    it "returns a valid payload" do
      Tasks::Settings.create_defaults
      client = FluidClient.new

      _(client.droplets.payload).must_equal({
        "droplet" => {
          "name" => "Placeholder",
          "active" => true,
          "embed_url" => "https://example.com",
          "settings" => {
            "marketplace_page" => {
              "title" => "Placeholder",
            },
            "details_page" => {
              "title" => "Placeholder",
            },
            "service_operational_countries" => [],
          },
          "categories" => ["payments"],
        },
      })
    end
  end
end
