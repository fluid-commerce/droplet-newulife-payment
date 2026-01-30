source "https://rubygems.org"

ruby "3.4.2"
gem "bundler", "~> 2.6.5"
gem "rails", "~> 8.0.2"

gem "cancancan", "~> 3.6"
gem "bootsnap", require: false
gem "devise", "~> 4.9"
gem "httparty", "~> 0.23.1"
gem "jbuilder"
gem "json_schemer", "~> 2.4"
gem "kamal", require: false
gem "minitest-rails", "~> 8.0.0"
gem "pg", "~> 1.1"
gem "propshaft"
gem "puma", ">= 5.0"
gem "sentry-rails"
gem "solid_cable"
gem "solid_cache"
gem "solid_queue"
gem "thruster", require: false
gem "vite_rails", "~> 3.0", ">= 3.0.19"
gem "mission_control-jobs"
gem "httplog"

group :development, :test do
  gem "brakeman", require: false
  gem "debug", platforms: %i[ mri windows ], require: "debug/prelude"
  gem "pry-nav", "~> 1.0.0"
  gem "pry-rails", "~> 0.3.9"
  gem "rubocop", require: false
  gem "rubocop-performance", require: false
  gem "rubocop-rails", require: false
  gem "rubocop-rails-omakase", require: false
end

group :development do
  gem "web-console"
end

group :test do
  gem "capybara"
  gem "selenium-webdriver"
  gem "webmock"
end

gem "dotenv", "~> 3.1"
gem "jwt", "~> 2.10"
