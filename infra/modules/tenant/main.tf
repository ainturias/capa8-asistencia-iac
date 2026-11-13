# Módulo único del tenant: red + 3 VMs (frontend, backend, base de datos).
# Lo usan TODOS los motores HCL (OpenTofu y Terraform) sin cambios.

locals {
  # Catálogo de planes (RF-01/RF-02). Documentado en docs/catalogo-de-planes.md
  plans = {
    basic    = { instance_type = "t3.micro", db_instance_type = "t3.micro", disk_gb = 10, db_disk_gb = 10, max_students = 100 }
    standard = { instance_type = "t3.small", db_instance_type = "t3.small", disk_gb = 20, db_disk_gb = 20, max_students = 1000 }
    advanced = { instance_type = "t3.medium", db_instance_type = "t3.medium", disk_gb = 30, db_disk_gb = 50, max_students = 5000 }
  }
  p    = local.plans[var.plan]
  name = "tenant-${var.tenant}"
  ami  = coalesce(var.ami_id, data.aws_ami.ubuntu.id)

  mon_cidr = coalesce(var.monitoring_cidr, data.aws_vpc.default.cidr_block)

  db_name     = "asistencia_${replace(var.tenant, "-", "_")}"
  db_user     = "app_${replace(var.tenant, "-", "_")}"
  db_password = coalesce(var.db_password, random_password.db.result)
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }
}

data "aws_vpc" "default" {
  default = true
}

resource "random_password" "db" {
  length  = 24
  special = false
}

resource "aws_key_pair" "this" {
  key_name   = "${local.name}-key"
  public_key = var.public_key
}

# ---------------------------- Seguridad / aislamiento ----------------------------
resource "aws_security_group" "frontend" {
  name        = "${local.name}-frontend"
  description = "HTTP publico + SSH admin"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "SSH admin"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
  }
  ingress {
    description = "node_exporter"
    from_port   = 9100
    to_port     = 9100
    protocol    = "tcp"
    cidr_blocks = [local.mon_cidr]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "backend" {
  name        = "${local.name}-backend"
  description = "API solo desde el frontend + SSH admin"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description     = "API NestJS solo desde el frontend del mismo tenant"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.frontend.id]
  }
  ingress {
    description = "SSH admin"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
  }
  ingress {
    description = "node_exporter"
    from_port   = 9100
    to_port     = 9100
    protocol    = "tcp"
    cidr_blocks = [local.mon_cidr]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "db" {
  name        = "${local.name}-db"
  description = "PostgreSQL solo desde el backend del mismo tenant"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description     = "PostgreSQL solo desde el backend del mismo tenant"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.backend.id]
  }
  ingress {
    description = "SSH admin"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
  }
  ingress {
    description = "node_exporter"
    from_port   = 9100
    to_port     = 9100
    protocol    = "tcp"
    cidr_blocks = [local.mon_cidr]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# --------------------------------- Instancias ---------------------------------
# La BD se crea primero: el backend necesita su IP privada.
resource "aws_instance" "db" {
  ami                    = local.ami
  instance_type          = local.p.db_instance_type
  key_name               = aws_key_pair.this.key_name
  vpc_security_group_ids = [aws_security_group.db.id]

  root_block_device {
    volume_size = local.p.db_disk_gb
    volume_type = "gp3"
    encrypted   = true
  }
  metadata_options {
    http_tokens = "required" # IMDSv2
  }
  user_data = templatefile("${path.module}/cloud-init/common.yaml.tftpl", {
    tenant = var.tenant, role = "db", environment = var.environment, plan = var.plan
  })
  tags = { Name = "${local.name}-db", Role = "db" }
}

resource "aws_instance" "backend" {
  ami                    = local.ami
  instance_type          = local.p.instance_type
  key_name               = aws_key_pair.this.key_name
  vpc_security_group_ids = [aws_security_group.backend.id]

  root_block_device {
    volume_size = local.p.disk_gb
    volume_type = "gp3"
    encrypted   = true
  }
  metadata_options {
    http_tokens = "required"
  }
  user_data = templatefile("${path.module}/cloud-init/common.yaml.tftpl", {
    tenant = var.tenant, role = "backend", environment = var.environment, plan = var.plan
  })
  tags = { Name = "${local.name}-backend", Role = "backend" }
}

resource "aws_instance" "frontend" {
  ami                    = local.ami
  instance_type          = local.p.instance_type
  key_name               = aws_key_pair.this.key_name
  vpc_security_group_ids = [aws_security_group.frontend.id]

  root_block_device {
    volume_size = local.p.disk_gb
    volume_type = "gp3"
    encrypted   = true
  }
  metadata_options {
    http_tokens = "required"
  }
  user_data = templatefile("${path.module}/cloud-init/common.yaml.tftpl", {
    tenant = var.tenant, role = "frontend", environment = var.environment, plan = var.plan
  })
  tags = { Name = "${local.name}-frontend", Role = "frontend" }
}

# IP fija para el frontend: la URL del tenant NO cambia al suspender/reanudar.
resource "aws_eip" "frontend" {
  domain   = "vpc"
  instance = aws_instance.frontend.id
  tags     = { Name = "${local.name}-frontend", Role = "frontend" }
}

# --------------- Suspender / reanudar (RF-16, RF-17) ---------------
# Apaga las VMs sin borrar los discos: los datos se conservan.
resource "aws_ec2_instance_state" "db" {
  instance_id = aws_instance.db.id
  state       = var.running ? "running" : "stopped"
}
resource "aws_ec2_instance_state" "backend" {
  instance_id = aws_instance.backend.id
  state       = var.running ? "running" : "stopped"
}
resource "aws_ec2_instance_state" "frontend" {
  instance_id = aws_instance.frontend.id
  state       = var.running ? "running" : "stopped"
}
