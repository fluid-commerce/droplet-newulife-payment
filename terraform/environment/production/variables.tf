# project variables
variable "project_id" {
  description = "Project ID of the instance"
  type        = string
}

variable "region" {
  description = "Region of the instance"
  type        = string
}

# compute engine variables for jobs console
variable "vm_name" {
  description = "Name of the virtual machine instance"
  type        = string
}

variable "machine_type" {
  description = "The machine type of the instance"
  type        = string
  default     = "e2-medium"
}

variable "zone" {
  description = "The zone where the instance will be created"
  type        = string
}

variable "environment" {
  description = "Environment of the Compute Engine instance"
  type        = string
}

variable "project" {
  description = "Project of the Compute Engine instance"
  type        = string
}

variable "purpose_compute_engine" {
  description = "Purpose of the Compute Engine instance"
  type        = string
}

variable "email_service_account" {
  description = "Email of the service account"
  type        = string
}

# Container variables for the Compute Engine instance
variable "container_image" {
  description = "Image of the container"
  type        = string
}

variable "container_rails_master_key" {
  description = "Rails master key for the container"
  type        = string
  sensitive   = true
}

variable "container_db_url_production" {
  description = "Database URL for production environment"
  type        = string
  sensitive   = true
}

variable "container_db_url_production_queue" {
  description = "Database URL for production queue"
  type        = string
  sensitive   = true
}

variable "container_db_url_production_cache" {
  description = "Database URL for production cache"
  type        = string
  sensitive   = true
}

variable "container_db_url_production_cable" {
  description = "Database URL for production cable"
  type        = string
  sensitive   = true
}

# variable module cloud_run fluid droplet

variable "cloud_run_app_name" {
  description = "Name of the Cloud Run app"
  type        = string
}

variable "cloud_sql_instances_cloud_run" {
  description = "List of Cloud SQL instances"
  type        = list(string)
}

variable "environment_variables_cloud_run" {
  description = "Variables for the container"
  type        = map(string)
}

# cloud run migrations
variable "cloud_run_migrations_name" {
  description = "Name of the migrations job"
  type        = string
}

variable "vpc_network_cloud_run" {
  description = "VPC network"
  type        = string
}

variable "vpc_subnet_cloud_run" {
  description = "VPC subnet"
  type        = string
}
