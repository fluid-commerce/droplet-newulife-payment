# GCP Environment Variables

This document lists all environment variables required for the newulife-payment droplet, migrated from Heroku.

## Database URLs (Managed by Terraform)

These are automatically created and stored in Google Secret Manager by the `terraform/environment/production/database/` configuration.

| Variable | Secret Manager Key | Notes |
|----------|-------------------|-------|
| `DATABASE_URL` | `NEWULIFE_PAYMENT_DATABASE_URL` | Main application database |
| `CACHE_DATABASE_URL` | `NEWULIFE_PAYMENT_CACHE_DATABASE_URL` | Rails cache database |
| `QUEUE_DATABASE_URL` | `NEWULIFE_PAYMENT_QUEUE_DATABASE_URL` | Solid Queue database |
| `CABLE_DATABASE_URL` | `NEWULIFE_PAYMENT_CABLE_DATABASE_URL` | Action Cable database |

## Rails Environment (Set by Default)

These are already configured in the terraform Cloud Run configuration.

| Variable | Value | Notes |
|----------|-------|-------|
| `RAILS_ENV` | `production` | Rails environment |
| `RACK_ENV` | `production` | Rack environment |
| `RAILS_LOG_TO_STDOUT` | `enabled` | Enable stdout logging for Cloud Run |

## Sensitive Variables (Store in Secret Manager)

These contain credentials and should be stored in Google Secret Manager.

| Variable | Description | Heroku Source |
|----------|-------------|---------------|
| `RAILS_MASTER_KEY` | Rails master key for credentials | `SECRET_KEY_BASE` |
| `ADMIN_PASSWORD` | Admin user password | `ADMIN_PASSWORD` |
| `BY_DESIGN_INTEGRATION_PASSWORD` | ByDesign API password | `BY_DESIGN_INTEGRATION_PASSWORD` |
| `BY_DESIGN_INTEGRATION_USERNAME` | ByDesign API username | `BY_DESIGN_INTEGRATION_USERNAME` |
| `NEWULIFE_API_CODE` | NewULife API code | `NEWULIFE_API_CODE` |
| `NEWULIFE_PRIVATE_KEY` | NewULife private key | `NEWULIFE_PRIVATE_KEY` |
| `UPAYMENTS_MC_API_CODE` | UPayments MC API code | `UPAYMENTS_MC_API_CODE` |
| `UPAYMENTS_MC_PRIVATE_KEY` | UPayments MC private key | `UPAYMENTS_MC_PRIVATE_KEY` |

## Non-Sensitive Variables (Plain Environment Variables)

These can be set directly as Cloud Run environment variables.

| Variable | Description | Example Value |
|----------|-------------|---------------|
| `ADMIN_EMAIL` | Admin user email | `admin@example.com` |
| `BY_DESIGN_API_URL` | ByDesign API endpoint | `https://api.bydesign.com/...` |
| `CHECKOUT_HOST_URL` | Checkout service URL | `https://checkout.fluid.app` |
| `DROPLET_HOST_URL` | This droplet's public URL | `https://fluid-droplet-newulife-payment-....run.app` |
| `LANG` | System language | `en_US.UTF-8` |
| `RAILS_SERVE_STATIC_FILES` | Serve static files | `true` |
| `UPAYMENTS_CHECKOUT_API_URL` | UPayments checkout API | `https://...` |
| `UPAYMENTS_USERS_API_URL` | UPayments users API | `https://...` |

## Setting Environment Variables

### Option 1: Via Terraform

Add variables to `terraform/environment/production/terraform.tfvars`:

```hcl
environment_variables_cloud_run = {
  "RAILS_ENV"                     = "production"
  "RACK_ENV"                      = "production"
  "RAILS_LOG_TO_STDOUT"           = "enabled"
  "ADMIN_EMAIL"                   = "admin@example.com"
  "BY_DESIGN_API_URL"             = "https://..."
  "CHECKOUT_HOST_URL"             = "https://..."
  "DROPLET_HOST_URL"              = "https://..."
  "LANG"                          = "en_US.UTF-8"
  "RAILS_SERVE_STATIC_FILES"      = "true"
  "UPAYMENTS_CHECKOUT_API_URL"    = "https://..."
  "UPAYMENTS_USERS_API_URL"       = "https://..."
  # Sensitive vars - retrieve from Secret Manager
  "RAILS_MASTER_KEY"              = "..."
  "DATABASE_URL"                  = "postgresql://..."
  # ... etc
}
```

### Option 2: Via gcloud CLI

Use the `add-update-env-gcloud.sh` script:

```bash
# Edit the VARS array in the script, then run:
./add-update-env-gcloud.sh
```

### Option 3: Manual gcloud commands

```bash
# Update Cloud Run service
gcloud run services update fluid-droplet-newulife-payment \
  --region=europe-west1 \
  --update-env-vars="ADMIN_EMAIL=admin@example.com,BY_DESIGN_API_URL=https://..."

# Update Cloud Run migrations job
gcloud run jobs update fluid-droplet-newulife-payment-migrations \
  --region=europe-west1 \
  --update-env-vars="..."

# Update Compute Engine (jobs console)
gcloud compute instances update-container fluid-droplet-newulife-payment-jobs-console \
  --zone=europe-west1-b \
  --container-env="ADMIN_EMAIL=admin@example.com,..."
```

## Creating Secrets in Secret Manager

For sensitive variables, create secrets:

```bash
# Create a secret
echo -n "your-secret-value" | gcloud secrets create NEWULIFE_PAYMENT_ADMIN_PASSWORD \
  --data-file=- \
  --replication-policy="automatic"

# Grant Cloud Run access to the secret
gcloud secrets add-iam-policy-binding NEWULIFE_PAYMENT_ADMIN_PASSWORD \
  --member="serviceAccount:YOUR_SERVICE_ACCOUNT@PROJECT.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

## Migration Checklist

- [ ] Run database terraform to create databases and DB URL secrets
- [ ] Create secrets for sensitive variables in Secret Manager
- [ ] Configure non-sensitive environment variables
- [ ] Verify `RAILS_MASTER_KEY` matches Heroku's `SECRET_KEY_BASE`
- [ ] Update `DROPLET_HOST_URL` with actual Cloud Run URL after first deploy
- [ ] Test all API integrations (ByDesign, UPayments, NewULife)
