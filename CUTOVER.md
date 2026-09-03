# Cutting the NewULife payment droplet over from Rails to Next

Both apps read the same database — the Next app maps onto the Rails tables with
`@@map`, and there is no data migration. Two tables and three columns are ADDED by Rails
migrations in this PR; nothing existing is reshaped.

**Read §1 before anything else. This droplet is not zallevo. Repointing the one
Fluid callback is a small, reversible step; the rest of the money path is not a
registration Fluid holds, and it does not move with a command.**

---

## 1. The money path is five legs, and only ONE of them is a Fluid registration

```
  Fluid checkout                 uPayments hosted            Moola
       │                            checkout                    │
       │ ① redirect_cart_payment        │                       │
       ▼                                │                       │
  callback ──────────────► ByDesign create consumer  (IRREVERSIBLE)
       │            └────► Fluid create customer     (IRREVERSIBLE)
       │            └────► uPayments create order    (semi: it can expire)
       │                                │                       │
       │◄──── redirect_url ─────────────┘                       │
                                        │  customer pays        │
                                        ▼                       │
  ② GET /checkout/success/… ◄──── browser 302                   │
       ├──► Fluid create payment        (IRREVERSIBLE)
       └──► Fluid checkout cart         (IRREVERSIBLE — creates the order)
                                                                │
  ③ POST /webhooks/moola/p2m ◄──────────────────────────────────┘
       └──► moola_payments row updated
                │
  ④ order.external_id_synced (Fluid webhook) ──► attach the ByDesign OrderID
                │
                ▼  when ③ and ④ have both landed and KYC == APPROVE
  ⑤ ByDesign record payment  (IRREVERSIBLE, PER PAYMENT)
       └──► ByDesign post order (IRREVERSIBLE)
```

| Leg | Who holds the url | Moves by |
|---|---|---|
| ① `redirect_cart_payment` | Fluid, per installation | `pnpm cutover repoint` |
| ② uPayments return | **baked into every uPayments order at creation** | changing `DROPLET_HOST_URL`, and only for NEW orders |
| ③ Moola webhook | **Moola**, configured on their side | a third-party change with its own lead time |
| ④ `order.external_id_synced` | Fluid, per installation | `pnpm cutover repoint` |
| ⑤ ByDesign recording | nobody — it is driven by whichever app processed ③ or ④ | wherever the row is when it becomes ready |

A cart enters at ① and arrives at ⑤ minutes to hours later. **Legs ②③④⑤ cut
over together, in one window, or they do not cut over.**

---

## 2. The two services and the paths they serve

| | Cloud Run service | Fluid callback | Fluid webhook | Moola webhook | uPayments return | Dropzone |
|---|---|---|---|---|---|---|
| Rails | `fluid-droplet-newulife-payment` | `POST /get_redirect_url` | `POST /webhook` | `POST /webhooks/moola/p2m` | `GET /checkout/success/:cart_token/payment_account/:payment_account_id` | `GET /embed_ui` |
| Next | `fluid-droplet-newulife-payment-next` | `POST /api/callbacks/redirect-cart-payment` | `POST /api/webhooks` | `POST /webhooks/moola/p2m` | same as Rails | `GET /embed_ui` |

Both in `europe-west1`, project `fluid-417204`.

Three of those paths are **identical between the two apps, deliberately**:

- **The Moola webhook.** Moola holds that url, not us. Keeping the path the
  same makes their change host-only.
- **The uPayments return.** The url is baked into every order at creation time,
  so orders opened before the cutover still point at the Rails host. Keeping the
  path identical means Rails can forward with a plain 302 (§6 step 6).
- **The dropzone.** Fluid holds it on the droplet record.

The two that differ are the two the SDK owns, and `scripts/cutover.ts` knows
both spellings and is told which direction it is going.

### The callback definition name

| Rails route (a LOCAL name) | Fluid `definition_name` | Next route |
|---|---|---|
| `POST /get_redirect_url` | **`redirect_cart_payment`** | `POST /api/callbacks/redirect-cart-payment` |

`redirect_cart_payment` is verified against
`app/lib/callback_definitions/redirect_cart_payment.yml` in fluid — the full
valid set is exactly the filenames in that directory. It is also named
explicitly in this repo's own registration recipe, `callbacks_registration.md`,
which is how the pair was confirmed rather than inferred. `get_redirect_url` is
a Rails route name and has never been a definition name.

A wrong definition name means Fluid silently stops calling, and because this
route answers 200 on every failure, nothing surfaces it.

### The webhook topics

| Topic | Real in Fluid | Handled by |
|---|---|---|
| `droplet.installed` | `Webhook::TopicRegistry` | `handleDropletInstalled` |
| `droplet.uninstalled` | `Webhook::TopicRegistry` | `handleDropletUninstalled` |
| `order.external_id_synced` | `Webhook::TopicRegistry` | `handleOrderExternalIdSynced` |

`company_droplet.created` was commented out in the Rails initializer with a TODO
doubting it existed. It is not in the topic registry; the TODO was right, and it
is not ported.

---

## 3. BLOCKERS — none of these are optional

These are not migration tasks. They are live defects in the Rails app that the
port either preserves or cannot fix on its own, and each one is a reason not to
send traffic at the Next service yet.

**B1. `checkout/success` decides "was this paid for?" from a query-string
parameter.** `?status=SUCCESS` in the shopper's own address bar causes a Fluid
payment to be created and the cart to be checked out into an order. uPayments is
never consulted. Anyone holding a `cart_token` can complete a checkout without
paying.

The port does **not** fix this, and the reason is worth stating: fixing it means
verifying the payment out of band, and the only out-of-band authority this
repository knows about is the Moola webhook (leg ③), which routinely arrives
AFTER the browser does. Blocking the shopper until it lands trades a forgery
risk for a checkout outage, and that is not a trade to make blind inside a
migration. It needs a uPayments order-status lookup, or a deliberate decision to
drive checkout from ③ instead.

What the port DOES fix is replay, with two of the three columns migration
`20260411000003` adds:

- `checkout_claimed_at` is taken in a short transaction before either Fluid
  call. A refresh, a back-button or a second tab is refused while it is held,
  and once `fluid_order_id` is recorded the route replays the stored
  confirmation url instead of calling Fluid at all.
- `fluid_payment_uuid` is persisted the moment Fluid issues it, BEFORE the
  checkout call. The claim has to expire — a first attempt that failed before
  creating anything would otherwise wedge a cart the shopper has already paid
  for — and without this column that expiry would only DELAY a duplicate
  payment rather than prevent one. A retry after expiry reuses the uuid.

What is still open, and is part of this blocker rather than separate from it: a
`checkoutCart` call that created the order and whose response was lost. The
retry calls `checkoutCart` again with the SAME payment uuid, which is the best
this droplet can do without an idempotency key or a cart-status lookup on
Fluid's side. Neither is known to exist. Establish one before this leg moves.

**B2. `MOOLA_WEBHOOK_SECRET` must be set, on both sides, before leg ③ moves.**
Rails verifies the Moola signature only `if: :signature_verification_enabled?`,
which is true only when that variable is set — so an unset secret makes the
endpoint accept anything, and an unauthenticated caller can post a crafted
`invoice_number: "NULF-CT:<cart_token>"` with arbitrary `payment_details`
straight into the ByDesign recording path. The variable appears nowhere in this
repository outside that one controller, in no deploy artefact, and not in
`docs/gcp-environment-variables.md`.

**The Next route fails closed**: no secret, no deliveries — it answers 500, so
Moola retries and setting the secret a minute later recovers them. Confirm what
is set today with (names only, no values):

```bash
gcloud run services describe fluid-droplet-newulife-payment \
  --region=europe-west1 --project=fluid-417204 \
  --format='value(spec.template.spec.containers[0].env[].name)'
```

**B3. Whether ByDesign de-duplicates `CreditCard/Save` on `ReferenceNumber` is
unknown.** The port stops assuming: `bydesign_payment_receipts` is written
immediately after each successful Save and checked before every Save, so a retry
is idempotent whatever ByDesign does. But the Rails app writes no receipts, so
during any window in which BOTH apps can drive leg ⑤ the two are blind to each
other. That is why the Rails workers stop before ⑤ moves (§6 step 2), and it is
the single hardest constraint in this cutover.

**B4. The callback has never had a verification token.** Registration here was a
hand-run curl that discarded the `verification_token` Fluid issues exactly once,
in the create response. Until §5 has been run and `fluid_callback_registrations`
holds a digest, the Next callback route refuses everything — behind a 200.

---

## 4. Deploy (inert)

Run the **`deploy next`** workflow. It builds `Dockerfile.next` and updates the
`fluid-droplet-newulife-payment-next` Cloud Run service. Nothing points at it, so
this changes nothing — that is the property worth having.

The service is created **once, by hand**, before the first run:
`cloudbuild-next.yml` does `run services update`, not `deploy`, so it cannot
invent configuration. It needs the same `DATABASE_URL`, ByDesign and uPayments
credentials as the Rails service, plus its own `FLUID_DROPLET_URL`,
`AUTH_SECRET`, `FLUID_WEBHOOK_AUTH_TOKEN`, `DROPLET_HOST_URL`,
`CHECKOUT_HOST_URL` and `MOOLA_WEBHOOK_SECRET`. See `.env.example`.

Then `scripts/smoke-next.sh <url>`. Read its header first: the callback route
fails open by design, so an unauthenticated probe cannot tell verification
working from verification broken. The webhook assertions are the ones with
teeth.

Watch the boot log for the readiness line from `src/instrumentation.ts`. On the
first deploy it is EXPECTED to report zero stored registrations — this droplet
has never held one. It must report non-zero before §6.

**The Rails migrations in this PR still have to run.** They deploy with the
Rails pipeline (`cloudbuild.yml` has the `-migrations` job;
`cloudbuild-next.yml` deliberately has no migration step, because Rails owns
this schema). Without them `fluid_callback_registrations` does not exist, the
token lookup raises, the SDK reads a raising store as an auth failure, and the
callback route answers a neutral 200. Every genuine callback refused, no error
rate moves, nothing alerts.

---

## 5. Register the callback through the SDK, still pointed at Rails

Do this while traffic is still going to Rails, so a mistake costs a
re-registration and not a cart.

```bash
pnpm backfill:callbacks
```

By hand, from a terminal holding production `DATABASE_URL` and
`FLUID_DROPLET_URL`. Deliberately **not** in the deploy workflow: that job has
the database secret but not per-installation Fluid credentials, and a partial
backfill inside CI would let the deploy proceed anyway, which is the failure
this ordering exists to prevent.

It stages the whole replacement set in memory, checks it covers every enabled
callback, and only then deletes and inserts in one transaction — so an
installation's digests are never removed before their replacements are in hand.

`ownUrls` is matched **exactly**, never by origin: `GET /api/callback/registrations`
is company-scoped, returns other droplets' registrations with no owner filter,
and `owner_id` cannot discriminate (it renders a numeric DropletInstallation id,
not the `dri_` slug). Another droplet registering `redirect_cart_payment` at any
path on this host would otherwise be adopted.

**Gate:** the registration exists, its digest is stored, the plaintext is
nowhere, the backfill exits zero, and the url still points at the Rails host. A
deliberately wrong-token request to the Next route returns the neutral 200 body,
byte-identical to the no-op body.

---

## 6. Cut over

### 6a. Leg ① alone — the callback

```bash
pnpm cutover status  newulife                                # read-only
pnpm cutover repoint newulife \
  --url  https://fluid-droplet-newulife-payment-next-...run.app \
  --from https://fluid-droplet-newulife-payment-...run.app
APPLY=1 pnpm cutover repoint newulife \
  --url  https://fluid-droplet-newulife-payment-next-...run.app \
  --from https://fluid-droplet-newulife-payment-...run.app
pnpm cutover status  newulife                                # confirm
```

`--callback-path` and `--webhook-path` default to the Next paths, so going
*forwards* needs neither. Going back needs both — see the rollback below.

The repoint is an **update in place**, not a delete-then-create, and that is
load-bearing. Fluid sets `verification_token` in `before_create` and never
rotates it, `UpdateAction` accepts `url`, and `api_show` renders the `:shared`
view which still carries the token. So the registration keeps its uuid and its
token while only the url moves, and the tool reads the token back afterwards to
store its digest. There is no window in which the definition has no
registration.

`--from` is only a hint. It lets the tool recognise a registration as ours
before we hold any digest for it — the state every company is in on its first
cutover. Where more than one registration could plausibly be ours, the tool
stops and prints them rather than guessing.

**This is safe to split out** because ① is the only leg with no persistent
state: it reads a cart, calls three APIs and returns a url. Its durable side
effects are the ByDesign consumer and the Fluid customer, both created before
any money moves, and both of which the Rails app will happily find on a
subsequent attempt.

**Gate:** run for a full business cycle. Compare `redirect_url` issuance rate
and `error_message` rate against the Rails baseline. Zero increase in ByDesign
consumer creations per cart — an increase means the "does this user exist"
lookup is behaving differently.

**Rollback:** repoint at Rails. One API call, no data to unwind.

```bash
APPLY=1 pnpm cutover repoint newulife \
  --url  https://fluid-droplet-newulife-payment-...run.app \
  --from https://fluid-droplet-newulife-payment-next-...run.app \
  --callback-path /get_redirect_url \
  --webhook-path  /webhook
```

Both path flags are required going back, and the tool will not guess the
direction. Without `--callback-path` the rollback would register
`redirect_cart_payment` at `https://<rails>/api/callbacks/redirect-cart-payment`,
a route Rails does not have — and the symptom is not a 404 anyone sees, it is a
shopper who cannot start a payment.

### 6b. Legs ②③④⑤ together — the one irreversible step

Everything in this phase happens in a single maintenance window. B1, B2 and B3
must be closed first.

1. **Drain.** Stop accepting new checkouts, or accept that carts opened now
   complete on the Next side. Wait until `moola_payments` has no rows in
   `pending`, `matched` or `recording` older than the drain start.
2. **Stop the Rails Solid Queue workers.** Not the web process — the uPayments
   `redirectUrl` baked into already-open orders still points at Rails, so Rails
   must keep answering `/checkout/success` until those orders age out. But no
   Rails worker may pick up a `ByDesignPaymentRecordingJob`, because Rails
   writes no receipts and cannot see the Next app's (B3).
3. **Repoint the Moola webhook url** at the Next host. Same path. Third-party
   change — arrange it ahead of the window.
4. **Repoint `order.external_id_synced`** (and the `droplet.*` webhooks, §6c) at
   the Next host.
5. **Change `DROPLET_HOST_URL`** so NEW uPayments orders carry the Next redirect
   url.
6. **Leave the Rails `/checkout/success` route live**, reduced to a 302 that
   forwards to the Next host's identical path. Old orders then complete
   correctly. This is why the two apps share that path.

**Gate:** one live payment observed end to end — `redirect_url` issued, customer
pays, `checkout/success` claims and checks out, Moola webhook received and
verified, `order.external_id_synced` received, ByDesign Save recorded, receipt
row written, order posted. Watch a full day.

**Rollback stops being free here.** Repointing Moola back is a third-party change
with lead time. `moola_payments` rows written by the Next app are
schema-compatible and Rails can resume them, but receipt rows are invisible to
Rails — so a rollback that lets Rails re-drive a partially recorded cart can
double-Save.

### 6c. The droplet-level registrations

`cutover repoint` moves one company's registrations. It does NOT move the
droplet-level `droplet.installed` / `droplet.uninstalled` webhooks, which live
on the droplet record rather than on any installation. Nothing surfaces that:
every company can be fully cut over and working while the next install still
goes to Rails.

In Fluid's droplet settings, set the webhook url to
`https://fluid-droplet-newulife-payment-next-...run.app/api/webhooks` and press
**Update Droplet**. Confirm an install arrives. This droplet has no
`WebhookManager` — it was never in this fork of the template — so there is no
command for it.

The dropzone `embed_url` moves the same way, and the path is unchanged.

### 6d. Retire Rails

Only after the oldest possible uPayments order has expired — confirm that window
with uPayments, do not guess it. Min-instances to 0 first and leave it a while;
that is reversible in seconds.

---

## 7. Rules while both apps are live

**Rails owns the schema.** Two migration tools against one database produces a
schema neither app agrees with. `cloudbuild-next.yml` has no migrations step and
must not gain one. Keep Prisma read-shaped: `db pull`, never `db push`. There is
no `db:push` guard in this repo — `pnpm db:push` will happily reshape the Rails
schema, so treat that command as unavailable during a cutover window.

**Run `prisma db pull` against a production snapshot and diff it against the
committed schema before trusting it.** Schema and migrations agreeing proves the
REPOSITORY is self-consistent, not that production matches it.

**The receipts table is one-way.** `bydesign_payment_receipts` is written only by
the Next app. Rails neither reads nor writes it. That is safe exactly as long as
only one runtime can reach leg ⑤ — see §6b step 2.

**No encrypted columns.** Nothing in this schema uses Rails `encrypts`, so
Prisma reads the same values ActiveRecord does. Worth stating because where a
droplet does encrypt, Prisma reads the base64 envelope and the droplet then sees
every company as unconfigured — no error, no exception.

**There is no queue, and the DELIVERY is the retry.** The Next app runs its
handlers inline and claims work with a PostgreSQL row lock;
`moola_payments.status` IS the claim. This is deliberate: Rails' Solid Queue
lives in the same database, so `status -> :recording` and the job enqueue
committed together, and an external queue (Redis, Cloud Tasks) would silently
break that — the row can be marked `recording` with no job enqueued, or the job
enqueued and the row rolled back. Removing the enqueue removes the pair.

Two consequences follow, and both are load-bearing:

- Rails retried the recording job up to five times. Here a recording run that
  fails transiently makes the route answer **5xx**, so Moola or Fluid re-sends
  and the re-delivery re-drives the run. Expect to see 503s from
  `/webhooks/moola/p2m` during a ByDesign outage; that is the retry working, not
  a droplet fault. It stops after `MAX_RECORDING_ATTEMPTS`, when the row becomes
  `failed` and needs an operator.
- An abandoned claim (process killed mid-run) is reclaimed after 15 minutes,
  measured from `recording_claimed_at` — its own column, because an inbound
  webhook writes to the row while a run holds it and keying the expiry on
  `updated_at` would push it out forever. Reclaiming is safe only because of the
  receipts.

---

## 8. What this PR does not do

- Nothing points at the new app. No registration was created or updated, no
  Cloud Run service was created, nothing was deployed, no production database
  was written to.
- B1 (`checkout/success` forgery) is not fixed. See §3.
- The ByDesign consumer created in leg ① still uses a hardcoded shared password
  (`by_design.rb:67`, ported unchanged). Whether those accounts are reachable by
  password login is a question for ByDesign.
- The Rails app is untouched apart from three additive migrations, `db/schema.rb`,
  the yarn→pnpm switch in `ci.yml`, `vite.config.js`, and the deletion of a
  tracked (empty) `.env`.
- Cart tokens are still written to logs, as they are in Rails. Given B1 that
  makes log access equivalent to checkout-forgery access. Closing B1 closes
  that too; until then, treat this droplet's logs as sensitive.
- The Prisma schema annotates every mapped string as `@db.VarChar(255)`, so
  `prisma db push` would be a no-op rather than proposing `varchar -> text` on
  every column of a live payments table. That is belt-and-braces: the deploy
  runs no Prisma migration at all.
