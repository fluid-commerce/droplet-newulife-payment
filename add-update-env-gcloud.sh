#!/bin/bash

SERVICE=fluid-droplet-newulife-payment
SERVICE_JOBS_MIGRATIONS=fluid-droplet-newulife-payment-migrations
IMAGE_URL=europe-west1-docker.pkg.dev/fluid-417204/fluid-droplets/fluid-droplet-newulife-payment-rails/web:latest

# Variables array - add your variables here
VARS=(
  "EXAMPLE_VARIABLE=example_value"
  "EXAMPLE_VARIABLE2=example_value2"
  "ANOTHER_VAR=another_value"
  # Add more variables as needed
)

# Build the environment variables arguments for Cloud Run
CLOUD_RUN_ENV_ARGS=""
for var in "${VARS[@]}"; do
  CLOUD_RUN_ENV_ARGS="$CLOUD_RUN_ENV_ARGS --update-env-vars $var"
done

# Build the environment variables arguments for Compute Engine
COMPUTE_ENV_ARGS=""
for var in "${VARS[@]}"; do
  COMPUTE_ENV_ARGS="$COMPUTE_ENV_ARGS --container-env=$var"
done

# Update the environment variables for the service cloud run web Cloud Run migrations
gcloud run jobs update $SERVICE_JOBS_MIGRATIONS --region=europe-west1 --image $IMAGE_URL $CLOUD_RUN_ENV_ARGS

# Update the environment variables for the service cloud run web
echo "Updating Cloud Run service: $SERVICE"
gcloud run services update $SERVICE --region=europe-west1 --image $IMAGE_URL $CLOUD_RUN_ENV_ARGS

