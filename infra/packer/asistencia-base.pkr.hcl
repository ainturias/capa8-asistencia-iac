# AMI base de los tenants: Ubuntu 22.04 + Node 20 + nginx + PostgreSQL + node_exporter + swap.
# Flujo del ingeniero: Packer (imagen) -> OpenTofu/Terraform (VMs con ami_id) -> cloud-init -> Ansible.
packer {
  required_plugins {
    amazon  = { source = "github.com/hashicorp/amazon", version = ">= 1.3.0" }
    ansible = { source = "github.com/hashicorp/ansible", version = ">= 1.1.0" }
  }
}

variable "region" {
  type    = string
  default = "us-east-2"
}
variable "image_version" {
  type    = string
  default = "1.0.0"
}

source "amazon-ebs" "base" {
  region        = var.region
  instance_type = "t3.small"
  ssh_username  = "ubuntu"
  ami_name      = "capa8-asistencia-base-${var.image_version}-{{timestamp}}"

  source_ami_filter {
    filters = {
      name                = "ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"
      root-device-type    = "ebs"
      virtualization-type = "hvm"
    }
    owners      = ["099720109477"] # Canonical
    most_recent = true
  }

  tags = {
    Project   = "capa8-asistencia"
    Name      = "capa8-asistencia-base"
    Version   = var.image_version
    ManagedBy = "packer"
  }
}

build {
  sources = ["source.amazon-ebs.base"]

  provisioner "ansible" {
    playbook_file   = "${path.root}/../ansible/image.yml"
    user            = "ubuntu"
    extra_arguments = ["--scp-extra-args", "'-O'", "-e", "ansible_python_interpreter=/usr/bin/python3"]
  }

  # Registra qué se horneó (RF-13: versiones de herramientas por despliegue)
  post-processor "manifest" {
    output = "${path.root}/manifest.json"
  }
}
