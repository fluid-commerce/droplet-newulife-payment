# Module to create a Cloud SQL instance
# and a Cloud SQL database

resource "google_sql_database_instance" "postgres" {
  name             = var.instance_name # Instance name
  database_version = var.database_version
  region           = var.region

  deletion_protection = true

  settings {
    deletion_protection_enabled = true # Prevents accidental deletion
    edition                     = var.edition
    tier                        = var.tier
    disk_size                   = var.disk_size
    availability_type           = var.high_availability ? "REGIONAL" : "ZONAL"


    user_labels = {
      project     = var.project
      environment = var.environment
    }

    # dynamic "database_flags" {
    #   for_each = var.postgres_flags
    #   content {
    #     name  = database_flags.key
    #     value = database_flags.value
    #   }
    # }

    ip_configuration {
      ipv4_enabled = var.ipv4_enabled # IPv4 enabled public access
      private_network = var.private_network_database
    }

    maintenance_window {
      day          = 6
      hour         = 5
      update_track = "stable"
    }

  }

  lifecycle {
    prevent_destroy = true # Prevents accidental destruction
    ignore_changes = [
      settings[0].ip_configuration[0].authorized_networks
    ]
  }

}
