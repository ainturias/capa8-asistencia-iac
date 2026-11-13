variable "tenant" {
  description = "Identificador único del tenant (slug): minúsculas, números y guiones."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,30}$", var.tenant))
    error_message = "El tenant debe ser un slug de 2 a 31 caracteres: minúsculas, números y guiones."
  }
}

variable "plan" {
  description = "Plan contratado: basic | standard | advanced (define tamaños de VM y disco)."
  type        = string
  default     = "basic"
  validation {
    condition     = contains(["basic", "standard", "advanced"], var.plan)
    error_message = "El plan debe ser basic, standard o advanced."
  }
}

variable "environment" {
  description = "Entorno del tenant."
  type        = string
  default     = "prod"
}

variable "running" {
  description = "true = VMs encendidas; false = suspendidas (se conservan los discos y los datos)."
  type        = bool
  default     = true
}

variable "ami_id" {
  description = "AMI creada con Packer. Si es null se usa Ubuntu 22.04 de Canonical."
  type        = string
  default     = null
}

variable "public_key" {
  description = "Contenido de la llave pública SSH para las VMs (no es secreto)."
  type        = string
}

variable "admin_cidr" {
  description = "CIDR desde el que se permite SSH (Ansible). Usar tu IP /32 en lo posible."
  type        = string
  default     = "0.0.0.0/0"
}

variable "monitoring_cidr" {
  description = "CIDR del servidor Prometheus que puede leer node_exporter (:9100)."
  type        = string
  default     = "0.0.0.0/0"
}

variable "db_password" {
  description = "Contraseña de la BD del tenant. Si es null se genera una aleatoria."
  type        = string
  default     = null
  sensitive   = true
}
