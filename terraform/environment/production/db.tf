# Cloud SQL PostgreSQL instance
module "postgres_db_instance" {
  source = "../../modules/cloud_sql_postgres"

  instance_name    = var.postgres_name_instance
  database_version = "POSTGRES_17"
  region           = var.region

  edition = "ENTERPRISE"

  tier              = "db-g1-small" # the machine type to use
  disk_size         = 10
  high_availability = false

  # labels for the instance
  project     = var.project
  environment = var.environment

  # IP configuration for the instance
  ipv4_enabled = var.postgres_ip_public_database
  private_network_database = var.postgres_private_network
}

# Cloud SQL PostgreSQL databases
resource "google_sql_database" "database_production" {
  name     = var.postgres_name_database
  instance = module.postgres_db_instance.db_instance_name
}

resource "google_sql_database" "database_production_queue" {
  name     = "${var.postgres_name_database}_queue"
  instance = module.postgres_db_instance.db_instance_name
}

resource "google_sql_database" "database_production_cache" {
  name     = "${var.postgres_name_database}_cache"
  instance = module.postgres_db_instance.db_instance_name
}

resource "google_sql_database" "database_production_cable" {
  name     = "${var.postgres_name_database}_cable"
  instance = module.postgres_db_instance.db_instance_name
}

resource "google_sql_user" "users" {
  name     = var.postgres_user_name
  instance = module.postgres_db_instance.db_instance_name
  password = var.postgres_password_production_user
}
