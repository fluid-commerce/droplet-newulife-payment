
# Compute Engine instance Jobs
module "rails_jobs" {
  source = "../../modules/compute_engine"

  vm_name                = var.vm_name
  machine_type           = var.machine_type
  zone                   = var.zone
  environment            = var.environment
  project                = var.project
  purpose_compute_engine = var.purpose_compute_engine

  email_service_account = var.email_service_account

  # Container variable values
  # Note: Database URLs are passed directly as they include the Cloud SQL proxy socket path
  container_image                   = var.container_image
  container_rails_master_key        = var.container_rails_master_key
  container_db_url_production       = var.container_db_url_production
  container_db_url_production_queue = var.container_db_url_production_queue
  container_db_url_production_cache = var.container_db_url_production_cache
  container_db_url_production_cable = var.container_db_url_production_cable
}
