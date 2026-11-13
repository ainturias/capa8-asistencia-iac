#!/usr/bin/env bash
# Servidor de monitoreo (Prometheus + Grafana). Uso: infra/scripts/monitoring.sh <crear|suspender|reanudar|destruir>
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; DIR="$ROOT/infra/monitoring/tofu"; ANS="$ROOT/infra/ansible"
[ -n "${TF_ENCRYPTION:-}" ] || source "$HOME/.config/capa8/tf_encryption.env"
tf() { tofu -chdir="$DIR" "$@"; }
init() { tf init -input=false -reconfigure -no-color -backend-config=backend.hcl -backend-config="key=platform/monitoring.tfstate" >/dev/null; }
case "${1:?accion}" in
  crear)
    init; tf apply -input=false -auto-approve -no-color
    mkdir -p "$ANS/inventory"; tf output -raw ansible_inventory > "$ANS/inventory/monitoring.ini"
    cd "$ANS"; ansible monitoring -i inventory/monitoring.ini -m wait_for_connection -a "timeout=300" >/dev/null
    ansible-playbook -i inventory/monitoring.ini monitoring.yml
    echo "Grafana: $(tf output -raw grafana_url)  (usuario admin, clave en $ANS/.secrets/monitoring/grafana_admin_password)" ;;
  suspender) init; tf apply -input=false -auto-approve -no-color -var running=false ;;
  reanudar)  init; tf apply -input=false -auto-approve -no-color -var running=true ;;
  destruir)  init; tf destroy -input=false -auto-approve -no-color; rm -f "$ANS/inventory/monitoring.ini" ;;
  *) echo "accion desconocida" >&2; exit 2 ;;
esac
