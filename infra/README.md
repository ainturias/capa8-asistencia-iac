# Infraestructura de tenants

```
Packer (AMI) -> OpenTofu | Terraform (red + 3 VMs) -> cloud-init (arranque) -> Ansible (BD -> backend -> frontend) -> node_exporter -> Prometheus/Grafana
```
- `modules/tenant/` módulo HCL único (lo usan OpenTofu y Terraform). `engines/<motor>/` raíces finas.
- `packer/` AMI base. `ansible/` roles `base`, `db`, `backend`, `frontend`. `scanners/` gitleaks + trivy + checkov.
- `scripts/tenant.sh <crear|suspender|reanudar|destruir-plan|destruir> <opentofu|terraform> <tenant> [plan] [ami]`.

## Primer uso
```bash
cp infra/engines/opentofu/backend.hcl.example infra/engines/opentofu/backend.hcl   # ajustar bucket (idem terraform/)
infra/ansible/build-artifacts.sh                  # compila la app una vez
(cd infra/packer && packer init . && packer build .)   # AMI -> pasar su id como 5.º argumento
infra/scripts/tenant.sh crear opentofu utepsa standard ami-xxxx
```
State: bucket S3 versionado y cifrado, un state por tenant; con OpenTofu además cifrado con `TF_ENCRYPTION` (la frase NO va en el repo).
Secretos (JWT, contraseña admin) se generan en `infra/ansible/.secrets/<tenant>/` (ignorado por git).
