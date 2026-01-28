output "bucket" {
  description = "The created bucket resource"
  value       = google_storage_bucket.bucket
}

output "bucket_name" {
  description = "Bucket name"
  value       = google_storage_bucket.bucket.name
}

output "bucket_url" {
  description = "Bucket URL"
  value       = google_storage_bucket.bucket.url
}

output "bucket_self_link" {
  description = "Bucket URI"
  value       = google_storage_bucket.bucket.self_link
}
