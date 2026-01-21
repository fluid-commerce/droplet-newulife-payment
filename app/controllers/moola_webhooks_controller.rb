class MoolaWebhooksController < ApplicationController
  skip_before_action :verify_authenticity_token
  before_action :verify_webhook_signature, if: :signature_verification_enabled?

  # POST /webhooks/moola/p2m
  # Receives P2M transaction webhooks from Moola
  def p2m
    Rails.logger.info("[MoolaWebhook] Received P2M webhook: #{sanitized_log_params}")

    MoolaP2mWebhookJob.perform_later(webhook_payload)
    head :accepted
  rescue JSON::ParserError => e
    Rails.logger.error("[MoolaWebhook] JSON parse error: #{e.message}")
    head :bad_request
  rescue StandardError => e
    Rails.logger.error("[MoolaWebhook] Error processing P2M webhook: #{e.class} - #{e.message}")
    head :internal_server_error
  end

  # POST /webhooks/moola/card_details
  # Receives card details for LOAD_FUNDS_VIA_CARD payments
  def card_details
    Rails.logger.info("[MoolaWebhook] Received card details webhook: #{sanitized_log_params}")

    MoolaCardDetailsWebhookJob.perform_later(webhook_payload)
    head :accepted
  rescue JSON::ParserError => e
    Rails.logger.error("[MoolaWebhook] JSON parse error: #{e.message}")
    head :bad_request
  rescue StandardError => e
    Rails.logger.error("[MoolaWebhook] Error processing card details webhook: #{e.class} - #{e.message}")
    head :internal_server_error
  end

private

  def webhook_payload
    params.to_unsafe_h.deep_dup
  end

  # Sensitive fields that should be redacted from logs
  SENSITIVE_FIELDS = %w[
    card_number card_number_last4 expiry_date expiry_month expiry_year
    card_type brand payment_instrument_uuid cvv
  ].freeze

  def sanitized_log_params
    payload = webhook_payload.deep_dup
    sanitize_hash(payload)
    payload.to_json
  end

  def sanitize_hash(hash)
    hash.each do |key, value|
      if SENSITIVE_FIELDS.include?(key.to_s)
        hash[key] = "[REDACTED]"
      elsif value.is_a?(Hash)
        sanitize_hash(value)
      elsif value.is_a?(Array)
        value.each { |item| sanitize_hash(item) if item.is_a?(Hash) }
      end
    end
  end

  def signature_verification_enabled?
    ENV["MOOLA_WEBHOOK_SECRET"].present?
  end

  def verify_webhook_signature
    signature = request.headers["X-Moola-Signature"] || request.headers["X-Webhook-Signature"]

    unless signature.present?
      Rails.logger.warn("[MoolaWebhook] Missing webhook signature header")
      head :unauthorized
      return
    end

    expected_signature = compute_signature(request.raw_post)

    unless ActiveSupport::SecurityUtils.secure_compare(signature, expected_signature)
      Rails.logger.warn("[MoolaWebhook] Invalid webhook signature")
      head :unauthorized
    end
  end

  def compute_signature(payload)
    OpenSSL::HMAC.hexdigest("SHA256", ENV["MOOLA_WEBHOOK_SECRET"], payload)
  end
end
