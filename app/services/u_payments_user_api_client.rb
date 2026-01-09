class UPaymentsUserApiClient
  include HTTParty

  base_uri ENV["UPAYMENTS_USERS_API_URL"]

  def initialize
    @private_key = load_private_key_from_env
    @api_code = ENV["NEWULIFE_API_CODE"]
    @algorithm = "RS512"

    raise "NEWULIFE_API_CODE not found in environment variables" if @api_code.nil? || @api_code.empty?
  end

  def self.check_user_exists(email:, external_id:)
    new.check_user_exists(email:, external_id:)
  end

  def self.onboard_consumer(payload:)
    new.onboard_consumer(payload:)
  end

  def check_user_exists(email:, external_id:)
    payload = { email:, external_id: "#{external_id}" }

    response = self.class.post(
      "/api/admin/customer",
      body: payload.to_json,
      headers: headers
    )

    handle_response(response)
  end

  def onboard_consumer(payload:)
    response = self.class.post(
      "/login/on-board",
      body: payload.to_json,
      headers: headers
    )

    handle_response(response)
  end

private

  def load_private_key_from_env
    private_key_content = ENV["NEWULIFE_PRIVATE_KEY"]

    raise "NEWULIFE_PRIVATE_KEY not found in environment variables" if private_key_content.nil?

    # Replace literal \n with actual newlines
    private_key_content = private_key_content.gsub("\\n", "\n")

    OpenSSL::PKey::RSA.new(private_key_content)
  rescue OpenSSL::PKey::RSAError => e
    raise "Invalid private key format: #{e.message}"
  end

  def generate_jwt_token
    current_time = Time.now.to_i
    expiry_time = current_time + 3600 # 1 hour expiry

    payload = {
      "sub" => @api_code,
      "iss" => "moola-buisness",
      "iat" => current_time,
      "exp" => expiry_time,
    }

    JWT.encode(payload, @private_key, @algorithm)
  end

  def headers
    {
      "Authorization" => "Token #{generate_jwt_token}",
      "Content-Type" => "application/json",
      "Accept" => "application/json",
    }
  end

  def handle_response(response)
    JSON.parse(response.body)
  rescue JSON::ParserError
    raise "Response body is not valid JSON: #{response.body}"
  end
end
