# Cloud Run job migrations
resource "google_cloud_run_v2_job" "migrate_job" {
  name                = "${local.application_name}-migrations"
  location            = "europe-west1"
  deletion_protection = false

  template {
    template {

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = ["fluid-417204:europe-west1:fluid-studioz"]
        }
      }

    vpc_access {
      network_interfaces {
        network    = "fluid-egress-vpc"
        subnetwork = "fluid-egress-vpc"
      }
      egress = "ALL_TRAFFIC"
    }

      containers {
        image = var.container_image
        # Command to run the container run migrations
        command = ["bundle"]
        args = [
          "exec",
          "rails",
          "db:migrate"
        ]

        resources {
          limits = {
            cpu    = "1000m"
            memory = "2Gi"
          }
        }

        # Environment variables
        dynamic "env" {
          for_each = var.environment_variables
          content {
            name  = env.key
            value = env.value
          }
        }

        # Environment secrets
        dynamic "env" {
          for_each = var.environment_secrets
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret = env.value
                version = "latest"
              }
            }
          }
        }

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }

      }
      service_account = var.service_account_email
    }
  }
  lifecycle {
    ignore_changes = [
      template[0].template[0].containers[0].image,
      template[0].template[0].containers[0].env,
      client,
      client_version
    ]
  }
}