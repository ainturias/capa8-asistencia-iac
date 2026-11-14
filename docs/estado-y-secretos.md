# Cómo se almacena y protege el estado (state) y los secretos

Requisito no funcional del proyecto final: *documentar cómo se almacena y protege el estado del motor de infraestructura*.

## 1. Qué es el estado y por qué importa
El estado es el registro de **qué recursos reales creó** cada herramienta. Con él sabe qué crear, cambiar o borrar, y es lo que permite
**reintentar sin duplicar** (RF-12). También contiene datos sensibles (por ejemplo la contraseña de la BD del tenant), por eso se protege.

## 2. Dónde vive el estado, por motor

| Motor | Dónde | Protección |
|---|---|---|
| **OpenTofu** | Bucket S3 `tenants/<tenant>/opentofu.tfstate` | Cifrado **de OpenTofu** (`TF_ENCRYPTION`: PBKDF2 + AES-GCM) **y** SSE-S3 del bucket. El archivo en S3 no es legible. |
| **Terraform** | Bucket S3 `tenants/<tenant>/terraform.tfstate` | SSE-S3 del bucket (Terraform no cifra el state por sí mismo). |
| **Pulumi** | Bucket S3 `pulumi/` (backend `s3://`) | SSE-S3 + los secretos del stack se cifran con una *passphrase* local. |
| **CloudFormation** | **No hay archivo de estado**: AWS guarda el stack `tenant-<tenant>` | Permisos IAM limitados a stacks `tenant-*` (`infra/iam/cloudformation-policy.json`). |
| Servidor de monitoreo | Bucket S3 `platform/monitoring.tfstate` | Igual que OpenTofu. |

**Un estado por tenant.** Así un `destroy` de un tenant no toca a otro, los fallos quedan aislados y se pueden ejecutar operaciones en paralelo.

## 3. Protección del bucket
- **Versionado activado:** se puede recuperar una versión anterior si un estado se daña.
- **Cifrado en reposo** (SSE-S3, AES-256) por defecto.
- **Bloqueo de acceso público** completo (4 opciones activas).
- **Bloqueo contra ejecuciones simultáneas** con `use_lockfile = true` (bloqueo nativo de S3): dos `apply` al mismo tiempo sobre el mismo tenant fallan en lugar de corromper el estado. Además la plataforma permite **un solo trabajo activo por tenant**.
- **Acceso por IAM:** solo el usuario del runner puede leer/escribir el bucket (política limitada a buckets `capa8-*`).

## 4. Cifrado del estado con OpenTofu
Se activa con la variable de entorno `TF_ENCRYPTION`, que contiene el bloque `encryption` de OpenTofu:

```hcl
key_provider "pbkdf2" "main" { passphrase = "<frase larga generada, NO en el repo>" }
method "aes_gcm" "default" { keys = key_provider.pbkdf2.main }
state { method = method.aes_gcm.default }
plan  { method = method.aes_gcm.default }
```
- La frase vive en `~/.config/capa8/tf_encryption.env` (permisos `600`), **fuera del repositorio**. `tenant.sh` la carga solo para OpenTofu.
- **Si se pierde la frase, se pierde el estado** de los tenants creados con OpenTofu. Hay que respaldarla en un gestor de contraseñas.
- Un estado cifrado por OpenTofu **no puede leerlo Terraform**: por eso cada motor usa su propia clave de estado (`<tenant>/opentofu.tfstate` vs `<tenant>/terraform.tfstate`).

## 5. Secretos: dónde están y dónde NO
| Secreto | Cómo se maneja | Nunca en |
|---|---|---|
| Credenciales de AWS | `~/.aws/credentials` o variables `AWS_*` del servidor de la plataforma | repositorio, código, logs |
| Contraseña de la BD del tenant | Se genera al crear el tenant (`random_password` o `openssl`) y se pasa a Ansible por variable de entorno | repositorio |
| `JWT_SECRET`, contraseña del admin del tenant | Se generan y quedan en `infra/ansible/.secrets/<tenant>/` (ignorado por git); en la VM van a `/etc/asistencia-backend.env` con permisos `0640` | repositorio |
| Frase de cifrado del estado | `~/.config/capa8/tf_encryption.env` | repositorio |
| Passphrase de Pulumi | `~/.config/capa8/pulumi_passphrase` | repositorio |
| Contraseña de Grafana | `infra/ansible/.secrets/monitoring/` | repositorio |
| `.env` de la plataforma | Solo en el servidor (ignorado por git; el repo tiene `.env.example`) | repositorio |

Controles automáticos:
- `.gitignore` excluye `.env`, `*.pem`, `*.tfstate*`, `backend.hcl`, `.secrets/`, `artifacts/`, `Pulumi.<stack>.yaml`.
- **Antes de cada despliegue** el runner ejecuta `gitleaks` (secretos), `trivy` y `checkov` y muestra el resultado en la plataforma.
- El proceso hijo del runner recibe una **lista blanca de variables** de entorno: nunca hereda `PLATFORM_*` ni `DATABASE_URL`.
- Los logs de la plataforma **ocultan** contraseñas, tokens, claves AWS y llaves privadas antes de guardarlos o mostrarlos.
- Los errores se muestran con un mensaje comprensible, sin volcar la salida completa.

## 6. Qué haría falta en producción (fuera de alcance del proyecto)
- Guardar secretos en AWS Secrets Manager / SSM Parameter Store en lugar de archivos locales.
- Cifrar con una clave KMS (en vez de una frase) y rotarla.
- Restringir `admin_cidr` (SSH) a IPs conocidas y poner Grafana detrás de HTTPS con autenticación.
- Replicar el bucket de estado a otra región.
