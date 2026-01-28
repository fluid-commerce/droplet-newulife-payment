# Container VM module with Compute Engine instance
module "gce-container" {
  source  = "terraform-google-modules/container-vm/google"
  version = "~> 3.2"

  container = {
    image = var.container_image
    command = [
      "bash"
    ]
    args = [
      "-c",
      "sleep infinity"
    ]
    env = [
      {
        name  = "RAILS_MASTER_KEY"
        value = var.container_rails_master_key
      },
      {
        name  = "RAILS_ENV"
        value = "production"
      },
      {
        name  = "RACK_ENV"
        value = "production"
      },
      {
        name  = "RAILS_LOG_TO_STDOUT"
        value = "true"
      },
      {
        name  = "DATABASE_URL"
        value = var.container_db_url_production
      },
      {
        name  = "QUEUE_DATABASE_URL"
        value = var.container_db_url_production_queue
      },
      {
        name  = "CACHE_DATABASE_URL"
        value = var.container_db_url_production_cache
      },
      {
        name  = "CABLE_DATABASE_URL"
        value = var.container_db_url_production_cable
      }
    ]
  }

  restart_policy = "Always"
}
