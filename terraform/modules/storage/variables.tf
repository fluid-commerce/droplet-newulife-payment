variable "bucket_name" {
  description = "Unique name for the storage bucket"
  type        = string
}

variable "project_id" {
  description = "Google Cloud Project ID"
  type        = string
}

variable "location" {
  description = "Bucket location (e.g., US, EU, us-central1)"
  type        = string
  default     = "US"
}

variable "storage_class" {
  description = "Storage class for the bucket (STANDARD, NEARLINE, COLDLINE, ARCHIVE)"
  type        = string
  default     = "STANDARD"
}

variable "force_destroy" {
  description = "Boolean that indicates if the bucket can be destroyed when it contains objects"
  type        = bool
  default     = false
}

variable "uniform_bucket_level_access" {
  description = "Enables uniform bucket-level access"
  type        = bool
  default     = true
}

variable "labels" {
  description = "A map of labels to assign to the bucket"
  type        = map(string)
  default     = {}
}
