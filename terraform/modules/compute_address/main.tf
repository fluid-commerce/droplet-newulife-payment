# Static regional IP address
resource "google_compute_address" "static_ip" {
  name         = "${var.vm_name}-static-ip"
  region       = var.region
  description  = "Static IP for the ${var.vm_name} compute instance"
  address_type = "EXTERNAL"

  lifecycle {
    prevent_destroy = true # Prevents accidental destruction
  }
}
