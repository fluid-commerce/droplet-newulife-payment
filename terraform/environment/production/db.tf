# Database configuration
# Note: The actual database and user are created in the database/ subfolder
# which uses the shared fluid-studioz Cloud SQL instance.
#
# This file is kept for compatibility but doesn't create any resources.
# Run terraform in the database/ folder first to create the databases,
# then configure the environment variables with the Secret Manager values.

locals {
  cloud_sql_instance   = "fluid-studioz"
  cloud_sql_connection = "fluid-417204:europe-west1:fluid-studioz"
}
