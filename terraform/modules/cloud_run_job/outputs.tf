output "service_job_name" {
  value       = google_cloud_run_v2_job.cloud_run_job.name
  description = "Name of the service job"
}

output "service_job_location" {
  value       = google_cloud_run_v2_job.cloud_run_job.location
  description = "Location of the service job"
}
