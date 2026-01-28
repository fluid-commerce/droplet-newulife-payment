
terraform {
  required_version = "1.11.4"

  backend "gcs" {
    bucket = "fluid-terraform"
    prefix = "fluid-droplet-newulife-payment/production"
  }

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "6.47.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
