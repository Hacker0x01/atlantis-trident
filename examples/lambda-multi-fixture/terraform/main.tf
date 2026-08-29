terraform {
  required_version = ">= 1.5"
  required_providers { aws = { source = "hashicorp/aws", version = "~> 5.0" } }
}
provider "aws" {
  region                      = "us-west-2"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  access_key                  = "test"
  secret_key                  = "test"
}
variable "lambda_zips" {
  type        = map(string)
  description = "Map of lambda name -> built zip path (exported by the workflow)."
}
resource "aws_lambda_function" "a" {
  function_name    = "atlantis-multi-fixture-a"
  filename         = var.lambda_zips["a"]
  source_code_hash = filebase64sha256(var.lambda_zips["a"])
  runtime          = "python3.13"
  handler          = "handler_a.handler"
  role             = "arn:aws:iam::000000000000:role/fixture"
}
resource "aws_lambda_function" "b" {
  function_name    = "atlantis-multi-fixture-b"
  filename         = var.lambda_zips["b"]
  source_code_hash = filebase64sha256(var.lambda_zips["b"])
  runtime          = "python3.13"
  handler          = "handler_b.handler"
  role             = "arn:aws:iam::000000000000:role/fixture"
}
