# The three columns that make the money path's claims durable.
#
# All nullable with no default, so adding them is a catalogue-only change on
# PostgreSQL and does not rewrite the table.
#
# `checkout_claimed_at` — the uPayments browser return is a navigation the
#   shopper can refresh, and Rails re-ran both irreversible Fluid calls on every
#   load. This is taken in a short transaction before either call.
#
# `fluid_payment_uuid` — the payment uuid Fluid issues, persisted the moment it
#   is known. A retry after a lost response REUSES it instead of creating a
#   second Fluid payment. Without this, holding the checkout claim only DELAYS a
#   duplicate until the claim expires; with it, the only remaining ambiguity is
#   a checkout call that succeeded and whose response was lost, and that retry
#   at least carries the same payment.
#
# `recording_claimed_at` — when a ByDesign recording run took the row. It has to
#   be its own column rather than `updated_at`: an inbound webhook writes to the
#   row (merging payment details) while a run holds it, which refreshes
#   `updated_at` and would push an abandoned claim's expiry out forever.
#
# NOTE none of this makes /checkout/success safe to expose. That route still has
# no authentication and still reads payment success from a query-string
# parameter the shopper controls. These columns close replay, not forgery. See
# CUTOVER.md section 3.
class AddClaimColumnsToMoolaPayments < ActiveRecord::Migration[8.0]
  def change
    add_column :moola_payments, :checkout_claimed_at, :datetime
    add_column :moola_payments, :fluid_payment_uuid, :string
    add_column :moola_payments, :recording_claimed_at, :datetime
  end
end
