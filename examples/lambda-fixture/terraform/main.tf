terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region                      = "us-west-2"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  access_key                  = "test"
  secret_key                  = "test"
}

variable "lambda_zip" {
  type        = string
  description = "Path to the built Lambda zip (exported by the reusable workflow)."
}

variable "some_secret" {
  type        = string
  description = "Example secret injected as a Lambda env var."
  sensitive   = true
  default     = "placeholder"
}

resource "aws_lambda_function" "fixture" {
  function_name    = "atlantis-trident-lambda-fixture"
  filename         = var.lambda_zip
  source_code_hash = filebase64sha256(var.lambda_zip)
  runtime          = "python3.13"
  handler          = "handler.handler"
  role             = "arn:aws:iam::000000000000:role/fixture"

  environment {
    variables = {
      SOME_SECRET = var.some_secret
    }
  }
}
