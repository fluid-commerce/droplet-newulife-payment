require "test_helper"

describe Setting do
  describe "validations" do
    it "is invalid without a name" do
      setting = Setting.new(schema: {}, values: {})
      _(setting.valid?).must_equal false
    end

    it "is invalid with a duplicate name" do
      Setting.create(name: "duplicate", schema: {}, values: {})
      setting = Setting.new(name: "duplicate", schema: {}, values: {})

      _(setting.valid?).must_equal false
    end

    it "is valid with a unique name" do
      setting = Setting.new(name: "unique", schema: {}, values: {})

      _(setting.valid?).must_equal true
    end

    it "is invalid without a schema" do
      setting = Setting.new(name: "invalid", values: {})

      _(setting.valid?).must_equal false
      _(setting.errors.to_hash[:schema]).must_equal([ "is missing" ])
    end

    it "is invalid with an invalid schema" do
      invalid_schema = {
        type: "object",
        properties: {
          age: { type: "integer", maximum: "one hundred" },
        },
        required: "age",
      }
      setting = Setting.new(name: "invalid", schema: invalid_schema, values: {})

      _(setting.valid?).must_equal false
      _(setting.errors.to_hash[:schema]).must_equal([
        "value at `/properties/age/maximum` is not a number",
        "value at `/required` is not an array",
      ])
    end

    it "is invalid if the values do not match the schema" do
      schema = {
        type: "object",
        properties: {
          age: { type: "integer" },
          email: { type: "string", format: "email" },
        },
        required: %w[age email],
      }
      values = { email: "not an email" }
      setting = Setting.new(name: "invalid", schema: schema, values: values)

      _(setting.valid?).must_equal false
      _(setting.errors.to_hash[:values]).must_equal([
        "value at `/email` does not match format: email",
        "object at root is missing required properties: age",
      ])
    end

    it "is valid with a valid schema and values that match the schema" do
      setting = Setting.marketplace_page
      setting.values = {
        title: "Droplet Name",
        summary: "What the droplet is for",
        logo_url: "https://example.com/logo.png",
      }
      _(setting.valid?).must_equal true
    end

    it "finds by the method name at the class level" do
      _(Setting.droplet).must_equal Setting.find_by(name: "droplet")
    end

    it "uses the method name as a key to the values at the instance level" do
      Tasks::Settings.create_defaults
      _(Setting.fluid_api.base_url).must_equal "https://api.fluid.app"
    end
  end
end
