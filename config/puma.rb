# https://devcenter.heroku.com/articles/deploying-rails-applications-with-the-puma-web-server

workers Integer(ENV["WEB_CONCURRENCY"] || 2)
threads_count = Integer(ENV["RAILS_MAX_THREADS"] || 5)
threads threads_count, threads_count

preload_app!

# Support IPv6 by binding to host `::` instead of `0.0.0.0`
port(ENV["PORT"] || 3000, "::")

enable_keep_alives(false) if respond_to?(:enable_keep_alives)

rackup      DefaultRackup if defined?(DefaultRackup)
environment ENV["RACK_ENV"] || "development"

on_worker_boot do
  ActiveRecord::Base.establish_connection
end

# Run the Solid Queue supervisor inside of Puma for single-server deployments
plugin :solid_queue if ENV["SOLID_QUEUE_IN_PUMA"]