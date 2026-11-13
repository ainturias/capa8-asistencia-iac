#!/usr/bin/env bash
# Ciclo de vida de un tenant con el motor elegido. Es lo que ejecutará el runner de la plataforma.
# Uso: infra/scripts/tenant.sh <crear|suspender|reanudar|destruir-plan|destruir> <opentofu|terraform> <tenant> [plan] [ami_id]
set -euo pipefail
ACTION="${1:?accion}"; ENGINE="${2:?motor}"; TENANT="${3:?tenant}"; PLAN="${4:-basic}"; AMI="${5:-}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="$ROOT/infra/engines/$ENGINE"; ANS="$ROOT/infra/ansible"
case "$ENGINE" in opentofu) BIN=tofu ;; terraform) BIN=terraform ;; *) echo "motor no soportado: $ENGINE" >&2; exit 2 ;; esac

# Cifrado de state (solo OpenTofu). La frase vive FUERA del repo.
if [ "$ENGINE" = opentofu ]; then
  [ -n "${TF_ENCRYPTION:-}" ] || { [ -f "$HOME/.config/capa8/tf_encryption.env" ] && source "$HOME/.config/capa8/tf_encryption.env"; }
else unset TF_ENCRYPTION; fi

VARS=(-var "tenant=$TENANT" -var "plan=$PLAN"); [ -n "$AMI" ] && VARS+=(-var "ami_id=$AMI")
tf() { "$BIN" -chdir="$DIR" "$@"; }

# --- Monitoreo: registrar/quitar los targets del tenant en Prometheus (si el servidor de monitoreo existe) ---
MON_INV="$ANS/inventory/monitoring.ini"
mon_push() {  # <archivo_destino_en_servidor> <contenido_json>
  [ -f "$MON_INV" ] || { echo "(monitoreo no desplegado: se omite el registro en Prometheus)"; return 0; }
  ( cd "$ANS" && ansible monitoring -b -i "$MON_INV" -m copy -a "dest=$1 content='$2' mode=0644" >/dev/null )
}
mon_remove() {
  [ -f "$MON_INV" ] || return 0
  ( cd "$ANS" && ansible monitoring -b -i "$MON_INV" -m shell -a "rm -f /opt/monitoring/prometheus/targets/$TENANT.json /opt/monitoring/prometheus/probes/$TENANT.json" >/dev/null ) || true
}
mon_register() {
  mon_push "/opt/monitoring/prometheus/targets/$TENANT.json" "$(tf output -raw prometheus_targets)"
  mon_push "/opt/monitoring/prometheus/probes/$TENANT.json"  "$(tf output -raw probe_targets)"
}

init() { tf init -input=false -reconfigure -no-color -backend-config=backend.hcl \
           -backend-config="key=tenants/$TENANT/$ENGINE.tfstate" >/dev/null; }

case "$ACTION" in
  crear)
    "$ROOT/infra/scanners/run-scans.sh" >/dev/null || true       # escáneres ANTES de aprovisionar
    init; tf apply -input=false -auto-approve -no-color "${VARS[@]}"
    mkdir -p "$ANS/inventory"; tf output -raw ansible_inventory > "$ANS/inventory/$TENANT.ini"
    export TENANT_DB_PASSWORD; TENANT_DB_PASSWORD="$(tf output -raw db_password)"
    cd "$ANS"
    ansible all -i "inventory/$TENANT.ini" -m wait_for_connection -a "timeout=300" >/dev/null
    ansible-playbook -i "inventory/$TENANT.ini" site.yml
    cd "$ROOT"; mon_register
    echo "URL: $(tf output -raw url)"; echo "Credenciales admin: $ANS/.secrets/$TENANT/ (admin_password)" ;;
  suspender) init; tf apply -input=false -auto-approve -no-color "${VARS[@]}" -var running=false ;;
  reanudar)  init; tf apply -input=false -auto-approve -no-color "${VARS[@]}" -var running=true
             tf apply -refresh-only -input=false -auto-approve -no-color "${VARS[@]}" >/dev/null ;;   # outputs al dia
  destruir-plan) init; tf plan -destroy -input=false -no-color "${VARS[@]}" ;;   # RF-18: mostrar qué se borra
  destruir)  init; tf destroy -input=false -auto-approve -no-color "${VARS[@]}"; mon_remove ;;
  *) echo "accion desconocida: $ACTION" >&2; exit 2 ;;
esac
