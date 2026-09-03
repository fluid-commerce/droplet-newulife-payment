#!/usr/bin/env bash
#
# Synthetic smoke test against a deployed Next service.
#
#   scripts/smoke-next.sh https://fluid-droplet-newulife-payment-next-xxxx.a.run.app
#
# Sends no valid signatures, so it needs no secrets and is safe against
# production. Read the limits below before trusting a pass.
#
# WHAT THIS CAN AND CANNOT SHOW
#
# The webhook route fails CLOSED, so an unsigned request must be refused with a
# 401. That is a real assertion: if verification were broken or the route were
# unwrapped, this would come back 200.
#
# The callback route fails OPEN by design — `onAuthFailure` answers 200 with
# the neutral `{"redirect_url":null,"error_message":"..."}` body, because
# `redirect_cart_payment` is checkout_blocking and a 401 would break checkout
# rather than protect it. The body is a shape the definition explicitly allows:
# Fluid shows the message and leaves the shopper on checkout. So an
# unauthenticated probe CANNOT distinguish "verifying
# correctly and refusing me" from "cannot verify anything and refusing
# everyone". Both look identical from outside. That is the point of the design
# and the blind spot of this script.
#
# What that means in practice: a pass here says the service is up, routed, and
# refusing unsigned webhooks. It does NOT say a genuine Fluid callback would be
# accepted. Only real traffic — or a request signed with a real registration
# token — shows that, which is why the first cutover is an internal
# installation and not a client.
set -uo pipefail

BASE="${1:-}"
[ -n "$BASE" ] || { echo "usage: $0 <base-url>"; exit 2; }
BASE="${BASE%/}"

fail=0
check () {
  local name="$1" expected="$2" got="$3"
  if [ "$got" = "$expected" ]; then
    printf '  ok    %-48s %s\n' "$name" "$got"
  else
    printf '  FAIL  %-48s got %s, want %s\n' "$name" "$got" "$expected"
    fail=$((fail + 1))
  fi
}

code () { curl -s -o /dev/null -m 20 -w '%{http_code}' "$@" 2>/dev/null || echo 000; }
body () { curl -s -m 20 "$@" 2>/dev/null || echo ""; }

echo "Smoke testing $BASE"

check "health" 200 "$(code "$BASE/api/health")"

# Fails closed. This is the assertion that carries weight.
#
# The FLAT envelope ({resource, event, company}) is used throughout, because
# that is the shape this repo's route tests pin and the shape the vendored SDK
# reads tenant hints from. Fluid also sends the nested
# {name, payload:{company}} form; this app's SDK copy does not unwrap it when
# reading hints, so probing with it would assert a behaviour that is not the
# one production depends on.
check "webhook without a signature is refused" 401 \
  "$(code -X POST "$BASE/api/webhooks" \
      -H 'content-type: application/json' \
      -d '{"resource":"order","event":"created","company":{"fluid_shop":"smoke"}}')"

# 400, NOT 401. The SDK wrapper reads and JSON.parses the body BEFORE it looks
# at the signature (withFluidWebhook: onInvalidBody fires on a parse failure,
# well above the verification block), so a malformed body is rejected as a bad
# request and never reaches auth.
check "webhook with a malformed body is a bad request" 400 \
  "$(code -X POST "$BASE/api/webhooks" \
      -H 'content-type: application/json' -d 'not json')"

# A bootstrap-eligible event with no signature must also be refused. The shared
# secret is a candidate for these events, not a bypass of verification.
check "unsigned install event is refused" 401 \
  "$(code -X POST "$BASE/api/webhooks" \
      -H 'content-type: application/json' \
      -d '{"resource":"droplet","event":"installed","company":{"fluid_shop":"smoke"}}')"

# Fails open, so the 200 proves routing and that the route is deployed —
# nothing about verification. Asserted anyway because a 404 or a 500 here is a
# genuine finding: it means the route is missing or throwing.
#
# The body never reaches the handler: verification fails first and
# `onAuthFailure` returns the neutral response, so nothing is written, no
# ByDesign consumer is created and no uPayments order is opened. That last part
# is why this probe is safe to point at production at all — the handler this
# route wraps moves money.
CB_PATH="/api/callbacks/redirect-cart-payment"
CB_BODY_IN='{"cart":{"cart_token":"smoke-not-a-real-cart"}}'

CB=$(code -X POST "$BASE$CB_PATH" \
      -H 'content-type: application/json' -d "$CB_BODY_IN")
check "callback route answers (fail-open, proves routing only)" 200 "$CB"

CB_BODY=$(body -X POST "$BASE$CB_PATH" \
      -H 'content-type: application/json' -d "$CB_BODY_IN")
# Compared exactly, not with a substring match. `*redirect_url*` also matches a
# body carrying a REAL redirect url and an HTML error page that happens to
# contain the word — which is precisely the kind of green that means nothing,
# and here the first of those would mean an unauthenticated caller had just
# been handed a payment link. This is NEUTRAL_RESULT from
# src/lib/checkout/redirect.ts as NextResponse.json serialises it.
NEUTRAL='{"redirect_url":null,"error_message":"We could not start the payment. Please try again."}'
if [ "$CB_BODY" = "$NEUTRAL" ]; then
  printf '  ok    %-48s %s\n' "callback returns the neutral body" "$CB_BODY"
else
  printf '  FAIL  %-48s %s\n' "callback returns the neutral body" "$CB_BODY"
  fail=$((fail + 1))
fi

# The assertions above prove the service REFUSES what it should. They cannot
# prove it ACCEPTS what it should: deploy with FLUID_WEBHOOK_AUTH_TOKEN absent
# or wrong and every one of them still passes, while every genuine signed
# install and uninstall is also refused. So if the secret is available, send a
# correctly signed lifecycle event and require it NOT to be a 401.
#
#   FLUID_WEBHOOK_AUTH_TOKEN=... scripts/smoke-next.sh https://...
#
# 401 means verification is rejecting real Fluid traffic. Anything else — 202,
# 204, even a 500 from the handler — proves the signature was accepted, which is
# the only thing this check is about.
#
# `droplet.uninstalled`, NOT `droplet.installed`. Both are bootstrap events, so
# either proves the point, but the install handler writes: it only skips early
# when `droplet_uuid` fails to match the configured uuid, and if the droplet
# uuid is unset it warns and carries on, creating a `companies` row from the
# probe payload. The uninstall handler resolves the company FIRST and returns
# when it finds none, so a made-up droplet_installation_uuid cannot touch any
# row. This must stay safe to point at production.
if [ -n "${FLUID_WEBHOOK_AUTH_TOKEN:-}" ]; then
  BODY='{"resource":"droplet","event":"uninstalled","company":{"droplet_installation_uuid":"smoke-not-a-real-installation"}}'
  TS=$(date +%s)
  SIG=$(printf '%s.%s' "$TS" "$BODY" \
    | openssl dgst -sha256 -hmac "$FLUID_WEBHOOK_AUTH_TOKEN" \
    | sed 's/^.*= //')
  SIGNED=$(code -X POST "$BASE/api/webhooks" \
    -H 'content-type: application/json' \
    -H "X-Fluid-Timestamp: $TS" \
    -H "X-Fluid-Signature: $SIG" \
    -d "$BODY")
  if [ "$SIGNED" = "401" ]; then
    printf '  FAIL  %-48s %s\n' "signed lifecycle webhook is accepted" "$SIGNED"
    fail=$((fail + 1))
  else
    printf '  ok    %-48s %s\n' "signed lifecycle webhook is accepted" "$SIGNED"
  fi
else
  printf '  SKIP  %-48s %s\n' "signed lifecycle webhook is accepted" \
    "set FLUID_WEBHOOK_AUTH_TOKEN to check"
fi

echo
if [ "$fail" -gt 0 ]; then
  echo "$fail check(s) failed — do not repoint any installation at this service."
  exit 1
fi
if [ -n "${FLUID_WEBHOOK_AUTH_TOKEN:-}" ]; then
  echo "Passed. The service refuses unsigned webhooks AND accepts a signed one."
else
  echo "Passed, but only the refusal half was checked — nothing here proves a"
  echo "genuine signed webhook would be accepted. Re-run with"
  echo "FLUID_WEBHOOK_AUTH_TOKEN set before repointing anything."
fi
echo "This does NOT establish that a signed callback would be accepted;"
echo "cut an internal installation over first and watch it."
