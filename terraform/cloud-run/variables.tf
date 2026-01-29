variable "project_id" {
  description = "Project ID of the instance"
  type        = string
}

variable "region" {
  description = "Region where the service will be deployed"
  type        = string
}

variable "service_account_email" {
  description = "Service account email"
  type        = string
}

variable "container_image" {
  description = "Image of the container"
  type        = string
}


variable "environment_variables" {
  description = "Environment variables for the container"
  type        = map(string)
}

variable "environment_secrets" {
  description = "Environment secrets for the container"
  type        = map(string)
}
