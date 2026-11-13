# Servidor de monitoreo (Prometheus + Grafana) en la MISMA VPC que los tenants, pero en una VM APARTE
# (si cae un backend no cae el monitoreo, como pidió el ingeniero).
terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
  backend "s3" {}
}

variable "region" {
  type    = string
  default = "us-east-2"
}
variable "ssh_public_key_path" {
  type    = string
  default = "~/.ssh/diplo_mod2_key.pub"
}
variable "admin_cidr" {
  type    = string
  default = "0.0.0.0/0"
}
variable "grafana_cidr" {
  description = "Quién puede abrir Grafana (:3000). Abierto para que el ingeniero revise el panel."
  type        = string
  default     = "0.0.0.0/0"
}
variable "running" {
  type    = bool
  default = true
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = "capa8-asistencia", Role = "monitoring", ManagedBy = "opentofu" }
  }
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }
}
data "aws_vpc" "default" { default = true }

resource "aws_key_pair" "this" {
  key_name   = "capa8-monitoring-key"
  public_key = file(pathexpand(var.ssh_public_key_path))
}

resource "aws_security_group" "monitoring" {
  name        = "capa8-monitoring"
  description = "Grafana publico (solo lectura/login), SSH admin"
  vpc_id      = data.aws_vpc.default.id
  ingress {
    description = "Grafana"
    from_port   = 3000
    to_port     = 3000
    protocol    = "tcp"
    cidr_blocks = [var.grafana_cidr]
  }
  ingress {
    description = "SSH admin"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "monitoring" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = "t3.small"
  key_name               = aws_key_pair.this.key_name
  vpc_security_group_ids = [aws_security_group.monitoring.id]
  root_block_device {
    volume_size = 20
    volume_type = "gp3"
    encrypted   = true
  }
  metadata_options { http_tokens = "required" }
  tags = { Name = "capa8-monitoring" }
}

resource "aws_eip" "monitoring" {
  domain   = "vpc"
  instance = aws_instance.monitoring.id
}

resource "aws_ec2_instance_state" "monitoring" {
  instance_id = aws_instance.monitoring.id
  state       = var.running ? "running" : "stopped"
}

output "public_ip" { value = aws_eip.monitoring.public_ip }
output "grafana_url" { value = "http://${aws_eip.monitoring.public_ip}:3000" }
output "ansible_inventory" {
  value = "[monitoring]\n${aws_eip.monitoring.public_ip}\n\n[all:vars]\nansible_user=ubuntu\n"
}
