terraform {
  required_version = ">= 1.5"
}

variable "greeting" {
  type    = string
  default = "hello"
}

output "greeting" {
  value = var.greeting
}
