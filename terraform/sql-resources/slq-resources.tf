# locals for the application
locals {
  application_name = "fluid-droplet-newulife-payment"
  postgres_name_database = "newulife_payment"
  database_user_name = "newulife_payment_user"
  secret_name_database_url_prefix = "NEWULIFE_PAYMENT"
}

# fluid droplet-newulife-payment - database configuration
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
  instance = "fluid-studioz"
  password = random_password.database_user_password.result
}

# Create databases within the Cloud SQL instance
resource "google_sql_database" "database" {
  name     = local.postgres_name_database
  instance = "fluid-studioz"
}

resource "google_sql_database" "database_cache" {
  name     = "${local.postgres_name_database}_cache"
  instance = "fluid-studioz"
}

resource "google_sql_database" "database_queue" {
  name     = "${local.postgres_name_database}_queue"
  instance = "fluid-studioz"
}

resource "google_sql_database" "database_cable" {
  name     = "${local.postgres_name_database}_cable"
  instance = "fluid-studioz"
}

# Store the DATABASE_URL in Google Secret Manager for Rails
resource "google_secret_manager_secret" "database_url" {
  secret_id = "${local.secret_name_database_url_prefix}_DATABASE_URL"

  replication {
    auto {}
  }

  labels = {
    environment = "production"
    project     = "${local.application_name}"
    managed_by  = "terraform"
  }
  annotations = {
    description = "URL for ${local.application_name} PostgreSQL database configuration in instance named fluid-studioz"
    created-by  = "terraform"
    service     = "${local.application_name}"
  }
}

# Store the password value in the secret
resource "google_secret_manager_secret_version" "database_url" {
  secret      = google_secret_manager_secret.database_url.id
  secret_data = "postgresql://${local.database_user_name}:${random_password.database_user_password.result}@localhost/${local.postgres_name_database}?host=/cloudsql/fluid-417204:europe-west1:fluid-studioz"
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
    project     = "${local.application_name}"
    managed_by  = "terraform"
  }
  annotations = {
    description = "URL for ${local.application_name} PostgreSQL database configuration in instance named fluid-studioz"
    created-by  = "terraform"
    service     = "${local.application_name}"
  }
}

# Store the password value in the secret
resource "google_secret_manager_secret_version" "cache_database_url" {
  secret      = google_secret_manager_secret.cache_database_url.id
  secret_data = "postgresql://${local.database_user_name}:${random_password.database_user_password.result}@localhost/${local.postgres_name_database}_cache?host=/cloudsql/fluid-417204:europe-west1:fluid-studioz"
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
    project     = "${local.application_name}"
    managed_by  = "terraform"
  }
  annotations = {
    description = "URL for ${local.application_name} Queue PostgreSQL database configuration in instance named fluid-studioz"
    created-by  = "terraform"
    service     = "${local.application_name}"
  }
}

# Store the password value in the secret
resource "google_secret_manager_secret_version" "queue_database_url" {
  secret      = google_secret_manager_secret.queue_database_url.id
  secret_data = "postgresql://${local.database_user_name}:${random_password.database_user_password.result}@localhost/${local.postgres_name_database}_queue?host=/cloudsql/fluid-417204:europe-west1:fluid-studioz"
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
    project     = "${local.application_name}"
    managed_by  = "terraform"
  }
  annotations = {
    description = "URL for ${local.application_name} Cable PostgreSQL database configuration in instance named fluid-studioz"
    created-by  = "terraform"
    service     = "${local.application_name}"
  }
}

# Store the password value in the secret
resource "google_secret_manager_secret_version" "cable_database_url" {
  secret      = google_secret_manager_secret.cable_database_url.id
  secret_data = "postgresql://${local.database_user_name}:${random_password.database_user_password.result}@localhost/${local.postgres_name_database}_cable?host=/cloudsql/fluid-417204:europe-west1:fluid-studioz"
  depends_on  = [google_sql_user.database_user]
}