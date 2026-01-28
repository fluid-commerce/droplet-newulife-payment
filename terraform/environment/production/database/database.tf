# fluid-droplet-newulife-payment - database configuration
# Uses shared fluid-studioz Cloud SQL instance in europe-west1

locals {
  application_name               = "fluid-droplet-newulife-payment"
  postgres_name_database         = "newulife_payment"
  database_user_name             = "newulife_payment_user"
  secret_name_database_url_prefix = "NEWULIFE_PAYMENT"
  cloud_sql_instance             = "fluid-studioz"
  cloud_sql_connection           = "fluid-417204:europe-west1:fluid-studioz"
}

terraform {
  required_version = "1.11.4"

  backend "gcs" {
    bucket = "fluid-terraform"
    prefix = "fluid-droplet-newulife-payment/production/database"
  }

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "6.47.0"
    }
  }
}

provider "google" {
  project = "fluid-417204"
  region  = "europe-west1"
}

# Generate a random password for the database user
resource "random_password" "database_user_password" {
  length  = 32
  special = false
  upper   = true
  lower   = true
  numeric = true
}

# Database user creation
resource "google_sql_user" "database_user" {
  name     = local.database_user_name
  instance = local.cloud_sql_instance
  password = random_password.database_user_password.result
}

# Create databases within the Cloud SQL instance
resource "google_sql_database" "database" {
  name     = local.postgres_name_database
  instance = local.cloud_sql_instance
}

resource "google_sql_database" "database_cache" {
  name     = "${local.postgres_name_database}_cache"
  instance = local.cloud_sql_instance
}

resource "google_sql_database" "database_queue" {
  name     = "${local.postgres_name_database}_queue"
  instance = local.cloud_sql_instance
}

resource "google_sql_database" "database_cable" {
  name     = "${local.postgres_name_database}_cable"
  instance = local.cloud_sql_instance
}

# Store the DATABASE_URL in Google Secret Manager for Rails
resource "google_secret_manager_secret" "database_url" {
  secret_id = "${local.secret_name_database_url_prefix}_DATABASE_URL"

  replication {
    auto {}
  }

  labels = {
    environment = "production"
    project     = local.application_name
    managed_by  = "terraform"
  }
  annotations = {
    description = "URL for ${local.application_name} PostgreSQL database configuration in instance named ${local.cloud_sql_instance}"
    created-by  = "terraform"
    service     = local.application_name
  }
}

# Store the password value in the secret
resource "google_secret_manager_secret_version" "database_url" {
  secret      = google_secret_manager_secret.database_url.id
  secret_data = "postgresql://${local.database_user_name}:${random_password.database_user_password.result}@localhost/${local.postgres_name_database}?host=/cloudsql/${local.cloud_sql_connection}"
  depends_on  = [google_sql_user.database_user]
}

# Store the CACHE_DATABASE_URL in Google Secret Manager for Rails
resource "google_secret_manager_secret" "cache_database_url" {
  secret_id = "${local.secret_name_database_url_prefix}_CACHE_DATABASE_URL"

  replication {
    auto {}
  }

  labels = {
    environment = "production"
    project     = local.application_name
    managed_by  = "terraform"
  }
  annotations = {
    description = "URL for ${local.application_name} PostgreSQL cache database configuration in instance named ${local.cloud_sql_instance}"
    created-by  = "terraform"
    service     = local.application_name
  }
}

# Store the password value in the secret
resource "google_secret_manager_secret_version" "cache_database_url" {
  secret      = google_secret_manager_secret.cache_database_url.id
  secret_data = "postgresql://${local.database_user_name}:${random_password.database_user_password.result}@localhost/${local.postgres_name_database}_cache?host=/cloudsql/${local.cloud_sql_connection}"
  depends_on  = [google_sql_user.database_user]
}

# Store the QUEUE_DATABASE_URL in Google Secret Manager for Rails
resource "google_secret_manager_secret" "queue_database_url" {
  secret_id = "${local.secret_name_database_url_prefix}_QUEUE_DATABASE_URL"

  replication {
    auto {}
  }

  labels = {
    environment = "production"
    project     = local.application_name
    managed_by  = "terraform"
  }
  annotations = {
    description = "URL for ${local.application_name} Queue PostgreSQL database configuration in instance named ${local.cloud_sql_instance}"
    created-by  = "terraform"
    service     = local.application_name
  }
}

# Store the password value in the secret
resource "google_secret_manager_secret_version" "queue_database_url" {
  secret      = google_secret_manager_secret.queue_database_url.id
  secret_data = "postgresql://${local.database_user_name}:${random_password.database_user_password.result}@localhost/${local.postgres_name_database}_queue?host=/cloudsql/${local.cloud_sql_connection}"
  depends_on  = [google_sql_user.database_user]
}

# Store the CABLE_DATABASE_URL in Google Secret Manager for Rails
resource "google_secret_manager_secret" "cable_database_url" {
  secret_id = "${local.secret_name_database_url_prefix}_CABLE_DATABASE_URL"

  replication {
    auto {}
  }

  labels = {
    environment = "production"
    project     = local.application_name
    managed_by  = "terraform"
  }
  annotations = {
    description = "URL for ${local.application_name} Cable PostgreSQL database configuration in instance named ${local.cloud_sql_instance}"
    created-by  = "terraform"
    service     = local.application_name
  }
}

# Store the password value in the secret
resource "google_secret_manager_secret_version" "cable_database_url" {
  secret      = google_secret_manager_secret.cable_database_url.id
  secret_data = "postgresql://${local.database_user_name}:${random_password.database_user_password.result}@localhost/${local.postgres_name_database}_cable?host=/cloudsql/${local.cloud_sql_connection}"
  depends_on  = [google_sql_user.database_user]
}

# Outputs for reference
output "database_name" {
  value       = google_sql_database.database.name
  description = "Name of the main database"
}

output "database_user" {
  value       = google_sql_user.database_user.name
  description = "Database user name"
}

output "cloud_sql_instance" {
  value       = local.cloud_sql_instance
  description = "Cloud SQL instance name"
}

output "cloud_sql_connection" {
  value       = local.cloud_sql_connection
  description = "Cloud SQL connection string for Cloud Run"
}
