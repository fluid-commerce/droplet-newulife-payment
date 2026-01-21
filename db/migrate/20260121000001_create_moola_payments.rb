class CreateMoolaPayments < ActiveRecord::Migration[8.0]
  def change
    create_table :moola_payments do |t|
      # Matching identifiers
      t.string :cart_token, null: false
      t.string :invoice_number, null: false

      # Order tracking (populated when Fluid webhook arrives)
      t.string :fluid_order_id
      t.string :bydesign_order_id

      # Moola transaction details
      t.string :moola_transaction_id
      t.string :kyc_status
      t.string :transaction_type

      # Payment details (JSONB array of individual payments)
      t.jsonb :payment_details, default: []

      # Card details (enriched from LOAD_FUNDS_VIA_CARD webhook)
      t.jsonb :card_details, default: {}

      # Full webhook payloads for debugging/audit
      t.jsonb :moola_webhook_payload, default: {}
      t.jsonb :fluid_webhook_payload, default: {}

      # Status tracking
      t.integer :status, default: 0, null: false
      t.integer :bydesign_recording_attempts, default: 0
      t.text :last_error
      t.datetime :matched_at
      t.datetime :recorded_at

      t.timestamps
    end

    add_index :moola_payments, :cart_token, unique: true
    add_index :moola_payments, :invoice_number
    add_index :moola_payments, :moola_transaction_id
    add_index :moola_payments, :fluid_order_id
    add_index :moola_payments, :bydesign_order_id
    add_index :moola_payments, :status
    add_index :moola_payments, [:status, :created_at]
  end
end
