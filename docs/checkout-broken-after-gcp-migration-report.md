# Bug Report: Checkout Broken After Heroku → GCP Migration

**Date**: 2026-02-18
**Status**: Fixed (3 issues found)
**Severity**: Critical
**Affected**: New U Life checkout flow (Company ID: 980191041)

---

## Symptom

After migrating the NewULife Payment Redirect droplet from Heroku to GCP Cloud Run, the checkout fails immediately when the customer clicks "Pay Now" with the error:

```
state is start. state must be 'payment_method', 'authorized', or 'three_ds_pending'
```

The cart remains stuck in `start` state and never transitions to `payment_method`.

## Root Cause

**The `redirect_cart_payment` callback was registered with the wrong owner type.**

When the callback was re-created for the GCP migration, it was registered using a **Company token** instead of a **DropletInstallation token**. This caused:

| Field | Incorrect (old) | Correct (new) |
|-------|-----------------|---------------|
| `owner_type` | `Company` | `DropletInstallation` |
| `owner_id` | `980191041` | `2347` |
| Response key | `Company_980191041` | `DropletInstallation_2347` |

### Why This Matters

The Fluid Droplet payment integration (`Commerce::Payments::Integrations::Droplet`) looks up the callback response using a specific key:

```ruby
# commerce/app/services/commerce/payments/integrations/droplet.rb
def callback_response_root
  "DropletInstallation_#{payment_account.droplet_installation_id}"
end
```

For Payment Account 52246, `droplet_installation_id = 2347`, so the expected key is `"DropletInstallation_2347"`.

The `Callback::Client` keys each response by `"{owner_type}_{owner_id}"`. When the callback was owned by Company, the response was keyed as `"Company_980191041"` — the Droplet integration never found it and got `nil`.

### The Full Failure Chain

```
1. Customer clicks "Pay Now"
2. Fluid checkout handler detects auto-assignable Droplet payment
3. Calls Droplet.authorize() → sends redirect_cart_payment callback to GCP
4. GCP droplet receives callback, processes it, returns valid UPayments redirect URL
5. Callback::Client keys the response as "Company_980191041"
6. Droplet integration looks for "DropletInstallation_2347" → gets nil
7. handle_auto_assignable_payment returns nil (no redirect URL)
8. Checkout handler falls through to validate_cart_for_checkout!
9. Cart is still in "start" state → error raised
```

The callback WAS firing and returning valid data — but the response was stored under the wrong key and silently discarded.

## Investigation Notes

### What Was NOT the Problem

- **Payment Account configuration**: Account 52246 is correctly configured with `auto_assign_to_cart: true`, `integration_class: "Droplet"`, active, linked to DropletInstallation 2347, with US and Canada countries
- **GCP deployment**: The Cloud Run service is working correctly, `DROPLET_HOST_URL` env var points to the correct GCP URL
- **Callback URL**: Points to the correct GCP endpoint
- **Payment account scopes**: Account 52246 passes all filters (`active`, `except_recurring_only`, `with_country_id(214)`, `meets_minimum_amount`, `auto_assignable`)
- **`payment_auto_assignable?(cart)`**: Returns `true` for test carts

### Key Files in the Flow

| Component | File |
|-----------|------|
| Checkout handler | `commerce/api/carts/concerns/cart_checkout_handler.rb` |
| Droplet integration | `commerce/payments/integrations/droplet.rb` |
| Callback client | `app/models/callback/client.rb` |
| Callback registration create | `api/callback/registrations/create_action.rb` |
| Cart state validation | `commerce/carts_service.rb:1517-1525` |
| Droplet get_redirect_url | `droplet-newulife-payment/app/controllers/checkout_callback_controller.rb` |

### Token Types and Callback Ownership

When registering a callback via the Fluid API:

- **Company token** (`C-...` or `PT-...`): Sets `owner = company` → `owner_type: "Company"`
- **DropletInstallation token** (`dit_...`): Sets `owner = current_droplet_installation` → `owner_type: "DropletInstallation"`

The create action logic:
```ruby
# api/callback/registrations/create_action.rb
owner = context[:current_droplet_installation] || company
```

## Fix Applied

1. **Created new callback registration** (ID 859) using the DropletInstallation token (`dit_sHwGjIGrM3tFy6BBSK748811UzdCOnf4`):
   - `owner_type: "DropletInstallation"`
   - `owner_id: 2347`
   - Response key: `"DropletInstallation_2347"` (matches what the Droplet integration expects)

2. **Deactivated old callback registration** (ID 857) owned by Company to prevent duplicate callback calls.

### API Calls Made

```bash
# Create new callback with DropletInstallation as owner
curl -X POST "https://api.fluid.app/api/callback/registrations" \
  -H "Authorization: Bearer dit_sHwGjIGrM3tFy6BBSK748811UzdCOnf4" \
  -H "Content-Type: application/json" \
  -d '{"callback_registration":{"definition_name":"redirect_cart_payment","url":"https://fluid-droplet-newulife-payment-106074092699.europe-west1.run.app/get_redirect_url"}}'

# Deactivate old Company-owned callback
curl -X PUT "https://api.fluid.app/api/callback/registrations/cbr_2e9birifbwagyz8ofp4svxfqvs0dwoblq" \
  -H "Authorization: Bearer dit_sHwGjIGrM3tFy6BBSK748811UzdCOnf4" \
  -H "Content-Type: application/json" \
  -d '{"callback_registration":{"active":false}}'
```

## Verification

After applying the fix, verify by:
1. Creating a new cart on the New U Life storefront
2. Adding items and proceeding to checkout
3. Clicking "Pay Now" — should redirect to UPayments instead of showing the "state is start" error

## Lessons Learned

1. **Always use the DropletInstallation token** (`dit_...`) when registering callbacks for Droplet payment integrations, not a Company or personal token
2. **The callback ownership model is silent on mismatch** — the callback fires, data is returned, but the response is keyed incorrectly and silently discarded. No error is logged.
3. **When migrating droplets**, ensure callbacks are re-registered with the correct owner by using the new DropletInstallation's authentication token

## Issue 2: FluidClient DNS Resolution Failure (Critical)

### Symptom

After the callback fix, the checkout redirects to UPayments successfully, but the success callback (after payment) fails with:

```
Socket::ResolutionError: Failed to open TCP connection to api.fluid.com:443
(getaddrinfo(3): Name or service not known)
```

### Root Cause

The `fluid_api` database setting was seeded with the wrong default URL:

| Field | Seed default (wrong) | Correct value |
|-------|---------------------|---------------|
| `base_url` | `https://api.fluid.com` | `https://api.fluid.app` |
| `api_key` | `change-me` | (valid company/droplet API token) |

The seed in `lib/tasks/settings.rb:59` had `.com` instead of `.app`. When the GCP database was initialized, it created the setting with this wrong default. A PR was opened to fix the seed: [PR #50](https://github.com/fluid-commerce/droplet-newulife-payment/pull/50).

### Important: FluidClient Caches Settings at Class Load Time

`FluidClient` uses HTTParty class-level configuration:

```ruby
class FluidClient
  include HTTParty
  base_uri Setting.fluid_api.base_url          # Evaluated ONCE when class loads
  headers "Authorization" => "Bearer #{Setting.fluid_api.api_key}"  # Also once
end
```

**Updating the `fluid_api` setting in the admin UI is NOT enough.** The Cloud Run service must be **redeployed** after changing these settings for the new values to take effect. The running instance caches the old values in memory.

### Fix

1. Update `fluid_api` setting in admin (`/admin/settings`):
   - `base_url`: `https://api.fluid.app`
   - `api_key`: valid Fluid API token
2. **Redeploy the Cloud Run service** to pick up the new values

### Running Rake Tasks on GCP Cloud Run (No Console Access)

Since there's no direct console access on Cloud Run, one-off tasks can be run via Cloud Run Jobs:

```bash
gcloud run jobs create <job-name> \
  --project=fluid-417204 \
  --region=europe-west1 \
  --image=europe-west1-docker.pkg.dev/fluid-417204/fluid-droplets/fluid-droplet-newulife-payment-rails/web:<tag> \
  --set-env-vars="RAILS_ENV=production,SECRET_KEY_BASE=<value>" \
  --set-secrets="DATABASE_URL=NEWULIFE_PAYMENT_DATABASE_URL:latest" \
  --add-cloudsql-instances=fluid-417204:europe-west1:fluid-studioz \
  --command="bin/rails" \
  --args="<task_name>" \
  --max-retries=0 \
  --execute-now
```

Key requirements:
- **`SECRET_KEY_BASE`** must be included (Rails won't boot without it)
- **`--add-cloudsql-instances`** must be set (database connects via Cloud SQL proxy socket, not TCP)
- Clean up after: `gcloud run jobs delete <job-name> --project=fluid-417204 --region=europe-west1 --quiet`

The `setup:create_admin` task creates an admin user from `ADMIN_EMAIL` and `ADMIN_PASSWORD` env vars (already configured on the service).

## Issue 3: Nil Cart Data in Callback (Medium)

Heroku logs from Feb 17 show a separate 500 error:
```
NoMethodError (undefined method '[]' for nil)
app/controllers/checkout_callback_controller.rb:7
```

This occurs when `callback_params[:cart]` is nil in `get_redirect_url`. A nil guard should be added:
```ruby
def get_redirect_url
  return render json: { redirect_url: nil, error_message: "Missing cart data" } if callback_params[:cart].blank?
  # ...existing code...
end
```

---

## GCP Migration Checklist

When migrating a Fluid droplet from Heroku to GCP Cloud Run, verify:

- [ ] **Callback registration**: Use the DropletInstallation token (`dit_...`) to register callbacks, NOT a Company token
- [ ] **`fluid_api` DB setting**: Set `base_url` to `https://api.fluid.app` and `api_key` to a valid token
- [ ] **Redeploy after DB changes**: `FluidClient` caches settings at class load — redeploy to pick up changes
- [ ] **Environment variables**: Ensure all required env vars are set (especially `SECRET_KEY_BASE`, `DROPLET_HOST_URL`, `CHECKOUT_HOST_URL`)
- [ ] **Cloud SQL proxy**: Cloud Run Jobs need `--add-cloudsql-instances` to connect to the database
- [ ] **Admin user**: Run `setup:create_admin` task via Cloud Run Job if no admin exists
- [ ] **Webhook URLs**: Update any webhook endpoints (e.g., Moola P2M) to point to the new GCP URL
