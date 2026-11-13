output "url" { value = module.tenant.url }
output "plan_limits" { value = module.tenant.plan_limits }
output "frontend_public_ip" { value = module.tenant.frontend_public_ip }
output "backend_public_ip" { value = module.tenant.backend_public_ip }
output "db_private_ip" { value = module.tenant.db_private_ip }
output "ansible_inventory" { value = module.tenant.ansible_inventory }
output "prometheus_targets" { value = module.tenant.prometheus_targets }
output "db_password" {
  value     = module.tenant.db_password
  sensitive = true
}
output "probe_targets" { value = module.tenant.probe_targets }
