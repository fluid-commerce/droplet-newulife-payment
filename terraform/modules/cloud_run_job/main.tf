resource "google_cloud_run_v2_job" "cloud_run_job" {
  name                = var.service_job_name
  location            = var.region_job
  deletion_protection = false

  template {
    template {

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = var.cloud_sql_instances_job
        }
      }

      vpc_access {
        network_interfaces {
          network     = var.vpc_network_job
          subnetwork  = var.vpc_subnet_job
        }
        egress    = "ALL_TRAFFIC"
      }

      containers {
        image = var.image_job
        # Command to run the container run migrations
        command = ["bundle"]
        args = [
          "exec",
          "rails",
          "db:migrate"
        ]

        resources {
          limits = {
            cpu    = var.resource_limits_job_cpu
            memory = var.resource_limits_job_memory
          }
        }

        dynamic "env" {
          for_each = var.environment_variables_job
          content {
            name  = env.key
            value = env.value
          }
        }

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }

      }
      service_account = var.service_account_job_email
    }
  }
  lifecycle {
    ignore_changes = [
      template[0].template[0].containers[0].image,
      client,
      client_version
    ]
  }
}
