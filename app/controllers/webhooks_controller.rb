class WebhooksController < ApplicationController
  skip_before_action :verify_authenticity_token
  before_action :authenticate_webhook_token, unless: :droplet_installed_for_first_time?

  def create
    event_type = "#{params[:resource]}.#{params[:event]}"
    version = params[:version]

    payload = params.to_unsafe_h.deep_dup

    if EventHandler.route(event_type, payload, version: version)
      # A 202 Accepted indicates that we have accepted the webhook and queued
      # the appropriate background job for processing.
      head :accepted
    else
      head :no_content
    end
  end

private

  def droplet_installed_for_first_time?
    params[:resource] == "droplet" && params[:event] == "installed"
  end

  def authenticate_webhook_token
    company = find_company
    if company.blank?
      render json: { error: "Company not found" }, status: :not_found
    elsif !valid_auth_token?(company)
      render json: { error: "Unauthorized" }, status: :unauthorized
    end
  end

  def valid_auth_token?(company)
    # Check header auth token first
    auth_header = request.headers["AUTH_TOKEN"] || request.headers["X-Auth-Token"]
    return true if auth_header.present? && auth_header == company.webhook_verification_token

    # Fall back to webhook verification token in params (only for droplet webhooks with nested company)
    return false unless params[:company].present?

    company_params[:webhook_verification_token].present? &&
      company_params[:webhook_verification_token] == company.webhook_verification_token
  end

  def find_company
    # Try nested company object first (droplet webhooks), then root-level company_id (order webhooks)
    if params[:company].present?
      Company.find_by(company_droplet_uuid: company_params[:company_droplet_uuid]) ||
        Company.find_by(fluid_company_id: company_params[:fluid_company_id])
    else
      # Try root-level company_id, then nested under payload
      company_id = params[:company_id] || params.dig(:payload, :company_id)
      Company.find_by(fluid_company_id: company_id) if company_id.present?
    end
  end

  def company_params
    params.require(:company).permit(
      :company_droplet_uuid,
      :fluid_company_id,
      :webhook_verification_token,
      :authentication_token,
      :droplet_installation_uuid
    )
  end
end
