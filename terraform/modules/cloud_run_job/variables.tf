variable "service_job_name" {
  description = "Name of the service job"
  type        = string
}

variable "region_job" {
  description = "Region of the instance"
  type        = string
}

variable "image_job" {
  description = "Image of the container"
  type        = string
}

variable "environment_variables_job" {
  description = "Variables for the container"
  type        = map(string)
}

variable "resource_limits_job_cpu" {
  description = "Resource limits for the container"
  type        = string
}

variable "resource_limits_job_memory" {
  description = "Resource limits for the container"
  type        = string
}

variable "cloud_sql_instances_job" {
  description = "List of Cloud SQL instances"
  type        = list(string)
}

variable "vpc_network_job" {
  description = "VPC network"
  type        = string
}

variable "vpc_subnet_job" {
  description = "VPC subnet"
  type        = string
}

variable "service_account_job_email" {
  description = "Service account email"
  type        = string
}
