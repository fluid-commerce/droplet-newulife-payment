variable "service_name" {
  description = "Name of the Cloud Run service"
  type        = string
}

variable "region" {
  description = "Region where the service will be deployed"
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

variable "purpose_cloud_run" {
  description = "Purpose of the Compute Engine instance"
  type        = string
}

variable "vpc_network_app" {
  description = "VPC network"
  type        = string
}

variable "vpc_subnet_app" {
  description = "VPC subnet"
  type        = string
}

variable "service_account_email" {
  description = "Service account email"
  type        = string
}

variable "max_instances" {
  description = "Maximum number of instances"
  type        = number
  default     = 10
}

variable "min_instances" {
  description = "Minimum number of instances"
  type        = number
  default     = 1
}

variable "cloud_sql_instances" {
  description = "Cloud SQL instances to connect to the database"
  type        = list(string)
}

variable "container_name" {
  description = "Name of the container"
  type        = string
}

variable "container_image" {
  description = "Image of the container"
  type        = string
}

variable "container_port" {
  description = "Port of the container"
  type        = number
  default     = 3000
}

variable "resource_limits_cpu" {
  description = "CPU limits for the container"
  type        = string
  default     = "1000m"
}

variable "resource_limits_memory" {
  description = "Memory limits for the container"
  type        = string
  default     = "2Gi"
}

variable "startup_cpu_boost" {
  description = "Startup CPU boost for the container"
  type        = bool
  default     = true
}

variable "environment_variables" {
  description = "Environment variables for the container"
  type        = map(string)
}

variable "startup_probe_initial_delay" {
  description = "Initial delay for the startup probe"
  type        = number
  default     = 30
}

variable "startup_probe_failure_threshold" {
  description = "Failure threshold for the startup probe"
  type        = number
  default     = 3
}

variable "startup_probe_period_seconds" {
  description = "Period for the startup probe"
  type        = number
  default     = 240
}

variable "startup_probe_timeout_seconds" {
  description = "Timeout for the startup probe"
  type        = number
  default     = 240
}

variable "startup_probe_path" {
  description = "Path for the startup probe"
  type        = string
  default     = "/up"
}

variable "startup_probe_port" {
  description = "Port for the startup probe"
  type        = number
  default     = 3000
}
