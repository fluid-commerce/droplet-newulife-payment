output "service_name" {
  description = "Cloud Run service name"
  value       = google_cloud_run_v2_service.cloud_run.name
}

output "service_url" {
  description = "Cloud Run service URL"
  value       = google_cloud_run_v2_service.cloud_run.uri
}

output "latest_ready_revision" {
  description = "Latest ready revision of the service"
  value       = google_cloud_run_v2_service.cloud_run.latest_ready_revision
}
