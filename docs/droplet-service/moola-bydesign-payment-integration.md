---
layout: default
title: Moola and ByDesign Payment Integration
parent: Droplet Service
nav_order: 20
---

## Moola and ByDesign Payment Integration

This document describes the integration between Moola (UWallet) payment webhooks and the ByDesign (Freedom) back-office: how payments from Moola are recorded in ByDesign so orders can be fulfilled.

### Overview

1. Customer checks out via Fluid; the droplet creates a Moola checkout session with a unique **invoice number** (`NULF-CT:{cart_token}`).
2. Customer pays on Moola; Moola sends **P2M** and optionally **load_funds_via_card** webhooks to this droplet.
3. The droplet needs a **ByDesign Order ID** to record payments. This comes from either:
   - **Fluid order webhook** `order.external_id_updated` (payload includes `cart_token` and `external_id` = ByDesign Order ID), or
   - **Checkout response fallback**: if Fluid includes the ByDesign order ID in the checkout response, the droplet sets it on the payment record immediately after checkout.
4. When both Moola payment data and ByDesign Order ID are present (and KYC is approved), the droplet calls **ByDesign Payment API** to record each payment line (card, wallet transfer, etc.).

---

### What Was Added

#### 1. Database and models

- **`moola_payments`** table: links a checkout (by `cart_token` and `invoice_number`) to Fluid order, ByDesign order, Moola transaction, payment details, card details, status, and recording attempts.
- **`MoolaPayment`** model: status lifecycle (pending → matched → recording → recorded / failed / kyc_pending / kyc_declined), helpers for invoice format and status determination.

#### 2. Invoice number prefix

- **Format**: `NULF-CT:{cart_token}` (e.g. `NULF-CT:abc123xyz`).
- Set when creating the Moola order in `UPaymentsOrderPayloadGenerator` via `MoolaPayment.format_invoice_number(cart_token)`.
- Used to correlate Moola webhooks with our records and to extract `cart_token` from `invoice_number`.

#### 3. Webhooks and jobs

| Source   | Event / Type              | Job / behavior |
|----------|---------------------------|----------------|
| Fluid    | `order.external_id_updated` | **FluidOrderExternalIdUpdatedJob**: finds or creates `MoolaPayment` by `cart_token`, sets `fluid_order_id` and `bydesign_order_id` from payload (`external_id` = ByDesign Order ID). If payment becomes `ready_to_record?`, enqueues **ByDesignPaymentRecordingJob**. |
| Moola    | `transaction` / `p2m`     | **MoolaP2mWebhookJob**: finds or creates `MoolaPayment` by `invoice_number` (extracts `cart_token`), updates with P2M payload (payment_details, kyc_status, etc.). If `ready_to_record?`, enqueues **ByDesignPaymentRecordingJob**. |
| Moola    | `transaction` / `load_funds_via_card` | **MoolaCardDetailsWebhookJob**: stores card details (last4, expiry, payment_instrument_uuid) keyed by transaction `id` for use when recording LOAD_FUNDS_VIA_CARD payments. |

#### 4. ByDesign recording

- **ByDesignPaymentRecordingJob**: for a given `MoolaPayment`, builds one ByDesign CreditCard Save request per payment detail (status/KYC mapping, card enrichment for LOAD_FUNDS_VIA_CARD), calls **ByDesignPaymentService.record_payment**, updates `MoolaPayment` status and retries on failure (up to `MAX_RECORDING_ATTEMPTS`).
- **ByDesignPaymentService**: maps Moola payment types and statuses to ByDesign API fields, builds request body for `POST api/Personal/Order/Payment/CreditCard/Save`, and performs the HTTP request (Basic auth from env).

#### 5. Checkout callback fallback (ByDesign Order ID from checkout response)

- After Fluid checkout in **CheckoutCallbackController#success**, the droplet tries to read the **ByDesign Order ID** from the checkout response.
- We read **`order.external_id`** from the Fluid checkout response (Fluid API returns the ByDesign order ID there).
- If a value is found:
  - **Existing `MoolaPayment`** (by `cart_token`): updates `bydesign_order_id` (and `fluid_order_id` if present), recomputes status, and enqueues **ByDesignPaymentRecordingJob** if `ready_to_record?`.
  - **No `MoolaPayment` yet**: creates a placeholder with `cart_token`, `invoice_number` (from `MoolaPayment.format_invoice_number(cart_token)`), `bydesign_order_id`, and `fluid_webhook_payload` (checkout response). When the Moola P2M webhook arrives, it will find this record by `invoice_number` and update Moola data; recording will run when the payment is `ready_to_record?`.

This gives two ways to get the ByDesign Order ID into the droplet:

1. **Primary**: Fluid sends `order.external_id_updated` with `order.cart_token` and `order.external_id` (ByDesign Order ID).
2. **Fallback**: Fluid includes the ByDesign order ID in the checkout response as `order.external_id`.

---

### Flow Summary

1. **get_redirect_url**: Create Moola order with `invoiceNumber: NULF-CT:{cart_token}`. No `MoolaPayment` is created here.
2. **Customer pays on Moola**: Moola may send `load_funds_via_card` then `p2m` (or vice versa).
3. **success (checkout callback)**: Call Fluid payment + checkout. If checkout response contains ByDesign order ID (configurable keys), create or update `MoolaPayment` with `bydesign_order_id` and enqueue recording if ready.
4. **Fluid** (optional): Send `order.external_id_updated` with `cart_token` and `external_id` (ByDesign Order ID). **FluidOrderExternalIdUpdatedJob** updates (or creates) `MoolaPayment` and enqueues recording if ready.
5. **Moola P2M**: **MoolaP2mWebhookJob** finds or creates `MoolaPayment` by `invoice_number`, updates Moola data; enqueues recording if ready.
6. **ByDesignPaymentRecordingJob**: For each payment detail, call ByDesign CreditCard Save; update status to recorded or failed.

---

### Webhook Registration

- **Fluid**: Register a webhook for resource `order`, event `external_id_updated`, pointing to this droplet’s webhook URL (e.g. `POST /webhook`). Payload must include `order.cart_token` and `order.external_id` (ByDesign Order ID). See [Registering your first webhook](registering-first-webhook.md).
- **Moola**: Configure Moola to send transaction webhooks to this droplet (URL and auth as required by Moola). The droplet expects `type=transaction` and `transaction_type=p2m` or `load_funds_via_card` in the JSON body.

---

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `BY_DESIGN_API_URL` | ByDesign API base URL (e.g. `https://webapi.bydesign.com/NewULifeSandbox`). |
| `BY_DESIGN_INTEGRATION_USERNAME` | Basic auth username for ByDesign. |
| `BY_DESIGN_INTEGRATION_PASSWORD` | Basic auth password for ByDesign. |
Other existing env (e.g. Fluid API, Moola/UPayments, droplet host URLs) are unchanged.

---

### Files Touched / Added

- **Models**: `app/models/moola_payment.rb`
- **Jobs**: `app/jobs/moola_p2m_webhook_job.rb`, `app/jobs/moola_card_details_webhook_job.rb`, `app/jobs/fluid_order_external_id_updated_job.rb`, `app/jobs/by_design_payment_recording_job.rb`
- **Services**: `app/services/by_design_payment_service.rb`
- **Controllers**: `app/controllers/checkout_callback_controller.rb` (success callback + `update_moola_payment_from_checkout_response`, `bydesign_order_id_from_checkout_response`)
- **Config**: `config/initializers/event_handler.rb` (register `order.external_id_updated` → `FluidOrderExternalIdUpdatedJob`)
- **Payload**: `app/services/u_payments_order_payload_generator.rb` (invoice number via `MoolaPayment.format_invoice_number`)
- **Migrations**: `db/migrate/*_create_moola_payments.rb`

---

### References

- ByDesign Payment API: `POST api/Personal/Order/Payment/CreditCard/Save` (see Moola Uwallet and ByDesign Payment API documentation).
- Moola webhook payloads: `type=transaction`, `transaction_type=p2m` (with `payment_details`, `kycStatus`) and `transaction_type=load_funds_via_card` (card details keyed by `id`).
