terraform {
  required_version = "1.13.5"

  backend "gcs" {
    bucket = "fluid-terraform"
    prefix = "fluid-droplet-newulife-payment/cloud-run-api"
  }

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~>7.14.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~>3.6.0"
    }
  }
}

provider "google" {
  project = "fluid-417204"
  region  = "europe-west1"
}
