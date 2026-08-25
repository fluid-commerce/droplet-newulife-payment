# Migrating `droplet-newulife-payment` from Rails to Next.js

**Status: plan only. No application code in this PR, and none should be written from this
document alone.**

This droplet moves money. It creates consumers in ByDesign, creates orders in uPayments/Moola,
creates payments and completes checkouts in Fluid, and records payments against ByDesign orders.
Several of those actions are irreversible from the droplet's side. The custom Ruby is small enough
to port in a week; the reason it has not been ported is that the *failure semantics* are not
small, and at least four of them are currently wrong. Porting the code without porting a decision
about each of those is how you get double-charged customers.

Read §3 before §6. §10 is the target shape, taken from the reference implementations.

A note on where this document lives. The two completed sibling migrations —
`droplet-template#200` and `fluid-droplet-zallevo-shipping-calcs#59` — both put the entire
migration narrative in the **PR body** and added no plan document. That is the house style. This
droplet gets a file instead because it is a plan that will be executed later by someone who is not
in this PR's review thread, and a PR body is not a working document. The PR body is short and
points here.

---

## 0. Measurement point

Everything below was measured at:

| Thing | Commit | Note |
|---|---|---|
| `droplet-newulife-payment` | `ff29ed2` (`origin/main`) | fetched 2026-08-25 |
| `droplet-template` | `def6b9d` (`origin/main`) | comparison baseline for "identical" |
| `fluid` (callback definitions) | `origin/master` | fetched 2026-08-25 |

**The local checkout at `~/projects/droplets-workspace/droplet-newulife-payment` was stale by
3 commits** — it sat at `9b521b7`, missing PR #65 (`claude/prevent-duplicate-payment-recording`,
merged as `ff29ed2`). That PR is directly relevant: it is the most recent attempt to fix the
duplicate-recording problem described in §3, and it changed four of the money-path files.
Anything measured against the stale checkout under-reports the custom surface.

The local `fluid-main` checkout was also stale: it is on branch `fix/lifecycle-webhook-include-tokens`
and has **18** callback definition files. `origin/master` has **22**. The four missing locally are
`cart_country_changed`, `cart_customer_attached`, `cart_customer_detached`, and
`validate_cart_discount`. None of them are used by this droplet, but the discrepancy is why §2
was cross-checked against `origin/master` rather than the working copy.

---

## 1. Inventory

Method: byte-compare (`cmp`) every file under `app/` and `lib/` against the same path in
`droplet-template@def6b9d`. Present and byte-identical → **identical**. Present and differing →
**modified**. Absent from the template → **custom**.

### Ruby files only (`app/**/*.rb`, `lib/**/*.rb`) — 42 files, 2,821 LOC

| Class | Files | LOC |
|---|---|---|
| Identical to template | **20** | 457 |
| Template-modified | **9** | 480 |
| Custom | **13** | 1,884 |

### All files under `app/` and `lib/` (including ERB, TSX, CSS) — 86 files, 3,803 LOC

| Class | Files | LOC |
|---|---|---|
| Identical to template | **56** | 1,258 |
| Template-modified | **12** | 564 |
| Custom | **18** | 1,981 |

### Correction to the stated figures

The brief said **19 identical / 8 modified / 13 custom** and **~1,858 lines of custom Ruby**.

- The **1,858** figure is exactly the custom-Ruby LOC at the stale commit `9b521b7`. At
  `origin/main` (`ff29ed2`) it is **1,884**. So the LOC number confirms the checkout was stale.
- The **file counts** are off by one in two buckets at *both* commits: it is 20 identical and
  9 modified, not 19 and 8. The custom count of 13 is correct. Re-running the byte-compare at
  `9b521b7` gives the same 20 / 9 / 13 split, so this is a counting difference, not staleness.

### Custom Ruby (13 files, 1,884 LOC)

| File | LOC | What it is |
|---|---|---|
| `app/services/by_design_payment_service.rb` | 462 | Records a payment against a ByDesign order; posts the order |
| `app/controllers/checkout_callback_controller.rb` | 355 | The `redirect_cart_payment` callback **and** the uPayments return landing page |
| `app/jobs/moola_p2m_webhook_job.rb` | 206 | Processes the Moola P2M / card webhook into `moola_payments` |
| `app/jobs/by_design_payment_recording_job.rb` | 182 | Drives `ByDesignPaymentService` for a matched payment |
| `app/models/moola_payment.rb` | 149 | State machine + the enqueue-if-ready lock |
| `app/services/by_design.rb` | 102 | Creates a consumer in ByDesign |
| `app/services/u_payments_user_api_client.rb` | 86 | uPayments users API (RS512 JWT) |
| `app/services/u_payments_checkout_api_client.rb` | 69 | uPayments checkout API (RS512 JWT) |
| `app/services/u_payments_order_payload_generator.rb` | 68 | Builds the uPayments order body |
| `app/controllers/moola_webhooks_controller.rb` | 74 | Inbound Moola webhook endpoint |
| `app/jobs/fluid_order_external_id_updated_job.rb` | 60 | `order.external_id_synced` → attach ByDesign OrderID |
| `app/services/u_payments_consumer_payload_generator.rb` | 50 | Builds the uPayments consumer body |
| `app/controllers/embed_controller.rb` | 21 | Dropzone/embed status page |

### Template-modified Ruby (9 files, 480 LOC)

| File | LOC | Nature of the change |
|---|---|---|
| `lib/tasks/settings.rb` | 203 | Replaced `fluid_webhook` setting with a `categories` setting |
| `app/controllers/webhooks_controller.rb` | 77 | **Security-relevant** — see §3.4 and §8 |
| `app/clients/fluid/droplets.rb` | 46 | Droplet payload |
| `app/jobs/droplet_installed_job.rb` | 38 | Sets `company_droplet_uuid` from `droplet_uuid` |
| `app/clients/fluid_client.rb` | 54 | Error classes |
| `app/controllers/admin/droplets_controller.rb` | 25 | — |
| `app/jobs/droplet_uninstalled_job.rb` | 15 | — |
| `app/controllers/application_controller.rb` | 14 | `current_ability` |
| `app/models/company.rb` | 8 | — |

### Template files this droplet does not have

The droplet forked from an **older** template. Fifteen template files are absent, and they are
exactly the callback-management layer plus the droplet-registration use cases:

```
app/clients/fluid/callback_definitions.rb    app/services/callback_sync_service.rb
app/clients/fluid/callback_registrations.rb  app/services/droplet_manager.rb
app/clients/fluid/webhooks.rb                app/services/webhook_manager.rb
app/controllers/admin/callbacks_controller.rb app/use_cases/droplet_use_case/{base,create,update}.rb
app/models/callback.rb                        app/views/admin/callbacks/{edit,index,show}.html.erb
app/models/integration_setting.rb
```

Consequences for the migration:

- There is **no `callbacks` table and no `integration_settings` table** in this database. The
  shared-layer Prisma schema from the template migration has two models this droplet's database
  does not contain. See §5.
- Callback registration here is **manual** — a curl in `callbacks_registration.md`. There is no
  sync service, no admin callbacks UI, and no stored callback token. That is both a gap to close
  and a reason the SDK's registration/token-digest flow is net-new work rather than a port.
- `app/jobs/droplet_reinstalled_job.rb` (13 LOC, template-identical) is **dead code**. It is never
  registered in `config/initializers/event_handler.rb`, and `droplet.reinstalled` is not a topic
  in Fluid — `Webhook::TopicRegistry` (fluid `origin/master`, line 33) lists only
  `droplet: [installed, uninstalled]`.

---

## 2. The Fluid integration surface

Every definition name below was checked against the 22 files at
`app/lib/callback_definitions/*.yml` on fluid `origin/master`, and every webhook topic against
`app/models/webhook/topic_registry.rb` on the same ref.

### 2.1 Callbacks (Fluid → droplet, synchronous, during live checkout)

| `definition_name` | Exists in Fluid? | Droplet URL | Handler |
|---|---|---|---|
| `redirect_cart_payment` | **Yes** — `app/lib/callback_definitions/redirect_cart_payment.yml` | `POST /get_redirect_url` | `CheckoutCallbackController#get_redirect_url` (`app/controllers/checkout_callback_controller.rb:4`) |

Confirmed, not assumed: the droplet's own registration recipe names it explicitly —
`callbacks_registration.md:9-10` posts `{"definition_name": "redirect_cart_payment", "url":
".../get_redirect_url"}` to `/api/callback/registrations`. This is the only callback the droplet
registers. Nothing in the repo references any definition name that does not exist in Fluid.

The definition's contract, from the YAML:

- Request requires `cart` and `payment_account_id`; optional `customer`, `user_company`,
  `attributable_rep_id`, `attribution`.
- Response is `anyOf: [required: [redirect_url], required: [error_message]]`, both nullable
  strings. The droplet honours this on every path it handles
  (`checkout_callback_controller.rb:43, 49, 61, 79, 103, 110`) — always HTTP 200, always one of
  the two keys. **But see §3.6: several unhandled exception paths return HTTP 500 instead.**

### 2.2 Webhooks (Fluid → droplet, asynchronous)

All three arrive at `POST /webhook` → `WebhooksController#create`, routed by
`EventHandler` from `"#{params[:resource]}.#{params[:event]}"`.

| Topic | Real in Fluid? | Handler | Registered at |
|---|---|---|---|
| `droplet.installed` | Yes (`topic_registry.rb:33`) | `DropletInstalledJob` | `config/initializers/event_handler.rb:13` |
| `droplet.uninstalled` | Yes (`topic_registry.rb:33`) | `DropletUninstalledJob` | `event_handler.rb:12` |
| `order.external_id_synced` | Yes (`topic_registry.rb:46`) | `FluidOrderExternalIdUpdatedJob` | `event_handler.rb:16` |

`company_droplet.created` is commented out at `event_handler.rb:11` with a TODO. It is not a topic
in `topic_registry.rb`; the TODO's suspicion is correct and the line should be deleted, not ported.

### 2.3 Non-Fluid inbound surface (these are the money paths)

| Route | Source | Handler |
|---|---|---|
| `POST /webhooks/moola/p2m` | **Moola / uPayments**, not Fluid | `MoolaWebhooksController#p2m` (`config/routes.rb:9`) |
| `GET /checkout/success/:cart_token/payment_account/:payment_account_id` | **The customer's browser**, redirected by uPayments' hosted checkout | `CheckoutCallbackController#success` (`config/routes.rb:22-24`) |

The `success` route is neither a callback nor a webhook. It is the `redirectUrl` handed to
uPayments in the order payload (`u_payments_order_payload_generator.rb:22`). Treating it as a
callback in the Next port would be a category error — it is a browser navigation, the response is
a 302, and it has no shared secret with anyone. See §3.2.

### 2.4 Outbound to Fluid

| Call | Site |
|---|---|
| `GET /api/customers?search_query=…&page=1&per_page=1` | `checkout_callback_controller.rb:29` |
| `POST /api/customers` | `checkout_callback_controller.rb:40` |
| `POST /api/v202506/payments/:payment_account_id` | `checkout_callback_controller.rb:128` |
| `POST /api/carts/:cart_token/checkout?payment_uuid=…` | `checkout_callback_controller.rb:135` |

`POST /api/v202506/payments/:payment_account_id` is real — fluid
`config/routes/storefront/api_commerce_engine.rb:186`, `to: "payments#create"` inside
`namespace :api` → `namespace :v202506`. No invented endpoints were found in this droplet.

Note the `README.md` still documents `POST /api/company/webhooks` for manually creating the
droplet lifecycle webhooks. That is a pre-existing doc, not code, and it is out of scope; but do
not port that README text forward without checking the endpoint still exists.

---

## 3. Money-path risk

This is the section that decides whether the migration is safe. Read every subsection before
writing a route handler.

### 3.0 The paths, and what each one can do that cannot be taken back

```
  Fluid checkout                 uPayments hosted            Moola
       │                            checkout                    │
       │ ① redirect_cart_payment        │                       │
       ▼                                │                       │
  POST /get_redirect_url ───► ByDesign create consumer  (IRREVERSIBLE)
       │                └────► Fluid create customer     (IRREVERSIBLE)
       │                └────► uPayments create order    (semi: order can expire)
       │                                │                       │
       │◄──── redirect_url ─────────────┘                       │
                                        │  customer pays        │
                                        ▼                       │
  ② GET /checkout/success/… ◄──── browser 302                   │
       ├──► Fluid POST payments/:id     (IRREVERSIBLE — creates a payment record)
       └──► Fluid POST carts/:t/checkout (IRREVERSIBLE — creates an order)
                                                                │
  ③ POST /webhooks/moola/p2m ◄──────────────────────────────────┘
       └──► moola_payments row updated
                │
  ④ order.external_id_synced (Fluid webhook) ──► attach ByDesign OrderID
                │
                ▼  when both ③ and ④ have landed and KYC == APPROVE
  ⑤ ByDesignPaymentRecordingJob
       ├──► ByDesign POST /api/Personal/Order/Payment/CreditCard/Save  (IRREVERSIBLE, PER PAYMENT)
       └──► ByDesign POST /api/order/Order/{id}/Post                   (IRREVERSIBLE)
```

### 3.1 Idempotency keys — what exists, what only looks like one

| Path | Idempotency mechanism | Verdict |
|---|---|---|
| ③ Moola webhook → row | `MoolaPayment.find_or_create_by!(cart_token:)` (`moola_p2m_webhook_job.rb:72`) over a **genuinely unique** index (`db/migrate/20260121000001_create_moola_payments.rb:37`), plus `RecordNotUnique` rescue at `:75` | **Real.** Replaying the same webhook does not create a second row. |
| ③ payment lines within the row | `merge_payment_details` keys by `pd["id"]` (`moola_p2m_webhook_job.rb:145-166`) | **Real.** Re-delivery merges rather than appends. Status is monotone toward `Success` via `better_status` (`:178`). |
| ⑤ enqueue of the recording job | pessimistic lock + `update_columns(status: :recording)` inside a transaction (`moola_payment.rb:132-143`) | **Real for concurrent enqueue.** Two simultaneous webhooks cannot both enqueue. **Does not protect against sequential re-enqueue** — see §3.3. |
| ⑤ ByDesign `CreditCard/Save` | **None.** No `Idempotency-Key` header. `ReferenceNumber: payment_detail["id"]` (`by_design_payment_service.rb:238`) is a stable per-payment identifier | **Looks idempotent, is not verified.** Whether ByDesign rejects a second Save with the same `ReferenceNumber` on the same `OrderID` is unknown to this repo. Nothing in the droplet checks for an existing payment before posting. **This is the single most important unknown in the whole migration.** |
| ⑤ ByDesign `Order/{id}/Post` | **None.** Guarded only by `should_post_order?` and the fact it runs after a successful `update!` | Posting an already-Posted order is presumably a no-op or an error, but this is not verified either. |
| ② Fluid payment + checkout | **None.** No dedupe on `cart_token`, no check that a payment already exists | See §3.2. |
| ① ByDesign `create_consumer` | **None.** `by_design.rb:20-24` posts unconditionally when the uPayments user lookup returns `status: 0` | A retried callback with the same cart creates a second ByDesign consumer. |

**Required before any code is written:** confirm with ByDesign whether
`POST /api/Personal/Order/Payment/CreditCard/Save` de-duplicates on `ReferenceNumber` (or accepts
an idempotency key). If it does not, the Next implementation must carry its own dedupe — a
`bydesign_payment_receipts` table keyed on `(bydesign_order_id, payment_detail_id)` written in the
same transaction as the response, checked before every Save. That table does not exist today and
is the main schema addition this migration should make.

### 3.2 The `checkout/success` landing page — the highest-severity finding

`CheckoutCallbackController#success` (`checkout_callback_controller.rb:113-156`):

1. Has **no authentication of any kind**. `skip_before_action :verify_authenticity_token` at
   `:2`, and no `before_action` on the class.
2. Decides whether payment succeeded by reading `params[:status]` — `extract_status` at
   `:233-246` reads it straight from the query string, with a fallback that parses it out of a
   literally-concatenated `payment_account_id` (`:239-243`).
3. On `status == "SUCCESS"` it calls Fluid to **create a payment** (`:128`) and then to
   **check the cart out into an order** (`:135`).
4. It never asks uPayments whether the payment actually happened.

So the authority for "this cart was paid for" is a query-string parameter supplied by whoever
loads the URL. The customer sees this URL in their own address bar. Two consequences:

- **Forgery.** Anyone holding a `cart_token` can complete checkout without paying by requesting
  `/checkout/success/<token>/payment_account/<id>?status=SUCCESS`.
- **Replay.** The customer refreshing the page re-runs steps 3 and 4. Whether Fluid rejects a
  second checkout of an already-checked-out cart is not verified here; the payment `POST` at
  `:128` happens first and unconditionally, so at minimum a duplicate Fluid payment record is
  plausible. `ensure_moola_payment_link` (`:320-353`) is idempotent, so the `moola_payments` row
  survives, but that is the only part that is.

**This must not be ported as-is.** The Next implementation must verify the payment out-of-band
before touching Fluid — either by querying uPayments for the order's state using the invoice
number, or by refusing to act on the browser redirect at all and driving checkout from the
authenticated Moola webhook (③) instead, with the browser route reduced to a pure 302 to the
order confirmation or back to checkout.

I have not verified whether this has been exploited. I have no production data access and make no
claim about it.

### 3.3 Where a retry double-records to ByDesign

`ByDesignPaymentRecordingJob` has the shape the brief warned about — `retry_on StandardError,
attempts: 5` (`by_design_payment_recording_job.rb:4`), an irreversible external call in the middle,
and a rescue that puts the record *back into a retryable state* before re-raising.

`ByDesignPaymentService.record_payment` rescues `StandardError` internally
(`by_design_payment_service.rb:173-176`) and returns `{success: false}`, so HTTP failures do not
raise. That narrows the window but does not close it. Three concrete double-record paths:

**(a) Post-success raise on the status write.** `perform` records all payments (`:21`), then
`@moola_payment.update!(status: :recorded, recorded_at:)` at `:25-28`. If that write raises —
connection blip, lock timeout, validation — the outer `rescue StandardError` at `:36` calls
`handle_error`, which sets `status` back to **`:matched`** (`:175-181`) and re-raises. `retry_on`
schedules attempt 2. `claim_for_recording` (`:48-59`) accepts `:matched`, and
`record_payments_to_bydesign` maps over **every** recordable payment again. All payments are
re-Saved to ByDesign.

**(b) Post-success raise while posting the order.** `post_order_if_eligible` runs *after* the
`:recorded` write (`:32`). `ByDesignPaymentService.post_order` rescues internally, but
`@moola_payment.update!(order_posted_at: Time.current)` at `:149` does not. A raise there lands in
the same `:36` rescue, which **regresses the status from `:recorded` back to `:matched`** and
retries — re-recording every payment on an order that has already been posted.

**(c) Partial failure — the most likely one in practice.** `results.all? { |r| r[:success] }` at
`:24`. If two payments are attached to a cart and one Save succeeds while the other returns a
non-2xx, `handle_recording_failure` (`:161-173`) increments the attempt counter and sets status
back to `:matched`. The job then ends *normally* — nothing re-enqueues immediately. But the record
is now sitting in `:matched` with `ready_to_record?` true, so the **next** Moola webhook re-send
for that cart calls `update_status_and_enqueue_if_ready!`, which claims it and enqueues a fresh
recording job — which re-Saves the payment that already succeeded. There is no per-payment record
of which Saves landed.

PR #65 (`ff29ed2`) added terminal-state guards to `moola_p2m_webhook_job.rb:81, 102`,
`fluid_order_external_id_updated_job.rb:42`, and `moola_payment.rb:50`. Those close the case where
a late webhook arrives after `:recorded`. They do **not** close (a), (b), or (c), because all three
put the record back into a non-terminal state first.

**Correct failure behaviour, and what the port must do:**

- Persist per-payment success, not per-record success. A `bydesign_payment_receipts` row written
  immediately after each successful Save, checked before each Save. Then a retry is genuinely
  idempotent regardless of which state the parent row is in.
- Never regress out of `:recorded`. `handle_error` must not touch status when the current status
  is already terminal.
- Move `post_order` out of the recording job's error envelope entirely, into its own job keyed on
  `order_posted_at IS NULL`.
- If the ByDesign API does turn out to dedupe on `ReferenceNumber`, keep the receipts table
  anyway — it is what makes the *migration* safe (§3.5), independent of the API's behaviour.

### 3.4 Webhook authentication

**The Moola/uPayments webhook is almost certainly unauthenticated in production.**

`MoolaWebhooksController` verifies an HMAC-SHA256 signature — but only conditionally:

```ruby
before_action :verify_webhook_signature, if: :signature_verification_enabled?   # :3
def signature_verification_enabled?
  ENV["MOOLA_WEBHOOK_SECRET"].present?                                          # :51
end
```

If `MOOLA_WEBHOOK_SECRET` is unset, the endpoint accepts anything. It **fails open by
construction**. Evidence that it is unset in production:

- `MOOLA_WEBHOOK_SECRET` appears in exactly two places in the entire repository, both inside
  `moola_webhooks_controller.rb` (lines 51 and 72). It is in no deploy artefact.
- `docs/gcp-environment-variables.md` enumerates every environment variable for the Cloud Run
  service, split into "Sensitive (Secret Manager)" and "Non-Sensitive". `MOOLA_WEBHOOK_SECRET`
  is in neither list.
- It is not in `.env`, not in `.env.local.example` (which is empty), not in `terraform/`, not in
  `cloudbuild.yml`, and not in `.github/workflows/deploy-production.yml`.

**To confirm rather than infer**, run (names only, no values):

```
gcloud run services describe fluid-droplet-newulife-payment \
  --region=europe-west1 --project=fluid-417204 \
  --format='value(spec.template.spec.containers[0].env[].name)'
```

If it is absent, the Moola webhook is open, and an unauthenticated caller can post a payload with
a crafted `invoice_number` of the form `NULF-CT:<cart_token>` and arbitrary `payment_details`,
which flows straight into the ByDesign recording path. Setting the secret is a **prerequisite to
starting the migration**, not part of it — this is a live Rails-app problem, not a Next.js one.

The signature scheme itself is fine in shape (`OpenSSL::HMAC.hexdigest("SHA256", …,
request.raw_post)` compared with `secure_compare`, `:63-68`) but has two gaps to fix in the port:
it accepts two different header names (`X-Moola-Signature` or `X-Webhook-Signature`, `:55`) with
no documented reason, and there is no timestamp in the signed material, so a captured signed
request replays forever.

**The `redirect_cart_payment` callback is unauthenticated.** `CheckoutCallbackController` has no
`before_action` at all (`:1-2`). Anyone can POST a cart body to `/get_redirect_url` and cause a
ByDesign consumer to be created, a Fluid customer to be created, and a uPayments order to be
opened. In the Next port this must go through `withFluidCallback` with the tenant resolved from
`registration.dri` and nothing else — which means the callback registration must be re-done
through the SDK's registration flow so a verification token exists to check. Today there is no
token stored anywhere for this callback (§1, "template files this droplet does not have").

**The Fluid webhook endpoint is partly authenticated.** `WebhooksController#authenticate_webhook_token`
(`:26-54`) is a genuine improvement over the template — it compares only against
`company.webhook_verification_token` with `secure_compare` and has no droplet-wide shared token.
But `droplet.installed` skips it entirely (`:3`, `:22-24`), and unlike the template this droplet
**deleted `validate_droplet_authorization`** rather than keeping it for installation events
(confirmed: the identifier appears nowhere in `app/`, `lib/`, `config/`, or `test/`). So
`POST /webhook` with `{"resource":"droplet","event":"installed", "company": {...}}` and an
attacker-chosen `webhook_verification_token` will create or update a `companies` row
(`droplet_installed_job.rb:19-31`) — and every subsequent webhook then authenticates against that
attacker-supplied token.

### 3.5 Can a payment path run from both apps at once?

Yes, trivially, and nothing in the current architecture prevents it. Both apps would point at the
same Postgres database (that is the whole point of keeping the schema compatible), and:

- Fluid holds **one** callback registration URL and **one** webhook URL per company. Whichever
  host those point at receives the traffic. That part is a clean switch.
- Moola holds **one** webhook URL, configured on Moola's side, not ours. Switching it is a
  third-party change with its own lead time, and during that window Moola may deliver to the old
  URL, the new one, or both.
- uPayments has the `redirectUrl` **baked into every order already created**
  (`u_payments_order_payload_generator.rb:22` uses `ENV['DROPLET_HOST_URL']`). Orders opened
  before cutover will redirect customers to the *Rails* host after cutover, for as long as those
  orders remain payable.
- Solid Queue jobs already enqueued live in the same database. If the Rails workers are still
  running, they will pick up and execute `ByDesignPaymentRecordingJob` rows regardless of what the
  Next app is doing.

**What makes concurrent execution impossible is not a deploy order — it is a lock.** The only
thing that can actually prevent a double-record across two runtimes is a database-level claim
that both apps respect. Today that claim is the `:recording` status transition under
`SELECT … FOR UPDATE` (`moola_payment.rb:132-143`). A Prisma implementation must reproduce that
exactly — `$transaction` with a `SELECT … FOR UPDATE` on the row, not an optimistic
`updateMany({where: {status: 'matched'}})` — and the receipts table from §3.1 must be in place
*before* the two runtimes ever overlap, because status alone is not enough (§3.3c).

There is also an atomicity property that is easy to lose silently. `WebhookEventJob#perform`
wraps `process_webhook` in `ActiveRecord::Base.transaction` (`app/jobs/webhook_event_job.rb:20-22`),
and Solid Queue stores its jobs in the same Postgres instance (`db/schema.rb` — the
`solid_queue_*` tables). So today, the `status → :recording` write and the enqueue of
`ByDesignPaymentRecordingJob` commit or roll back **together**. If the Next app uses an external
queue (Redis/BullMQ/Cloud Tasks), that guarantee disappears: the row can be marked `:recording`
and the job never enqueued (stuck forever), or the job enqueued and the row rolled back (records
against a payment that was never matched). Either pick a Postgres-backed queue, or make the
recording job re-derive readiness from the row and treat the enqueue as a hint rather than a
claim. Say which, explicitly, in the implementation PR.

### 3.6 Fail-open vs fail-closed for *this* callback

The shared brief's rule — every callback returns HTTP 200 with a neutral body, auth failures
included, because a non-2xx is a broken cart — was written for cart-mutating callbacks. The brief
also notes the `update_cart_tax` exception, which must fail closed because Fluid preserves
existing tax on a non-2xx but *applies* a `200 {tax_total: 0}`. Neither rule transfers here
unexamined, so reason it out from the definition's own contract.

For `redirect_cart_payment` the response schema is
`anyOf: [required: [redirect_url], required: [error_message]]`. The two failure shapes are:

| Response | What Fluid does | Effect |
|---|---|---|
| `200 {"redirect_url": null, "error_message": "…"}` | Shows the message; customer stays on checkout | Customer cannot pay, but knows why. No money moves. |
| `200 {"redirect_url": "<something>"}` | Redirects the customer to that URL | Only correct if the URL is a real uPayments order |
| non-2xx | Undefined by the YAML; presumably a generic checkout error | Customer cannot pay, no message |

There is no "apply a zero" hazard here — there is no numeric field that Fluid will trust. And
there is no "preserve existing value" hazard either. So the correct behaviour is:

**Fail open in the HTTP sense, fail closed in the business sense.** Always return 200, never
return a `redirect_url` you are not certain points at a real, correctly-priced uPayments order.
The neutral body is `{"redirect_url": null, "error_message": "<generic>"}` — and per the brief it
must be byte-identical across auth failure, invalid body, and handler error, so it is not an
oracle telling an attacker which of the three they hit.

The current Rails code gets the *handled* paths right (`:43, 49, 61, 79, 103, 110` all render 200
with one of the two keys) but leaks 500s on unhandled ones — see the bug list, §8.2 and §8.3. In
the SDK port those become `onAuthFailure` / `onInvalidBody` / `onHandlerError`, all wired to the
same neutral body, which fixes the class of problem rather than the instances.

For the **Moola webhook**, the opposite rule applies and the current code already has it right:
refuse loudly. `head :unauthorized` on a bad signature (`moola_webhooks_controller.rb:59, 67`),
`head :bad_request` on unparseable JSON (`:14`), `head :internal_server_error` on anything else
(`:17`) so Moola retries. That is correct and should be preserved — with the one change that the
signature check must become unconditional (§3.4).

For the **`checkout/success` landing page**, neither rule applies: it is a browser navigation. Its
failure mode is a 302 back to `#{CHECKOUT_HOST_URL}/checkouts/#{cart_token}`
(`checkout_callback_controller.rb:148-149, 153-154`), which is the right shape — the customer
lands somewhere they can retry. Keep that. What must change is what the route is allowed to *do*
before redirecting (§3.2).

---

## 4. Secrets

### 4.1 What this droplet holds

| Credential | Env var | Purpose |
|---|---|---|
| ByDesign API username | `BY_DESIGN_INTEGRATION_USERNAME` | HTTP Basic, consumer + payment APIs |
| ByDesign API password | `BY_DESIGN_INTEGRATION_PASSWORD` | HTTP Basic |
| NewULife RSA private key | `NEWULIFE_PRIVATE_KEY` | Signs RS512 JWTs for the uPayments **users** API |
| NewULife API code | `NEWULIFE_API_CODE` | JWT `sub` claim |
| uPayments MC RSA private key | `UPAYMENTS_MC_PRIVATE_KEY` | Signs RS512 JWTs for the uPayments **checkout** API |
| uPayments MC API code | `UPAYMENTS_MC_API_CODE` | JWT `sub` claim |
| Moola webhook secret | `MOOLA_WEBHOOK_SECRET` | HMAC verification — **believed unset**, §3.4 |
| Fluid API key | `Setting.fluid_api.api_key` (**database**, not env) | Bearer token on every outbound Fluid call |
| Fluid per-company webhook token | `companies.webhook_verification_token` (database) | Inbound webhook auth |
| Fluid per-company auth token | `companies.authentication_token` (database) | Stored, unique-indexed |
| Rails master key | `RAILS_MASTER_KEY` | `config/credentials.yml.enc` |
| Initial admin password | `ADMIN_PASSWORD` | `setup:create_admin` rake task |
| Database URLs ×4 | Secret Manager, per `terraform/sql-resources/slq-resources.tf:48-151` | main / cache / queue / cable |

Storage: env vars are set **out-of-band** on Cloud Run. `terraform/cloud-run/main.tf:106` and
`migration-job.tf:77` both declare `lifecycle { ignore_changes = [ … containers[0].env ] }`, and
`add-update-env-gcloud.sh` is a hand-run `gcloud run services update` script still containing its
placeholder `EXAMPLE_VARIABLE` values. So the repository is **not** the source of truth for which
secrets are set, which is why §3.4's conclusion needs the `gcloud describe` confirmation.

### 4.2 Nothing secret is committed — with one caveat

- `.env` **is tracked in git** (it is not in `.gitignore`; only `.env.local` is). Every value in
  it is **empty** — it is a key-name template that was committed by accident and never populated.
  Verified by measuring value lengths, not by reading values. Still, an empty tracked `.env` in a
  payments repo is one careless `git add -f` away from being a real leak; the Next port should
  delete it and rely on `.env.local.example`.
- `.kamal/secrets` is tracked but contains only `$VAR` references and the template's own comments.
  Kamal is not the deploy path (Cloud Build → Cloud Run is); it is leftover template.
- `docs/gcp-environment-variables.md` lists variable **names** only. No values.
- `README.md:13` and `README.md:30` contain a `Authorization: Bearer …` token in curl examples.
  The host is `lvh.me:3000`, i.e. a local development Fluid instance, so this is very likely a
  throwaway dev token. **It should still be rotated and removed** — the value is short-lived only
  by assumption, and a Fluid API token in a public-shaped repo is the exact fleet finding that has
  bitten two sibling droplets. I have not verified whether the token is live.

### 4.3 Credentials and PII that get logged or rendered

These are the real exposure, and they all port forward unless deliberately fixed:

1. **`gem "httplog"` is in the default Gemfile group** (`Gemfile:25`, no `require: false`, not
   inside `group :development, :test`), and there is **no HttpLog initializer anywhere in the
   repo**. HttpLog instruments Net::HTTP on load and, at its defaults, logs request and response
   **bodies**. In production that means every ByDesign consumer payload, every ByDesign payment
   payload, and every uPayments request/response is written to Cloud Logging in full — including
   card last-4, expiry, `payment_instrument_uuid`, and full customer PII. Headers are not logged
   at HttpLog's default (`log_headers = false`), so the Basic credentials and JWTs are probably
   not in the logs — but that is one default away from being wrong, and it has never been pinned.
   **Do not port `httplog` into the Next app.** If equivalent tracing is wanted, use an explicit
   allow-list of fields.
2. `ByDesign#create_consumer` logs the full request payload (`by_design.rb:18`) and the full
   response body (`:27`) at `info`. The payload includes name, email, and full shipping and
   billing address.
3. `CheckoutCallbackController` logs the full uPayments order payload (`:94`), the full uPayments
   response (`:98`), the full Fluid payment response (`:131-132`), and the full Fluid checkout
   response (`:137-138`) at `info`.
4. `MoolaWebhooksController#sanitized_log_params` (`:32-48`) is the one place that does redact —
   it strips `card_number`, `card_number_last4`, `expiry_date`, `payment_instrument_uuid`, `cvv`
   and others before logging. Good, and it should be the model for the whole app. Note that the
   **unredacted** payload is then passed to `MoolaP2mWebhookJob.perform_later` (`:10`) and stored
   whole in `moola_payments.moola_webhook_payload`, so the database holds what the log does not.
5. `config/initializers/filter_parameter_logging.rb` filters `passw`, `token`, `_key`, `secret`,
   `cvv`, `ssn`, `email` from *Rails parameter* logging. It has no effect on any of the explicit
   `Rails.logger.info` calls above, and no effect on HttpLog.
6. **The Fluid API key is rendered in the admin UI to any signed-in user.**
   `app/views/admin/settings/index.html.erb:19` calls `format_settings_values(setting.values)`,
   which (`app/helpers/application_helper.rb:3-11`) renders the first four key/value pairs
   verbatim and marks them `html_safe`. The `fluid_api` setting has exactly two keys —
   `base_url` and `api_key` (`lib/tasks/settings.rb:43-64`) — so the key is always shown.
7. That page is behind `authenticate_user!` (`app/controllers/admin_controller.rb:3`) — so unlike
   the sibling droplet's finding, it is *not* on an unauthenticated page. **But Devise
   `:registerable` is enabled without `:confirmable`** (`app/models/user.rb:4-5`) and
   `config/routes.rb:5` is a bare `devise_for :users` with no `skip: :registrations`. So anyone
   who can reach the droplet's public host can self-register at `/users/sign_up` and immediately
   read the Fluid API key. `Admin::SettingsController` never calls `authorize!`, so an empty
   `permission_sets` array is no obstacle.
8. Same reasoning applies to `/jobs` — Mission Control is mounted at `config/routes.rb:26` with
   `base_controller_class = "AdminController"` and `http_basic_auth_enabled = false`
   (`config/application.rb:29-30`). A self-registered user can browse Solid Queue job arguments,
   which include the **unredacted** Moola webhook payloads passed at
   `moola_webhooks_controller.rb:10`.

Items 6–8 together are a live issue in the Rails app, independent of the migration. Disabling
self-registration is a one-line fix and should not wait for the port.

### 4.4 What the port must do about secrets

- Masked rendering for any setting value whose key matches `key|token|secret|password`, in the
  Next admin settings page. Show a fingerprint, not the value.
- Drop `:registerable`. Admin users are created by an ops action, not self-service.
- Do not carry `httplog` or an equivalent forward.
- Move the Fluid API key out of the `settings` table and into an environment variable / Secret
  Manager reference during the port. It is the only credential of the twelve that currently lives
  in a user-editable database row rendered in a web page.

---

## 5. Data — Rails schema to Prisma

### 5.1 Tables

Application tables (six). The `solid_queue_*` (12 tables) and `solid_cache_entries` are runtime
infrastructure, not application data — see §7.

| Rails table | Rows this droplet writes | Prisma model | `@@map` |
|---|---|---|---|
| `companies` | one per installation | `Company` | `@@map("companies")` |
| `events` | `EventHandler` audit | `Event` | `@@map("events")` |
| `moola_payments` | **the money ledger** | `MoolaPayment` | `@@map("moola_payments")` |
| `settings` | droplet config incl. `fluid_api` | `Setting` | `@@map("settings")` |
| `users` | admin logins | `User` | `@@map("users")` |
| `webhooks` | vestigial, 2-line model | `Webhook` | `@@map("webhooks")` |

There is **no `callbacks` table and no `integration_settings` table** in this database. The shared
Prisma schema from `droplet-template#200` declares both (`model Callback`, `model
IntegrationSetting`). They must be **removed** from this droplet's copy, or `prisma db push` will
create two empty tables in a live payments database. `droplet-template#200`'s `Company` model also
carries an `installedCallbackIds Json?` field mapped to `companies.installed_callback_ids`; that
column does not exist here either, and must not be added — zallevo hit the same gap and solved it
by reading the uuid set from `fluid_callback_registrations` keyed on `dri`, which is the right
answer here too.

The **one additive table** is the SDK's:

```prisma
model FluidCallbackRegistration {
  uuid           String @id
  dri            String
  definitionName String @map("definition_name")
  tokenDigest    String @unique @map("token_digest")
  url            String
  createdAt      DateTime @default(now()) @map("created_at")
  updatedAt      DateTime @updatedAt      @map("updated_at")
  @@index([dri])
  @@map("fluid_callback_registrations")
}
```

Copy it verbatim from `vendor/droplet-sdk/schema/callback-registrations.prisma`; keep it identical
across the fleet. Only the digest is stored — Fluid presents the plaintext token on every request,
so a digest is enough to locate the registration, and a database dump then yields no working
callback credentials. It is additive and the Rails app neither reads nor writes it, which is what
makes the two runtimes able to share the database during Phase 4.

### 5.2 Index semantics — checked, and they agree

The brief's concern is exact, and it is a settled rule rather than a hypothetical. Template PR
#200 declared `integrationSetting.companyId @unique` where `db/schema.rb` had a plain
`t.index ["company_id"]`. It was caught by the zallevo migration and fixed upstream in commit
`b11972f`, whose message states the rule:

> That divergence is not cosmetic: the deploy runs `prisma db push`, so it would try to add a
> unique constraint to a live table — failing outright if any company has more than one
> `integration_settings` row, and silently tightening the schema if none does. A migration PR
> should reproduce the database it inherits, not quietly reshape it.

Two corollaries carried in #200's schema header, both of which apply here: reproduce indexes
exactly, and **look non-unique columns up with `findFirst`, never `findUnique`**. `findUnique` on a
non-unique column is a Prisma type error, so the mistake usually surfaces at compile time — but
only if the schema is honest about the index in the first place.

I compared `db/schema.rb` against every migration in `db/migrate/`. **They agree.** Full mapping
for `moola_payments`, the table that matters:

| Column | `db/migrate/20260121000001_create_moola_payments.rb` | `db/schema.rb` | Prisma |
|---|---|---|---|
| `cart_token` | `add_index …, unique: true` (`:37`) | `unique: true` | `@unique` — **the only one** |
| `invoice_number` | `add_index` (`:38`) | non-unique | `@@index([invoiceNumber])` |
| `moola_transaction_id` | `add_index` (`:39`) | non-unique | `@@index([moolaTransactionId])` |
| `fluid_order_id` | `add_index` (`:40`) | non-unique | `@@index([fluidOrderId])` |
| `bydesign_order_id` | `add_index` (`:41`) | non-unique | `@@index([bydesignOrderId])` |
| `status` | `add_index` (`:42`) | non-unique | `@@index([status])` |
| `(status, created_at)` | `add_index …, %i[status created_at]` (`:43`) | non-unique | `@@index([status, createdAt])` |

`invoice_number` is the one to watch. It is `NULF-CT:{cart_token}` (`moola_payment.rb:31`), so it
is functionally 1:1 with `cart_token` and **looks** unique in every row you will ever inspect. It
is not unique in the schema, there is no `validates … uniqueness` on it (`moola_payment.rb:14-16`
validates presence only), and `moola_p2m_webhook_job.rb:72` sets it from webhook input on create.
Declaring `@unique` on it because the data looks that way is precisely the #200 mistake. Do not.

`companies`: `authentication_token` is unique in both the migration (`20250411062613:18`) and
`schema.rb`. `fluid_shop`, `fluid_company_id`, `company_droplet_uuid`, `active` are all non-unique
in both. `settings.name` is unique in both. `users.email` and `users.reset_password_token` are
unique in both.

### 5.3 `prisma db pull` is still required

Schema and migrations agreeing proves the *repository* is self-consistent. It does not prove the
production database matches, because:

- `db/schema.rb` is regenerated from whatever database the developer last ran against.
- The Cloud Run migration job (`cloudbuild.yml`, step `migrate`) runs on every deploy, so
  production should be at `20260410000001` — but nothing in the repo attests to that.
- `companies.settings` is `jsonb default {}` and `service_company_id` is a column with no
  migration comment and no code reference; columns like that are how drift hides.

**Run `prisma db pull` against a read-only replica or a restored snapshot of production and diff
the result against the hand-written schema before the first `db push`.** Treat any difference as
a blocker, not a merge conflict to resolve in Prisma's favour.

### 5.4 Type mapping

| Rails | Prisma |
|---|---|
| `bigserial` PK (`t.id`) | `BigInt @id @default(autoincrement())` |
| `t.bigint` (`fluid_company_id`, `company_id`) | `BigInt` |
| `t.jsonb` (`payment_details`, `card_details`, `moola_webhook_payload`, `fluid_webhook_payload`, `values`, `schema`, `settings`, `payload`) | `Json` |
| `t.integer status, default: 0` (Rails enum) | `Int` — **keep it an Int**, do not convert to a Prisma enum; the on-disk values are 0–6 and a `db push` enum conversion would rewrite the column |
| `t.string permission_sets, array: true` | `String[]` |
| `t.text last_error` | `String? @db.Text` |
| `t.datetime` | `DateTime` |
| `add_foreign_key "events", "companies"` | relation on `Event.companyId` |

The `status` mapping deserves emphasis. `MoolaPayment` maps `pending: 0 … kyc_declined: 6`
(`moola_payment.rb:3-11`). The Next code should carry a TypeScript const object with the same
numeric values and a compile-time exhaustiveness check, backed by an `Int` column. A Prisma
`enum` here would be prettier and would require a destructive column type change on a live
payments table.

### 5.5 New table this migration should add

```
bydesign_payment_receipts
  id                  bigserial pk
  bydesign_order_id   string  not null
  payment_detail_id   string  not null      -- payment_details[].id from Moola
  recorded_at         datetime not null
  response            jsonb
  unique index on (bydesign_order_id, payment_detail_id)
```

This is what makes §3.3 fixable and what makes the two-runtime overlap in §3.5 survivable. It
should be added **to the Rails app first**, in its own PR, before any Next.js code exists — see
Phase 0.

---

## 6. Sequenced phases

The ordering constraint that governs everything: **the payment path must never be half-migrated.**
Specifically, `redirect_cart_payment` (①), the uPayments return (②), the Moola webhook (③), and
the ByDesign recording (⑤) form one transaction spanning minutes to hours. A cart can enter at ①
in one runtime and arrive at ⑤ in another. So they cut over together, or they do not cut over.

Seven phases. Each has an explicit verification gate; do not start the next until the gate passes.

---

### Phase 0 — Fix the live Rails app (no Next.js code at all)

This is not migration work. It is removing the reasons the migration is dangerous, while there is
still only one runtime to reason about.

1. Set `MOOLA_WEBHOOK_SECRET` in Cloud Run and coordinate the shared secret with Moola. Then make
   the check **unconditional** — delete `signature_verification_enabled?`, fail closed if the env
   var is missing at boot.
2. Add `bydesign_payment_receipts` (§5.5) and make `ByDesignPaymentService.record_payment` check
   it before every Save and write it immediately after. This alone removes §3.3 (a), (b) and (c).
3. Stop `handle_error` regressing out of `:recorded` (`by_design_payment_recording_job.rb:175-181`).
4. Move `post_order` to its own job.
5. Authenticate `checkout/success` (§3.2) — verify the payment against uPayments before calling
   Fluid, rather than trusting `params[:status]`.
6. Restore an authorization check on `droplet.installed`, equivalent to the template's
   `validate_droplet_authorization`.
7. Remove `gem "httplog"`; disable Devise `:registerable`; mask secret-shaped setting values in
   the admin view.

**Gate:** all seven merged and deployed; one full test payment end-to-end in the real environment;
Cloud Logging shows no card data and no PII in the ByDesign or uPayments log lines.

Rationale for doing this in Rails rather than "fixing it in the port": every one of these is a bug
that is live *today*. Deferring them to a Next.js PR means they stay live for the length of the
migration, and it entangles "did we port this correctly?" with "did we fix this correctly?" in the
same diff — which is exactly what makes payment code unreviewable.

---

### Phase 1 — Shared layer, from the template

Take the shared-layer Next app produced by the `droplet-template` migration and land it here,
**alongside** the Rails app (the brief's rule: do not delete Rails in the same PR). Nothing in
this phase touches money.

- Next app skeleton per §10, `src/`-rooted, `pnpm`, `Dockerfile.next`, `ci-next.yml` **alongside**
  the existing `ci.yml`. `yarn` → `pnpm` is the only ripple the Rails side feels.
- **Vendor the SDK** at `vendor/droplet-sdk`, depended on as
  `"@fluid-studios/droplet-sdk": "link:./vendor/droplet-sdk"` — see §10.2, this contradicts the
  shared brief and the reference implementation is right.
- Prisma schema for the six tables (§5.1), **minus** `callbacks` and `integration_settings`,
  **plus** `FluidCallbackRegistration`, with `@@map`/`@map` throughout and index semantics
  per §5.2.
- Auth.js credentials provider against `users.encrypted_password`. **Verified for this repo:**
  `config.pepper` is commented out (`config/initializers/devise.rb:129`), `config.stretches = 12`
  (`:126`), and `case_insensitive_keys`/`strip_whitespace_keys` are both `[:email]` (`:61`, `:66`).
  So the digest is a plain bcrypt hash with no suffix, `bcryptjs` verifies it directly, and
  existing admin rows keep working with no password reset. Pin `bcryptjs` to **2.x** — it emits
  `$2a$`, the same prefix bcrypt-ruby writes, so both apps can read each other's rows while they
  run side by side. Sessions are JWT, not database-backed: a `sessions` table would be a schema
  change on a database Rails also owns.
- Admin UI: dashboard, settings (with §4.4 masking), users CRUD. No callbacks admin — there is no
  `callbacks` table here (§1).
- `src/app/api/health/route.ts`.
- `withFluidWebhook`-based `POST /webhook` handling `droplet.installed` and `droplet.uninstalled`
  only. Not `order.external_id_synced` — that one is on the money path.
  `bootstrapEvents: [INSTALL_EVENT, "droplet.uninstalled"]`, everything else requires the
  company's own `webhook_verification_token`. This is the structural fix for §8.6 and §8.7:
  `resolve()` keys on `droplet_installation_uuid` first, then `fluid_company_id`, and never on
  `company_droplet_uuid`.

**Gate:** `prisma db pull` from a production snapshot diffs clean against the committed schema
(§5.3). The Next app boots against a copy of the production database and does not write to it.
An existing admin user signs in with their existing Devise password. No Fluid registration points
at the Next host yet.

---

### Phase 2 — Read-only shadow of the money path

Build every money-path handler in Next, deployed, reachable, and **wired to nothing**. Fluid and
Moola still point at Rails.

- `redirect_cart_payment` route via `withFluidCallback` (definition name exactly
  `redirect_cart_payment`, tenant from `registration.dri` only), with all three failure hooks
  wired to the identical neutral body from §3.6.
- The Moola webhook route, unconditional HMAC.
- The `checkout/success` route, in its Phase-0-corrected form.
- The recording pipeline, including the receipts check.
- The uPayments and ByDesign clients, with the RS512 JWT signing ported.

Then run them against **captured production payloads** — `moola_payments.moola_webhook_payload`
and `.fluid_webhook_payload` are stored on every row, so there is a real corpus to replay. Every
outbound HTTP client is stubbed. Assert byte-equality of the generated ByDesign and uPayments
payloads against what Ruby produces for the same input.

**Gate:** payload-equality tests pass over a sample of at least 50 historical `moola_payments`
rows covering card, cash, wallet, KYC `APPROVE`/`REVIEW`/`DECLINE`, and multi-payment carts.
Any divergence is understood and deliberate, not merely observed.

---

### Phase 3 — Registration through the SDK, still pointed at Rails

Do the SDK registration work while the traffic is still going to Rails, so a mistake here costs a
re-registration and not a cart. The SDK README's three-step rollout order is not optional and the
reason is worth internalising: **there is no observe mode.** The SDK removed it deliberately,
because every automatic rule for "when may an unverified request still run?" was wrong in one
direction or the other — keying on "did we find a token" lets a caller opt into tolerance by
omitting the token; keying on "does this route have tokens stored" flips for the whole fleet the
moment the first installation is migrated. The question is answered by the rollout, not per
request. So:

**3a — ship registration and backfill, wrap nothing.** Add `FluidCallbackRegistration`, apply it
with `prisma db push` (this fleet has no Prisma migration files), and wire
`backfillCallbackTokens` into the install handler. Behaviourally inert.

- Register `redirect_cart_payment` through the SDK's flow so a `verification_token` exists.
  Capture it from the **create** response only — on fluid `master` the sole writer is
  `before_create :set_tokens` and the update action refuses the field, so it can never be re-read
  or rotated. Store `tokenDigest(...)`, never the plaintext, and **delete the registration you
  just created** if the token is absent or the digest write fails, rather than leave a live
  registration this droplet can never verify.
- `listCallbacks` must forward `{page, per_page}`. Fluid's index defaults to `per_page: 10`; the
  SDK uses `PAGE_SIZE = 100`, `MAX_PAGES = 50`.
- Match `ownUrls` **exactly**, not by origin. `GET /api/callback/registrations` is *company*-scoped
  and returns other droplets' registrations with no owner filter, and `owner_id` cannot
  discriminate (it renders a numeric DropletInstallation id, not the `dri_` slug). Origin matching
  is insufficient: another droplet registering one of our definition names at any path on our host
  would be adopted, because the wrapper matches on `definitionName`, not URL.

**3b — run the backfill to a zero exit.** `pnpm backfill:callbacks`, **by hand**, from a terminal
holding production `DATABASE_URL` and `FLUID_DROPLET_URL`. Not in the deploy workflow: that job has
the database secret but not per-installation Fluid credentials, and a partial backfill inside CI
would let the deploy proceed anyway — which is the failure this ordering exists to prevent. Stage
the full replacement set, validate, swap in one transaction; never delete an installation's
digests before the replacements are in hand.

Note this is **net-new**, not a port: this droplet has no callback table, no sync service and no
stored token today (§1). There is exactly one registration to backfill, which makes this the
easiest phase in the plan — and the one whose omission would silently break Phase 4, because a
callback refusal answers 200.

**Gate:** the registration exists, its digest is stored, the plaintext is nowhere, the backfill
exits zero, and the URL still points at the Rails host. A deliberate wrong-token request to the
Next route returns the neutral 200 body, byte-identical to the no-op body.

---

### Phase 4 — Cut over the callback only

This is the SDK rollout's step **3c** — wrap the route and deploy — plus the registration
repoint. Both happen in the same deploy: a half-wrapped droplet has an unauthenticated mutating
route sitting next to a verified one. There is only one callback here, so "every callback route in
the same deploy" is trivially satisfied.

Repoint `redirect_cart_payment` at the Next host. Rails keeps ②③④⑤.

This is safe to split out because ① is the only leg with no persistent state: it reads a cart,
calls three APIs, and returns a URL. Its only durable side effects are the ByDesign consumer and
the Fluid customer, both of which are created before any money moves, and both of which the Rails
app will happily find on a subsequent attempt.

**Gate:** run for a full business cycle. Compare `redirect_url` issuance rate and
`error_message` rate against the Rails baseline. Zero increase in ByDesign consumer creations per
cart (that would mean the "does this user exist" lookup is behaving differently).

**Rollback:** repoint the registration at Rails. One API call, no data to unwind.

---

### Phase 5 — Cut over ②③④⑤ together, with Rails workers stopped

The one irreversible step. Everything in this phase happens in a single maintenance window.

Order within the window:

1. **Drain.** Stop accepting new checkouts (or accept that carts opened now will complete on the
   Next side). Wait for `moola_payments` to have no rows in `:pending`, `:matched` or `:recording`
   older than the drain start.
2. **Stop the Rails Solid Queue workers.** Not the web process yet — the uPayments `redirectUrl`
   baked into already-open orders still points at Rails (§3.5), so the Rails web process must keep
   answering `/checkout/success` until those orders age out. But no Rails worker may be able to
   pick up a recording job.
3. Repoint the Moola webhook URL (third-party change, arrange ahead of the window).
4. Repoint `order.external_id_synced` and the `droplet.*` webhooks at the Next host.
5. Change `DROPLET_HOST_URL` so **new** uPayments orders carry the Next redirect URL.
6. Leave the Rails `/checkout/success` route live, but reduced to a 302 that forwards to the Next
   host's equivalent route. Old orders then complete correctly.

**Gate:** first live payment observed end-to-end through the Next app — `redirect_url` issued,
customer pays, `checkout/success` verified and checked out, Moola webhook received and verified,
`order.external_id_synced` received, ByDesign Save recorded, receipt row written, order posted.
Watch a full day before Phase 6.

**Rollback:** this is where rollback stops being free. Repointing Moola back is a third-party
change with lead time; `moola_payments` rows written by the Next app during the window are
schema-compatible and Rails can resume them, but any receipt rows Rails does not know about are
invisible to it — which is why the receipts table goes into **Rails** in Phase 0, not into Next.

---

### Phase 6 — Retire the Rails app

Only after the oldest possible uPayments order has expired (confirm the window with uPayments;
do not guess it).

- Delete `app/`, `lib/tasks/`, `Gemfile`, `config/`, `db/migrate/`.
- Keep `db/schema.rb` in the repository history as the provenance record for the Prisma schema.
- Migrate Solid Queue's persisted state or accept its loss — by this point it must be empty.

**Gate:** two consecutive weeks with zero traffic to the Rails host.

---

## 7. What I would not migrate

| Thing | Why not |
|---|---|
| `app/jobs/droplet_reinstalled_job.rb` | Dead code. Never registered in `event_handler.rb`, and `droplet.reinstalled` is not a topic in Fluid's `Webhook::TopicRegistry` (line 33 lists only `installed`, `uninstalled`). Delete it. |
| `EventHandler.register_handler("company_droplet.created", …)` | Already commented out (`event_handler.rb:11`) with a TODO doubting it exists. It does not exist in `topic_registry.rb`. Delete the line and the TODO. |
| `gem "httplog"` | §4.3 item 1. It is a production PII firehose with no configuration. Do not replace it with anything until someone writes down what they actually want traced. |
| Devise `:registerable` and the sign-up views | §4.3 item 7. Self-registration on a payments droplet's public host is not a feature. Admin users get created by an ops action. |
| `.kamal/`, `config/deploy.yml`, `gem "kamal"` | Deploy is Cloud Build → Cloud Run (`cloudbuild.yml`, `.github/workflows/deploy-production.yml`). Kamal is unused template residue. |
| `app.json` | Heroku manifest, still describing itself as "Droplet Template". The app is on Cloud Run. |
| `add-update-env-gcloud.sh` | Still contains `EXAMPLE_VARIABLE=example_value` placeholders. It is a hand-run script that has never been correct. If out-of-band env management is still wanted, replace it with Terraform-managed `environment_secrets` rather than porting the script. |
| `solid_queue_*` (12 tables), `solid_cache_entries` | Runtime infrastructure for a Rails runtime that will not exist. They should not appear in `schema.prisma`. Whatever queue the Next app uses brings its own storage — and per §3.5, that choice has correctness consequences, so make it deliberately. |
| `.env` (tracked, empty) | §4.2. Delete it; keep `.env.local.example`. |
| The `webhooks` table and `app/models/webhook.rb` | A 2-line model over a 5-column table that no code reads or writes. It is template residue. Keep the **table** (dropping tables in a live database for tidiness is not worth it) but do not model it in Prisma. |
| The `README.md` curl examples | §4.2. They embed a Bearer token and document `POST /api/company/webhooks`, which I did not verify still exists. Rewrite from what the code actually does. |

---

## 8. Real bugs found, with evidence

Separated from the migration plan because they are all live in the Rails app today. Ordered by
severity.

### 8.1 `checkout/success` accepts payment success from the query string — **critical**

`app/controllers/checkout_callback_controller.rb:113-156`, with `extract_status` at `:233-246`.
No authentication on the route; `status` is read from `params`; a `SUCCESS` value causes
`POST /api/v202506/payments/:id` (`:128`) and `POST /api/carts/:token/checkout` (`:135`). uPayments
is never consulted. Full analysis in §3.2.

### 8.2 Uncaught `FluidClient::Error` on the customer-search call breaks the cart — **high**

`checkout_callback_controller.rb:29`:

```ruby
fluid_customer = fluid_client.get("/api/customers?search_query=#{customer_payload.dig(:email)}&page=1&per_page=1")
```

`FluidClient#handle_response` (`app/clients/fluid_client.rb:42-53`) raises on any non-2xx. The
`POST` two lines later is wrapped in `begin/rescue FluidClient::Error` (`:39-44`); this `GET` is
not. A Fluid 500 or 404 on customer search therefore propagates out of the action, Rails returns
HTTP 500, and Fluid receives a non-2xx for a synchronous checkout callback. Same file, same
method, one is guarded and one is not — this reads as an oversight rather than a decision.

### 8.3 Several other unhandled exceptions on the same callback — **high**

All produce a 500 on the `redirect_cart_payment` path, which §3.6 establishes is the wrong
failure shape:

- `UPaymentsUserApiClient#initialize` raises `RuntimeError` if `NEWULIFE_API_CODE` or
  `NEWULIFE_PRIVATE_KEY` is unset (`app/services/u_payments_user_api_client.rb:11, 49`).
  Same for `UPaymentsCheckoutApiClient` (`:10, 32`). A misconfigured deploy 500s every checkout.
- `UPaymentsUserApiClient#handle_response` raises on a non-JSON body (`:81-85`). Any uPayments
  gateway error page 500s the callback.
- `ByDesign#create_consumer` calls `JSON.parse(response.body)` at `by_design.rb:31` with no rescue
  on the 200 branch.
- `callback_params[:cart][:email]` at `checkout_callback_controller.rb:11` raises `NoMethodError`
  if `cart` is absent — and `cart` is a *required* field in the definition, so this is exactly the
  malformed-input case that should return the neutral body.

### 8.4 Retry re-records payments to ByDesign — **high**

`app/jobs/by_design_payment_recording_job.rb`. Three distinct paths, all analysed in §3.3:
post-success raise on the `:recorded` write (`:25-28` → `:36` → `:175-181`); post-success raise
while posting the order (`:149` → same rescue, regressing out of `:recorded`); and partial
success leaving the record in `:matched` (`:161-173`) so the next webhook re-enqueues a job that
re-Saves the payments that already succeeded. No idempotency key on
`POST /api/Personal/Order/Payment/CreditCard/Save`.

### 8.5 The Moola webhook fails open when unconfigured — **high**

`app/controllers/moola_webhooks_controller.rb:3, 50-52`. `MOOLA_WEBHOOK_SECRET` appears nowhere
outside this file and is absent from every deploy artefact and from
`docs/gcp-environment-variables.md`. Evidence and the confirming command are in §3.4.

### 8.6 `droplet.installed` is fully unauthenticated — **medium-high**

`app/controllers/webhooks_controller.rb:3, 22-24` skips `authenticate_webhook_token` for
`droplet.installed`, and the template's compensating `validate_droplet_authorization` was
**deleted** — the identifier appears nowhere in `app/`, `lib/`, `config/` or `test/`.
`DropletInstalledJob` (`:19-31`) then upserts a `companies` row from the request body, including
`webhook_verification_token`, so an attacker can install their own token and use it to
authenticate every subsequent webhook.

### 8.7 `find_company` keys on the droplet-wide UUID — **medium**

`app/controllers/webhooks_controller.rb:59` and `app/jobs/webhook_event_job.rb:70` both do
`Company.find_by(company_droplet_uuid: …)` first. That column is set from the payload's
`droplet_uuid` (`app/jobs/droplet_installed_job.rb:28`) — i.e. **the droplet's** UUID, identical
on every installation row, and the schema index on it is deliberately non-unique
(`db/migrate/20250411062613_create_companies.rb:22`). With more than one installation, `find_by`
returns an arbitrary row, and the webhook is then authenticated against *that* company's token.
This droplet is effectively single-tenant (NewULife), which is why it has not bitten — but it
should not be carried into the port. Key on `fluid_company_id`, or on
`droplet_installation_uuid`, which is genuinely per-installation.

### 8.8 Unescaped interpolation into a Fluid query string — **low**

`checkout_callback_controller.rb:29` interpolates a raw email into `search_query=` with no
`CGI.escape`. An address containing `&`, `+` or `#` silently searches for the wrong thing, or
injects extra query parameters into the Fluid request.

### 8.9 Shared hardcoded ByDesign password — **low, but it is in version control**

`app/services/by_design.rb:67`: `Password: "ByDesignTemporalPassword"`. Every consumer this
droplet has ever created in ByDesign shares a password that is published in the repository.
Whether those accounts are ever reachable by password login is a ByDesign question I cannot answer
from here — but if they are, this is an account-takeover vector across the whole customer base.
**This one needs an answer from ByDesign before anything else in §8 is scheduled.**

### 8.10 `invoice_number` is treated as unique but is not — **low, latent**

`moola_payment.rb:14-16` validates presence only. `moola_p2m_webhook_job.rb:22` uses
`extract_cart_token(invoice_number)` as the sole join key from Moola's payload into the ledger.
The index is non-unique (`db/migrate/20260121000001:38`). Nothing enforces that two rows cannot
share an invoice number. It is 1:1 with `cart_token` by construction today, but only by
construction. Called out because it is the exact column most likely to attract a wrong `@unique`
in the Prisma schema (§5.2).

---

## 9. What I could not verify

Stated explicitly so nobody reads an inference as a fact.

1. **Whether `MOOLA_WEBHOOK_SECRET` is set in production.** Strongly implied absent by its total
   absence from every deploy artefact and from the environment-variable documentation, but Cloud
   Run env is managed out-of-band. Command to confirm is in §3.4.
2. **Whether ByDesign's `CreditCard/Save` de-duplicates on `ReferenceNumber`.** This determines
   whether §8.4 has already caused double-recordings or has merely been able to. Needs an answer
   from ByDesign or a controlled test in their sandbox.
3. **Whether Fluid rejects a second `POST /api/carts/:token/checkout` for an already-checked-out
   cart.** Determines the blast radius of §8.1's replay.
4. **Whether the Bearer token in `README.md:13,30` is live.** Rotate regardless.
5. **Any claim about production data.** I have not queried the production database. Every
   statement about `moola_payments` describes what the code does, not what the rows contain.
6. **Whether ByDesign consumer accounts created with the shared password are password-accessible.**
   §8.9.
7. **The uPayments order expiry window**, which sets the length of Phase 6's waiting period.

---

## 10. Target shape, from the reference implementations

Read `droplet-template#200` (`claude/next-migration`) and
`fluid-droplet-zallevo-shipping-calcs#59` in full before writing anything. Roughly two-thirds of
what this droplet needs is #200's shared layer verbatim. This section records only the parts that
are load-bearing and the parts where this droplet diverges.

### 10.1 Layout — the Next app lives under `src/`

`src/next.config.ts`, `src/tsconfig.json`, `src/postcss.config.mjs`; commands are
`next dev src`, `next build src`, `next start src`.

This is not a style preference. Next resolves its app directory with `findDir(root, "app")`, which
**prefers `<root>/app` over `<root>/src/app`** and offers no override. This repo still contains the
Rails app at `app/`, so building from the repo root makes Next scan Rails' directory, find no
routes, and emit an empty app. Since the brief forbids deleting Rails in the same PR (§6 Phase 6),
`src/` is forced. In Phase 6 those three files move up one level and the commands lose their `src`
argument — no source file moves, no import path changes.

Everything else follows #200: `src/app/` for routes, `src/lib/<feature>/` with a barrel
`index.ts` per folder and tests colocated, `src/components/`, `src/test/{setup,factories,signing}.ts`,
Vitest at the root with `include: ["src/**/*.{test,spec}.{ts,tsx}"]`.

`src/next.config.ts` must also carry the dropzone CSP, which replaces Rails' cleared
`X-Frame-Options` (`config/initializers/security_headers.rb`):

```ts
headers: async () => [{ source: "/:path*", headers: [
  { key: "Content-Security-Policy", value: "frame-ancestors 'self' https://*.fluid.app" },
]}]
```

### 10.2 The SDK is vendored, not fetched from GitHub Packages

**The shared brief is wrong on this point and the reference implementation is right.** The brief
says to depend on `@fluid-studios/droplet-sdk` from `https://npm.pkg.github.com` via an `.npmrc`.
That does not work: the `@fluid-studios` npm scope cannot exist under the `fluid-commerce` GitHub
org, and publishing returns `403 Permission not_found: owner not found`. #200 therefore vendors it:

```
vendor/droplet-sdk/            # copied from packages/droplet-sdk
"@fluid-studios/droplet-sdk": "link:./vendor/droplet-sdk"
```

with `transpilePackages: ["@fluid-studios/droplet-sdk"]` in `next.config.ts` and
`"../vendor/droplet-sdk/src/**/*.ts"` in `src/tsconfig.json`'s `include`. A useful side effect:
CI needs no registry auth. The `Dockerfile.next` must copy `vendor/droplet-sdk` **before**
`pnpm install`, or the `link:` dependency cannot resolve and the lockfile install fails.

### 10.3 The two wrappers, and why their failure hooks are not interchangeable

Both take `onAuthFailure` / `onInvalidBody` / `onHandlerError`, but **the signatures differ**:
callback hooks receive a `CallbackFailure` object (`{stage, reason, error?}`), webhook hooks
receive a bare `reason: string` (or `error: unknown` for the handler hook). Copying a hook from one
to the other type-errors, which is the good outcome; copying the *reasoning* is the bad one.

**`withFluidCallback`** — for `redirect_cart_payment`:

```ts
withFluidCallback(
  { definitions: ["redirect_cart_payment"], store: callbackStore, resolvePrincipal,
    name: "redirect-cart-payment",
    onAuthFailure: neutral, onInvalidBody: neutral, onHandlerError: neutral },
  async ({ principal, payload, definition }) => { … },
)
```

`neutral` is the single body from §3.6, used on every failure path *and* on the route's own no-op
path, so the route is not an oracle. Its order of operations matters for the port: it reads the
**raw bytes** (not `request.text()`, which strips a BOM and replaces malformed sequences with
U+FFFD, so the HMAC would not reproduce), locates the registration by
`tokenDigest(x-fluid-callback-token)`, verifies `x-fluid-signature` / `x-fluid-timestamp` against
the **presented** token as the HMAC key, and only then parses the body and resolves the tenant.
A store throw is routed through `onAuthFailure(reason: "store_unavailable")` — i.e. through the
route's own policy — so a database outage answers with the neutral 200 rather than a 500.
`resolvePrincipal` returning `null` is an auth failure, and is correct.

`resolvePrincipal` must key on `registration.dri` and **nothing else** — no `x-fluid-shop` header,
no company id from the payload. A valid signature proves which *registration* signed, not who the
request is about, so a payload fallback would let the holder of tenant A's token sign a request
naming tenant B. Concretely here:

```ts
prisma.company.findFirst({ where: {
  dropletInstallationUuid: registration.dri, active: true, uninstalledAt: null } })
```

`findFirst`, not `findUnique` — `companies.droplet_installation_uuid` has no index at all in this
schema (it was added by `20250610071323_add_droplet_installation_id_to_company.rb` with no
`add_index`). **Add one in Phase 1**, non-unique, or this lookup is a sequential scan on every
checkout callback.

**`withFluidWebhook`** — fails closed, 401. `bootstrapSecret` is accepted **only** for the events
in `bootstrapEvents`, which should be `[INSTALL_EVENT, "droplet.uninstalled"]` and nothing more.
`resolve()` guesses a candidate secret from unverified routing hints and is trusted only after
verification; that inversion is inherent to per-company webhook secrets and is fine, as long as
nothing in the handler re-derives the tenant from the payload. `context.principal` may legitimately
be `null` on a first install; it is never null for an unverified request.

### 10.4 Deltas specific to this droplet

| #200 / zallevo assumption | Here |
|---|---|
| `callbacks` table drives registration | Absent. The one registration is hardcoded or config-driven; no sync service, no admin callbacks UI. |
| `companies.installed_callback_ids` records what to clean up | Column absent. Read the uuid set from `fluid_callback_registrations` keyed on `dri`, as zallevo did. Never from a Fluid listing — it is company-scoped. |
| `integration_settings` exists | Absent. Delete the model. |
| Neutral body is `{shipping_options: []}` (zallevo) / `{success: true}` (#200) | `{"redirect_url": null, "error_message": "<generic>"}` — see §3.6. |
| Handlers run inline in the route handler | **Re-examine.** #200 dropped Solid Queue and runs handlers inline. That is fine for a shipping calculation. It is not obviously fine for `ByDesignPaymentRecordingJob`, which makes N sequential 30-second-timeout calls to ByDesign. And per §3.5, an external queue silently breaks the enqueue/status atomicity that Solid Queue-in-Postgres currently provides. **Pick a Postgres-backed queue and say so explicitly in the implementation PR.** This is the single most consequential structural decision in the port and it is not inherited from either reference. |
| One callback route to wrap | Same — but three *money* routes beyond it (§2.3), none of which the references have an analogue for. |
| Rails `app/`, `config/`, `db/`, `Gemfile` untouched by the migration PR | **Not achievable here.** Phase 0 (§6) changes all four, on purpose, before any Next.js code exists. |

### 10.5 Verification block to reproduce

Both reference PRs end with a fenced command → result block and an explicit "Not verified" list.
Match it. At minimum: `pnpm install`, `typecheck`, `lint`, `test` (with counts, split into shared
layer vs this droplet's own logic), `build` (with route count), `prisma validate`, plus the
retained Rails `build:vite` / `test:jest`. And state plainly what was not verified — for this
droplet that will include anything requiring live ByDesign, live uPayments, or production data.
