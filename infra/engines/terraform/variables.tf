variable "region" {
  type    = string
  default = "us-east-2"
}
variable "tenant" { type = string }
variable "plan" {
  type    = string
  default = "basic"
}
variable "environment" {
  type    = string
  default = "prod"
}
variable "running" {
  type    = bool
  default = true
}
variable "ami_id" {
  type    = string
  default = null
}
variable "ssh_public_key_path" {
  type    = string
  default = "~/.ssh/diplo_mod2_key.pub"
}
variable "admin_cidr" {
  type    = string
  default = "0.0.0.0/0"
}
variable "monitoring_cidr" {
  type    = string
  default = null
}
