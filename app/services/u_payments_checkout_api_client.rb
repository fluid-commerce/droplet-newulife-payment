class UPaymentsCheckoutApiClient
  include HTTParty

  def initialize
    @base_url = ENV["UPAYMENTS_CHECKOUT_API_URL"]
    @private_key = load_private_key_from_env
    @api_code = ENV["UPAYMENTS_MC_API_CODE"]
    @algorithm = "RS512"

    raise "UPAYMENTS_MC_API_CODE not found in environment variables" if @api_code.nil? || @api_code.empty?

  end

  def self.create_order(payload:)
    new.create_order(payload:)
  end

  def create_order(payload:)
    response = HTTParty.post(
      "#{@base_url}/checkout/v1/order",
      body: payload.to_json,
      headers: headers,
    )
    
    handle_response(response)
  end

private

  def load_private_key_from_env
    private_key_content = ENV["UPAYMENTS_MC_PRIVATE_KEY"]

    raise "UPAYMENTS_MC_PRIVATE_KEY not found in environment variables" if private_key_content.nil?

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
