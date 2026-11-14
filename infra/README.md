# Infraestructura de tenants

```
Packer (AMI) -> OpenTofu | Terraform | Pulumi | CloudFormation (red + 3 VMs) -> cloud-init (arranque)
             -> Ansible (BD -> backend -> frontend) -> node_exporter -> Prometheus + Grafana
```
Los diagramas están en [`../docs/diagramas`](../docs/diagramas). Cómo se protege el estado y los secretos: [`../docs/estado-y-secretos.md`](../docs/estado-y-secretos.md).
Catálogo de planes: [`../docs/catalogo-de-planes.md`](../docs/catalogo-de-planes.md).

## Estructura
| Carpeta | Contenido |
|---|---|
| `modules/tenant/` | Módulo HCL único (red aislada con security groups encadenados, 3 VMs, IP elástica, suspender con `running`). Lo usan OpenTofu y Terraform. |
| `engines/opentofu`, `engines/terraform` | Raíces finas que llaman al módulo (solo cambia el binario). |
| `engines/pulumi`, `engines/cloudformation` | Segunda implementación (TypeScript / YAML) con la misma arquitectura y los mismos planes. |
| `packer/` | AMI base: Node 20, nginx, PostgreSQL, node_exporter, swap. |
| `ansible/` | Roles `base`, `db`, `backend`, `frontend`, `monitoring`. Idempotente. |
| `monitoring/tofu/` | Servidor de monitoreo aparte (EC2 + IP elástica). |
| `scanners/` | `run-scans.sh`: gitleaks + trivy + checkov, con resumen JSON. |
| `iam/` | Política IAM mínima para CloudFormation. |
| `scripts/` | `tenant.sh` (ciclo de vida de un tenant) y `monitoring.sh`. |

## Requisitos en el servidor que ejecuta el runner
`tofu`, `terraform`, `pulumi`, `ansible-core`, `packer`, `aws` (CLI v2), `node` ≥ 22, `python3`, `docker` (para trivy/checkov si no están instalados), `gitleaks`, `openssl`.
Credenciales de AWS con permisos sobre EC2, S3 (bucket `capa8-*`) y CloudFormation (stacks `tenant-*`).

## Puesta en marcha (una sola vez)
```bash
# 1. Bucket de estado (versionado + cifrado + sin acceso público). Ver docs/estado-y-secretos.md
# 2. Configurar el backend del estado (el archivo queda fuera de git)
cp infra/engines/opentofu/backend.hcl.example infra/engines/opentofu/backend.hcl      # editar el nombre del bucket
cp infra/engines/opentofu/backend.hcl infra/engines/terraform/backend.hcl
# 3. Frase de cifrado del estado de OpenTofu (fuera del repo)
mkdir -p ~/.config/capa8 && umask 077
printf 'export TF_ENCRYPTION='"'"'\nkey_provider "pbkdf2" "main" { passphrase = "%s" }\nmethod "aes_gcm" "default" { keys = key_provider.pbkdf2.main }\nstate { method = method.aes_gcm.default }\nplan  { method = method.aes_gcm.default }\n'"'"'\n' "$(openssl rand -hex 24)" > ~/.config/capa8/tf_encryption.env
# 4. Llave SSH para Ansible (la parte pública se inyecta en las VMs)
ssh-keygen -t ed25519 -f ~/.ssh/diplo_mod2_key -N ""      # el código espera ~/.ssh/diplo_mod2_key(.pub)
# 5. Compilar la app una sola vez (las VMs pequeñas no deben compilar)
infra/ansible/build-artifacts.sh
# 6. Imagen base con Packer (~9 min). Anota el AMI id que imprime
(cd infra/packer && packer init . && packer build .)
# 7. Servidor de monitoreo (Prometheus + Grafana). Imprime la URL de Grafana
infra/scripts/monitoring.sh crear
```
Después, en `Admin-institucional/server/.env` añade `PROVISIONER_AMI_ID=<ami>` y `PLATFORM_GRAFANA_URL=<url de Grafana>` (ver `.env.example`).

## Operar un tenant
```bash
infra/scripts/tenant.sh <crear|suspender|reanudar|destruir-plan|destruir> <opentofu|terraform|pulumi|cloudformation> <tenant> [plan] [ami_id]
# ejemplo
infra/scripts/tenant.sh crear opentofu utepsa standard ami-xxxxxxxx
```
`plan` = `basic` | `standard` | `advanced`. Variables opcionales: `TENANT_ENV` (`prod`|`staging`), `TENANT_REGION`, `TENANT_ADMIN_EMAIL`.
Normalmente **no se ejecuta a mano**: lo lanza el runner desde la pestaña **Despliegues** de la plataforma.

## Límites y costos
- La cuenta de AWS tiene una cuota por defecto de **16 vCPU** en instancias estándar. Un tenant `basic` usa 6 vCPU, uno `standard` 6 y el monitoreo 2.
- Una VM apagada no cobra cómputo, pero **sí** sus discos y su IP elástica. Al terminar: `Eliminar` los tenants desde la plataforma y `infra/scripts/monitoring.sh destruir`.
- Región fija: `us-east-2` (la AMI es de esa región).

## Probar sin AWS
Para ensayar la plataforma sin gastar, apunta `PROVISIONER_SCRIPT` a un script que imprima salida simulada: el runner no necesita saber que no es real.
