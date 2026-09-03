# Creates the table the Next app's callback verification reads.
#
# It lives here, in a Rails migration, because Rails owns this schema — the
# Next app deliberately runs no migration step (see cloudbuild-next.yml), so a
# table that exists only as a Prisma model exists nowhere at all. That failure
# is silent in the worst way: the token lookup raises, the SDK reads a raising
# store as an auth failure, and the callback route answers a neutral 200
# because Fluid blocks a live checkout on this response. Every genuine callback
# refused, no error rate moves, nothing alerts.
#
# The shape is dictated by the SDK's own model and must stay identical across
# the fleet — see prisma/schema.prisma, FluidCallbackRegistration, and
# vendor/droplet-sdk/schema/callback-registrations.prisma.
#
# Only the digest is stored. Fluid presents the plaintext token on every
# request, so a digest is enough to find the registration, and a database dump
# then yields no working callback credentials.
#
# Additive: the Rails app neither reads nor writes this table, which is what
# lets both runtimes share the database during a cutover.
class CreateFluidCallbackRegistrations < ActiveRecord::Migration[8.0]
  def change
    # `id: false` with a string primary key: the SDK keys these rows by Fluid's
    # registration uuid, not by a local autoincrement. A bigint `id` here would
    # not match what Prisma declares as `@id`.
    #
    # `text`, not `string`. Prisma maps `String` to PostgreSQL `text`, while
    # Rails' `t.string` is `varchar(255)`. The mismatch is invisible until a
    # registration url exceeds 255 characters, at which point the insert fails
    # and the registration code deletes the live Fluid registration it just made.
    create_table :fluid_callback_registrations, id: false do |t|
      t.text :uuid, null: false, primary_key: true
      t.text :dri, null: false
      t.text :definition_name, null: false
      t.text :token_digest, null: false
      t.text :url, null: false

      # Explicit database defaults, NOT bare `t.timestamps`.
      #
      # Rails' `t.timestamps` makes these NOT NULL with no default, because
      # ActiveRecord always supplies them. Prisma declares `@default(now())` /
      # `@updatedAt` and the SDK's store passes neither, so against a
      # Rails-created table the insert would violate NOT NULL — the token would
      # never be stored, and the registration code would delete the live Fluid
      # registration it had just created. Defaulting them in the database makes
      # the column correct for whichever ORM writes it.
      t.datetime :created_at, null: false, default: -> { "CURRENT_TIMESTAMP" }
      t.datetime :updated_at, null: false, default: -> { "CURRENT_TIMESTAMP" }
    end

    # Unique because the digest is how an inbound callback finds its
    # registration. Two rows sharing one digest would make that lookup
    # ambiguous, and the SDK would have no basis for choosing a tenant.
    add_index :fluid_callback_registrations, :token_digest, unique: true
    # Not unique: one installation legitimately holds several registrations,
    # one per callback definition.
    add_index :fluid_callback_registrations, :dri
  end
end
