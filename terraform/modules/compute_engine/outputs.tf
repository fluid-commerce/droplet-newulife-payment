# instance_name
output "instance_name" {
  value       = google_compute_instance.compute_instance.name
  description = "Name of the fluid-droplet compute instance"
}

# machine_type
output "machine_type" {
  value       = google_compute_instance.compute_instance.machine_type
  description = "Machine type of the fluid-droplet compute instance"
}

# zone
output "zone" {
  value       = google_compute_instance.compute_instance.zone
  description = "Zone of the fluid-droplet compute instance"
}

# labels
output "labels" {
  value       = google_compute_instance.compute_instance.labels
  description = "Labels of the fluid-droplet compute instance"
}
