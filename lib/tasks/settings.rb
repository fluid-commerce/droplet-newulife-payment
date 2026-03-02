module Tasks
  class Settings
    class << self
      def create_defaults
        create_host_server_setting
        create_fluid_api_setting
        create_droplet_setting
        create_marketplace_page_setting
        create_details_page_setting
        create_service_operational_countries_setting
        create_categories_setting
      end


      def remove_defaults
        Setting.where(name: %w[
          fluid_api
          droplet
          marketplace_page
          details_page
          service_operational_countries
        ]).delete_all
      end

    private

      def create_host_server_setting
        Setting.find_or_create_by!(name: "host_server") do |setting|
          setting.description = "Settings for the hosting server"
          setting.schema = {
            type: "object",
            required: %w[ base_url ],
            properties: {
              base_url: { type: "string" },
            },
          }
          setting.values = {
            base_url: "http://localhost:3000",
          }
        end
      end

      def create_fluid_api_setting
        Setting.find_or_create_by!(name: "fluid_api") do |setting|
          setting.description = "Settings for the Fluid API"
          setting.schema = {
            type: "object",
            properties: {
              base_url: {
                type: "string",
                format: "uri",
              },
              api_key: {
                type: "string",
              },
            },
          }
          setting.values = {
            base_url: "https://api.fluid.app",
            api_key: "change-me",
          }
        end
      end

      def create_droplet_setting
        Setting.find_or_create_by!(name: "droplet") do |setting|
          setting.description = "General settings for the Droplet. " \
                                "The UUID is automatically set when the Droplet is created."
          setting.schema = {
            type: "object",
            required: %w[ name embed_url active ],
            properties: {
              name: {
                type: "string",
              },
              embed_url: {
                type: %w[string null],
              },
              uuid: {
                type: "string",
              },
              active: {
                type: "boolean",
              },
            },
          }
          setting.values = {
            name: "Placeholder",
            embed_url: "https://example.com",
            active: true,
          }
        end
      end

      def create_marketplace_page_setting
        Setting.find_or_create_by!(name: "marketplace_page") do |setting|
          setting.description = "Values for the Droplet Marketplace Page"
          setting.schema = {
            type: "object",
            required: [ "title" ],
            properties: {
              title: {
                type: "string",
              },
              logo_url: {
                type: %w[string null],
              },
              summary: {
                type: %w[string null],
              },
            },
          }
          setting.values = {
            title: "Placeholder",
          }
        end
      end

      def create_details_page_setting
        Setting.find_or_create_by!(name: "details_page") do |setting|
          setting.description = "Values for the Droplet Details Page"
          setting.schema = {
            type: "object",
            properties: {
              title: { type: "string" },
              logo_url: { type: %w[string null] },
              summary: { type: %w[string null] },
              features: {
                type: %w[array null],
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    summary: { type: %w[string null] },
                    details: { type: %w[string null] },
                    image_url: { type: %w[string null] },
                    video_url: { type: %w[string null] },
                  },
                  required: %w[name],
                },
              },
            },
            required: %w[title],
            }
          setting.values = {
            title: "Placeholder",
          }
        end
      end

      def create_service_operational_countries_setting
        Setting.find_or_create_by!(name: "service_operational_countries") do |setting|
          setting.description = "Countries where the service is operational (ISO Country Codes). " \
                                "Leave blank if the Droplet is available worldwide."
          setting.schema = {
            type: "object",
            properties: {
              countries: {
                type: "array",
                items: { type: "string" },
              },
            },
          }
          setting.values = {
            countries: [],
          }
        end
      end

      def create_categories_setting
        Setting.find_or_create_by!(name: "categories") do |setting|
          setting.description = "Categories for the Droplet"
          setting.schema = {
            type: "object",
            properties: {
              categories: {
                type: "array",
                items: { type: "string" },
              },
            },
          }
          setting.values = {
            categories: [
              "payments",
            ],
          }
        end
      end
    end
  end
end

namespace :settings do
  desc "Create default settings"
  task create_defaults: :environment do
    Tasks::Settings.create_defaults
  end

  desc "Remove default settings"
  task remove_defaults: :environment do
    Tasks::Settings.remove_defaults
  end
end
