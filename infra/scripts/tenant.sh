#!/usr/bin/env bash
# Ciclo de vida de un tenant con el motor elegido. Es lo que ejecuta el runner de la plataforma.
# Uso: infra/scripts/tenant.sh <crear|suspender|reanudar|destruir-plan|destruir> <opentofu|terraform|pulumi|cloudformation> <tenant> [plan] [ami_id]
set -euo pipefail
ACTION="${1:?accion}"; ENGINE="${2:?motor}"; TENANT="${3:?tenant}"; PLAN="${4:-basic}"; AMI="${5:-}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="$ROOT/infra/engines/$ENGINE"; ANS="$ROOT/infra/ansible"
REGION="${TENANT_REGION:-us-east-2}"; export AWS_DEFAULT_REGION="$REGION"
STACK="tenant-$TENANT"
ENV_NAME="${TENANT_ENV:-prod}"   # prod | staging (lo pasa el runner)
case "$ENGINE" in opentofu) BIN=tofu ;; terraform) BIN=terraform ;; pulumi|cloudformation) BIN="" ;; *) echo "motor no soportado: $ENGINE" >&2; exit 2 ;; esac
HCL=false; case "$ENGINE" in opentofu|terraform) HCL=true ;; esac

# Cifrado de state (solo OpenTofu). La frase vive FUERA del repo.
if [ "$ENGINE" = opentofu ]; then
  [ -n "${TF_ENCRYPTION:-}" ] || { [ -f "$HOME/.config/capa8/tf_encryption.env" ] && source "$HOME/.config/capa8/tf_encryption.env"; }
else unset TF_ENCRYPTION; fi

# ------------------------------------------------------------------ helpers comunes
bucket() { sed -n 's/^bucket *= *"\(.*\)"/\1/p' "$ROOT/infra/engines/opentofu/backend.hcl"; }
tag_filter=(--filters "Name=tag:Tenant,Values=$TENANT" "Name=tag:Project,Values=capa8-asistencia")
live_ids() { aws ec2 describe-instances "${tag_filter[@]}" "Name=instance-state-name,Values=pending,running,stopping,stopped" --query 'Reservations[].Instances[].InstanceId' --output text; }
ip_of() { # <rol> <Public|Private>
  aws ec2 describe-instances "${tag_filter[@]}" "Name=tag:Role,Values=$1" "Name=instance-state-name,Values=running" \
    --query "Reservations[].Instances[].${2}IpAddress" --output text; }
ec2_state() { # stop|start
  local ids; ids="$(live_ids)"; [ -n "$ids" ] || { echo "No hay máquinas del tenant $TENANT." >&2; return 1; }
  if [ "$1" = stop ]; then aws ec2 stop-instances --instance-ids $ids >/dev/null; aws ec2 wait instance-stopped --instance-ids $ids
  else aws ec2 start-instances --instance-ids $ids >/dev/null; aws ec2 wait instance-running --instance-ids $ids; fi
  echo "Máquinas del tenant: $([ "$1" = stop ] && echo detenidas || echo encendidas)"; }
secret_file() { mkdir -p "$ANS/.secrets/$TENANT"; chmod 700 "$ANS/.secrets/$TENANT"; echo "$ANS/.secrets/$TENANT/db_password"; }

# Inventario y targets de Prometheus a partir de las IPs reales (motores sin outputs propios)
build_from_aws() {
  FE_PUB="$(ip_of frontend Public)"; BE_PUB="$(ip_of backend Public)"; DB_PUB="$(ip_of db Public)"
  FE_PRIV="$(ip_of frontend Private)"; BE_PRIV="$(ip_of backend Private)"; DB_PRIV="$(ip_of db Private)"
  [ -n "$FE_PUB" ] && [ -n "$BE_PUB" ] && [ -n "$DB_PUB" ] || { echo "Faltan IPs: las máquinas no están encendidas." >&2; return 1; }
  local slug="${TENANT//-/_}"
  INVENTORY="[frontend]
$FE_PUB
[backend]
$BE_PUB
[db]
$DB_PUB

[all:vars]
ansible_user=ubuntu
tenant_id=$TENANT
plan=$PLAN
db_host=$DB_PRIV
backend_host=$BE_PRIV
db_name=asistencia_$slug
db_user=app_$slug"
  PROM_TARGETS="$(python3 - "$TENANT" "$PLAN" "$FE_PRIV" "$BE_PRIV" "$DB_PRIV" "$ENV_NAME" <<'PY'
import json,sys
t,p,f,b,d,e=sys.argv[1:]
print(json.dumps([{"targets":[f"{ip}:9100"],"labels":{"tenant":t,"env":e,"role":r,"plan":p}} for r,ip in (("frontend",f),("backend",b),("db",d))]))
PY
)"
  PROBE_TARGETS="$(python3 - "$TENANT" "$PLAN" "$FE_PRIV" "$ENV_NAME" <<'PY'
import json,sys
t,p,f,e=sys.argv[1:]
print(json.dumps([{"targets":[f"http://{f}/",f"http://{f}/api/health"],"labels":{"tenant":t,"env":e,"plan":p}}]))
PY
)"
  TENANT_URL="http://$FE_PUB"
}

# --- Monitoreo: registrar/quitar los targets del tenant en Prometheus (si el servidor de monitoreo existe) ---
MON_INV="$ANS/inventory/monitoring.ini"
mon_push() {  # <archivo_destino_en_servidor> <contenido_json>
  [ -f "$MON_INV" ] || { echo "(monitoreo no desplegado: se omite el registro en Prometheus)"; return 0; }
  # Un monitoreo apagado o inalcanzable NO debe hacer fallar el despliegue del tenant: se avisa y se sigue.
  ( cd "$ANS" && ansible monitoring -b -i "$MON_INV" -m copy -a "dest=$1 content='$2' mode=0644" >/dev/null 2>&1 ) \
    || echo "AVISO: no se pudo registrar el tenant en Prometheus (¿monitoreo apagado?). Reanuda el monitoreo y vuelve a ejecutar 'Desplegar' para registrarlo."
}
mon_remove() {
  [ -f "$MON_INV" ] || return 0
  ( cd "$ANS" && ansible monitoring -b -i "$MON_INV" -m shell -a "rm -f /opt/monitoring/prometheus/targets/$TENANT.json /opt/monitoring/prometheus/probes/$TENANT.json" >/dev/null ) || true
}

# Muestra los recursos que se borrarían con el mismo formato en todos los motores (la plataforma lo lee, RF-18)
print_destroy_list() {  # lee "tipo nombre" por stdin
  local n=0 line; while read -r line; do [ -n "$line" ] || continue; echo "  # $line will be destroyed"; n=$((n+1)); done
  echo "Plan: 0 to add, 0 to change, $n to destroy."; }

# ------------------------------------------------------------------ HCL (OpenTofu / Terraform)
VARS=(-var "tenant=$TENANT" -var "plan=$PLAN" -var "environment=$ENV_NAME"); [ -n "$AMI" ] && VARS+=(-var "ami_id=$AMI")
[ -n "${TENANT_REGION:-}" ] && VARS+=(-var "region=$TENANT_REGION")
tf() { "$BIN" -chdir="$DIR" "$@"; }
hcl_init() { tf init -input=false -reconfigure -no-color -backend-config=backend.hcl -backend-config="key=tenants/$TENANT/$ENGINE.tfstate" >/dev/null; }

# ------------------------------------------------------------------ Pulumi
pu() { ( cd "$DIR" && pulumi "$@" ); }
pulumi_prepare() {
  local pass="$HOME/.config/capa8/pulumi_passphrase"
  if [ ! -f "$pass" ]; then mkdir -p "$(dirname "$pass")"; ( umask 077; openssl rand -hex 24 > "$pass" ); fi
  export PULUMI_CONFIG_PASSPHRASE_FILE="$pass" PULUMI_SKIP_UPDATE_CHECK=true PULUMI_BACKEND_URL="s3://$(bucket)/pulumi?region=$REGION"
  [ -d "$DIR/node_modules" ] || ( cd "$DIR" && npm install --no-audit --no-fund >/dev/null )
  pu stack select --create "$STACK" >/dev/null
  pu config set aws:region "$REGION" >/dev/null; pu config set tenant "$TENANT" >/dev/null; pu config set plan "$PLAN" >/dev/null; pu config set environment "$ENV_NAME" >/dev/null
  [ -n "$AMI" ] && pu config set amiId "$AMI" >/dev/null || true
}

# ------------------------------------------------------------------ CloudFormation
cfn_deploy() {
  local ami="$AMI" vpc cidr
  [ -n "$ami" ] || ami="$(aws ec2 describe-images --owners 099720109477 --filters 'Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*' --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text)"
  vpc="$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)"
  cidr="$(aws ec2 describe-vpcs --vpc-ids "$vpc" --query 'Vpcs[0].CidrBlock' --output text)"
  if ! aws cloudformation deploy --stack-name "$STACK" --template-file "$DIR/template.yaml" --no-fail-on-empty-changeset \
      --tags Project=capa8-asistencia Tenant="$TENANT" Env="$ENV_NAME" ManagedBy=cloudformation \
      --parameter-overrides "Tenant=$TENANT" "Plan=$PLAN" "Environment=$ENV_NAME" "AmiId=$ami" "VpcId=$vpc" "VpcCidr=$cidr" \
        "PublicKey=$(cat "${TENANT_SSH_KEY:-$HOME/.ssh/diplo_mod2_key.pub}")"; then
    echo "--- eventos con error del stack ---" >&2
    aws cloudformation describe-stack-events --stack-name "$STACK" --query 'StackEvents[?contains(ResourceStatus,`FAILED`)].[LogicalResourceId,ResourceStatusReason]' --output text >&2 || true
    return 1
  fi
}

# ------------------------------------------------------------------ acciones
deploy_app() {  # configura las 3 VMs con Ansible y registra el tenant en Prometheus
  mkdir -p "$ANS/inventory"; printf '%s\n' "$INVENTORY" > "$ANS/inventory/$TENANT.ini"
  cd "$ANS"
  ansible all -i "inventory/$TENANT.ini" -m wait_for_connection -a "timeout=300" >/dev/null
  ansible-playbook -i "inventory/$TENANT.ini" site.yml
  cd "$ROOT"
  mon_push "/opt/monitoring/prometheus/targets/$TENANT.json" "$PROM_TARGETS"
  mon_push "/opt/monitoring/prometheus/probes/$TENANT.json" "$PROBE_TARGETS"
  echo "URL: $TENANT_URL"; echo "Credenciales admin: $ANS/.secrets/$TENANT/ (admin_password)"
}

case "$ACTION" in
  crear)
    "$ROOT/infra/scanners/run-scans.sh" >/dev/null || true       # escáneres ANTES de aprovisionar
    case "$ENGINE" in
      opentofu|terraform)
        hcl_init; tf apply -input=false -auto-approve -no-color "${VARS[@]}"
        INVENTORY="$(tf output -raw ansible_inventory)"; PROM_TARGETS="$(tf output -raw prometheus_targets)"
        PROBE_TARGETS="$(tf output -raw probe_targets)"; TENANT_URL="$(tf output -raw url)"
        export TENANT_DB_PASSWORD; TENANT_DB_PASSWORD="$(tf output -raw db_password)" ;;
      pulumi)
        pulumi_prepare; pu up --yes --skip-preview --non-interactive --color never
        build_from_aws; f="$(secret_file)"; [ -s "$f" ] || ( umask 077; openssl rand -hex 12 > "$f" )
        export TENANT_DB_PASSWORD; TENANT_DB_PASSWORD="$(cat "$f")" ;;
      cloudformation)
        cfn_deploy; build_from_aws; f="$(secret_file)"; [ -s "$f" ] || ( umask 077; openssl rand -hex 12 > "$f" )
        export TENANT_DB_PASSWORD; TENANT_DB_PASSWORD="$(cat "$f")" ;;
    esac
    deploy_app ;;
  suspender)
    if $HCL; then hcl_init; tf apply -input=false -auto-approve -no-color "${VARS[@]}" -var running=false; else ec2_state stop; fi ;;
  reanudar)
    if $HCL; then hcl_init; tf apply -input=false -auto-approve -no-color "${VARS[@]}" -var running=true
                  tf apply -refresh-only -input=false -auto-approve -no-color "${VARS[@]}" >/dev/null   # outputs al dia
    else ec2_state start; fi ;;
  destruir-plan)
    case "$ENGINE" in
      opentofu|terraform) hcl_init; tf plan -destroy -input=false -no-color "${VARS[@]}" ;;   # RF-18: mostrar qué se borra
      pulumi) pulumi_prepare; pu stack export | python3 -c 'import sys,json;[print(r["type"],r["urn"].split("::")[-1]) for r in json.load(sys.stdin)["deployment"].get("resources",[]) if not r["type"].startswith(("pulumi:","aws:index/provider"))]' | print_destroy_list ;;
      cloudformation) aws cloudformation list-stack-resources --stack-name "$STACK" --query 'StackResourceSummaries[].[ResourceType,LogicalResourceId]' --output text | tr '\t' ' ' | print_destroy_list ;;
    esac ;;
  destruir)
    case "$ENGINE" in
      opentofu|terraform) hcl_init; tf destroy -input=false -auto-approve -no-color "${VARS[@]}" ;;
      pulumi) pulumi_prepare; pu destroy --yes --non-interactive --color never; pu stack rm --yes "$STACK" >/dev/null ;;
      cloudformation)
        aws cloudformation delete-stack --stack-name "$STACK"
        if ! aws cloudformation wait stack-delete-complete --stack-name "$STACK"; then
          # El manejador de AWS::EC2::KeyPair de CloudFormation falla a veces al borrar: se borra la llave por EC2 y se reintenta sin ella.
          echo "El borrado falló; se elimina la llave SSH por EC2 y se reintenta."
          aws ec2 delete-key-pair --key-name "tenant-$TENANT-key" || true
          aws cloudformation delete-stack --stack-name "$STACK" --retain-resources KeyPair
          aws cloudformation wait stack-delete-complete --stack-name "$STACK"
        fi
        echo "Stack eliminado" ;;
    esac
    mon_remove; rm -rf "$ANS/inventory/$TENANT.ini" ;;
  *) echo "accion desconocida: $ACTION" >&2; exit 2 ;;
esac
