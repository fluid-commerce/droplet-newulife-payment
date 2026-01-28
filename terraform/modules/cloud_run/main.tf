# Cloud Run service module
resource "google_cloud_run_v2_service" "cloud_run" {
  name     = var.service_name
  location = var.region
  client   = "cloud-console"

  deletion_protection = true

  scaling {
    min_instance_count = var.min_instances
  }

  template {
    labels = {
      env : var.environment
      project : var.project
      purpose : var.purpose_cloud_run
    }

    service_account = var.service_account_email

    scaling {
      max_instance_count = var.max_instances
      min_instance_count = var.min_instances
    }

    vpc_access {
      network_interfaces {
        network     = var.vpc_network_app
        subnetwork  = var.vpc_subnet_app
      }
      egress    = "ALL_TRAFFIC"
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = var.cloud_sql_instances
      }
    }

    containers {
      name  = var.container_name
      image = var.container_image

      ports {
        name           = "http1"
        container_port = var.container_port
      }

      resources {
        limits = {
          cpu    = var.resource_limits_cpu
          memory = var.resource_limits_memory
        }
        startup_cpu_boost = var.startup_cpu_boost
      }

      volume_mounts {
        mount_path = "/cloudsql"
        name       = "cloudsql"
      }

      dynamic "env" {
        for_each = var.environment_variables
        content {
          name  = env.key
          value = env.value
        }
      }

      startup_probe {
        initial_delay_seconds = var.startup_probe_initial_delay
        failure_threshold     = var.startup_probe_failure_threshold

        period_seconds  = var.startup_probe_period_seconds
        timeout_seconds = var.startup_probe_timeout_seconds

        http_get {
          path = var.startup_probe_path
          port = var.startup_probe_port
        }
      }
    }
  }

  lifecycle {
    prevent_destroy = true # Prevents accidental destruction
    ignore_changes = [
      template[0].containers[0].image,
      template[0].containers[0].env,
      template[0].containers[0].startup_probe,
      template[0].revision
    ]
  }
}
