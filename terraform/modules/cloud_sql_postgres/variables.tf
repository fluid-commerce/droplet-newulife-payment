variable "instance_name" {
  description = "Name of the Cloud SQL instance"
  type        = string
}

variable "project" {
  description = "Project ID"
  type        = string
}

variable "environment" {
  description = "Environment"
  type        = string
}

variable "region" {
  description = "Region"
  type        = string
}

variable "database_version" {
  description = "Database version"
  type        = string
}

variable "edition" {
  description = "Edition"
  type        = string
  default     = "ENTERPRISE"
}

variable "tier" {
  description = "Tier"
  type        = string
}

variable "disk_size" {
  description = "Disk size"
  type        = number
  default     = 10
}

variable "high_availability" {
  description = "High availability, if false, the instance will be a single-zone instance"
  type        = bool
  default     = false
}

variable "ipv4_enabled" {
  description = "IPv4 enabled"
  type        = bool
  default     = true
}

variable "private_network_database" {
  description = "Private network"
  type        = string
}
