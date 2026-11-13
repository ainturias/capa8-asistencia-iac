output "frontend_public_ip" { value = aws_eip.frontend.public_ip }
output "backend_public_ip" { value = aws_instance.backend.public_ip }
output "db_private_ip" { value = aws_instance.db.private_ip }
output "backend_private_ip" { value = aws_instance.backend.private_ip }

output "url" {
  description = "URL del tenant (por IP, no hace falta dominio)."
  value       = "http://${aws_eip.frontend.public_ip}"
}

output "plan_limits" {
  description = "Recursos y límites del plan contratado."
  value       = local.p
}

output "db_name" { value = local.db_name }
output "db_user" { value = local.db_user }

output "db_password" {
  value     = local.db_password
  sensitive = true
}

# Inventario Ansible listo para usar (la BD y el backend se alcanzan por IP privada vía el frontend si se desea).
output "ansible_inventory" {
  value = <<-EOT
    [frontend]
    ${aws_eip.frontend.public_ip}
    [backend]
    ${aws_instance.backend.public_ip}
    [db]
    ${aws_instance.db.public_ip}

    [all:vars]
    ansible_user=ubuntu
    tenant_id=${var.tenant}
    plan=${var.plan}
    db_host=${aws_instance.db.private_ip}
    backend_host=${aws_instance.backend.private_ip}
    db_name=${local.db_name}
    db_user=${local.db_user}
  EOT
}

# Targets de Prometheus (file_sd) con etiquetas tenant/env/role → métricas por tenant y entorno (RF-27).
output "prometheus_targets" {
  description = "Targets file_sd con IPs PRIVADAS (estables al suspender/reanudar). Prometheus debe estar en la misma VPC."
  value = jsonencode([
    { targets = ["${aws_instance.frontend.private_ip}:9100"], labels = { tenant = var.tenant, env = var.environment, role = "frontend", plan = var.plan } },
    { targets = ["${aws_instance.backend.private_ip}:9100"], labels = { tenant = var.tenant, env = var.environment, role = "backend", plan = var.plan } },
    { targets = ["${aws_instance.db.private_ip}:9100"], labels = { tenant = var.tenant, env = var.environment, role = "db", plan = var.plan } },
  ])
}

# Chequeos HTTP del blackbox_exporter: disponibilidad y latencia de la web y de la API (via nginx) de cada tenant.
output "probe_targets" {
  value = jsonencode([
    { targets = ["http://${aws_instance.frontend.private_ip}/", "http://${aws_instance.frontend.private_ip}/api/health"],
    labels = { tenant = var.tenant, env = var.environment, plan = var.plan } },
  ])
}
