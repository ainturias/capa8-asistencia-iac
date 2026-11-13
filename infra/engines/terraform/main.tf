# Raíz del motor terraform (binario: `terraform`). Llama al MISMO módulo que el otro motor.
# El state vive en S3: bucket y key se pasan al iniciar (el bloque backend no admite variables):
#   terraform init -backend-config=backend.hcl -backend-config="key=tenants/<slug>/terraform.tfstate"
terraform {
  required_version = ">= 1.6.0"
  backend "s3" {}
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project   = "capa8-asistencia"
      Tenant    = var.tenant
      Plan      = var.plan
      Env       = var.environment
      ManagedBy = "terraform"
    }
  }
}

module "tenant" {
  source          = "../../modules/tenant"
  tenant          = var.tenant
  plan            = var.plan
  environment     = var.environment
  running         = var.running
  ami_id          = var.ami_id
  public_key      = file(pathexpand(var.ssh_public_key_path))
  admin_cidr      = var.admin_cidr
  monitoring_cidr = var.monitoring_cidr
}
