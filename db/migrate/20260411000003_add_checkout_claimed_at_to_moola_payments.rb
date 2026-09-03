# The claim that makes the uPayments browser return non-repeatable.
#
# `GET /checkout/success/:cart_token/payment_account/:payment_account_id` is a
# browser navigation the shopper can refresh. Rails re-ran both irreversible
# Fluid calls on every load — `POST /api/v202506/payments/:id` and then
# `POST /api/carts/:token/checkout` — with nothing keyed on the cart to stop
# it.
#
# The Next app takes this claim in a short transaction before either call and
# releases it only by recording the resulting `fluid_order_id`. A refresh, a
# double-click, or two tabs cannot produce a second Fluid payment.
#
# Nullable with no default, so adding it is a catalogue-only change on
# PostgreSQL and does not rewrite the table.
#
# NOTE this does NOT make the route safe to expose. The route still has no
# authentication and still reads payment success from a query-string
# parameter the shopper controls; that is a live defect in the Rails app,
# tracked separately, and it must be closed before this leg is cut over. This
# column closes replay, not forgery.
class AddCheckoutClaimedAtToMoolaPayments < ActiveRecord::Migration[8.0]
  def change
    add_column :moola_payments, :checkout_claimed_at, :datetime
  end
end
