# One row per ByDesign payment that has actually been Saved.
#
# `POST /api/Personal/Order/Payment/CreditCard/Save` accepts no idempotency
# key, and whether ByDesign de-duplicates on `ReferenceNumber` is not known to
# this repository. Recording a payment is irreversible from this droplet's
# side, so the droplet carries its own dedupe instead of assuming.
#
# Why it is needed, concretely. `ByDesignPaymentRecordingJob` records every
# recordable line for a cart and only then writes `status: :recorded`. Three
# paths put the row back into a re-runnable state AFTER at least one Save has
# succeeded:
#
#   (a) a raise on the `:recorded` write itself,
#   (b) a raise while posting the order, which happens after that write, and
#   (c) partial failure — two lines, one Saved, one not — which sets the status
#       back to `:matched` so the next Moola re-delivery re-runs the whole set.
#
# All three re-Save a line that already landed, because success is recorded per
# CART and not per PAYMENT. This table moves that record to the right
# granularity: written immediately after each successful Save, checked before
# every Save.
#
# Additive and unused by the Rails app. That asymmetry matters during any
# window where both runtimes could drive the recording path — Rails writes no
# receipts, so it cannot see the Next app's, and vice versa. See CUTOVER.md:
# the Rails workers stop before this leg cuts over.
class CreateBydesignPaymentReceipts < ActiveRecord::Migration[8.0]
  def change
    create_table :bydesign_payment_receipts do |t|
      # `text`, not `string`, for the same Prisma `String` -> PostgreSQL `text`
      # reason as fluid_callback_registrations.
      t.text :bydesign_order_id, null: false
      # `payment_details[].id` from the Moola webhook. Stable per payment line
      # and already used as ByDesign's `ReferenceNumber`.
      t.text :payment_detail_id, null: false
      # Denormalised for operator queries; the ledger row is found by cart_token
      # from every other direction too.
      t.text :cart_token, null: false

      t.datetime :recorded_at, null: false
      t.jsonb :response, default: {}

      t.datetime :created_at, null: false, default: -> { "CURRENT_TIMESTAMP" }
      t.datetime :updated_at, null: false, default: -> { "CURRENT_TIMESTAMP" }
    end

    # THE point of the table. The unique constraint is the guard, not the
    # SELECT that precedes it: two concurrent recording runs can both read
    # "no receipt" and only one insert can win.
    add_index :bydesign_payment_receipts,
              %i[bydesign_order_id payment_detail_id],
              unique: true,
              name: "index_bydesign_receipts_on_order_and_payment"
    add_index :bydesign_payment_receipts, :cart_token
  end
end
