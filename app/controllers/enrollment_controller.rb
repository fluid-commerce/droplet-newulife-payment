class EnrollmentController < ApplicationController
  skip_before_action :verify_authenticity_token

  def downline_lookup
    rep_did = params[:rep_did]
    search = params[:search]

    if rep_did.blank?
      return render json: { error_message: "rep_did is required" }, status: :bad_request
    end

    response = ByDesign.downline_lookup(rep_did: rep_did, search: search)

    if response["IsSuccessful"]
      render json: { results: response["Result"] || [] }
    else
      error_message = response["Message"].presence || "Downline lookup failed"
      Rails.logger.error("ByDesign downline lookup failed: #{error_message}")
      render json: { error_message: error_message, results: [] }
    end
  end
end
