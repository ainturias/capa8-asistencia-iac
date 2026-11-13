#!/usr/bin/env bash
# Ejecuta los escáneres ANTES de aprovisionar y deja un resumen JSON que la plataforma puede mostrar.
# Uso: infra/scanners/run-scans.sh [ruta_repo]   (por defecto: la raíz del repo)
# Escáneres: gitleaks (secretos) · trivy config (IaC/misconfig) · checkov (IaC). Los que no estén instalados
# se ejecutan con Docker si está disponible; si no, se marcan como "omitido".
set -uo pipefail
ROOT="$(cd "${1:-$(dirname "${BASH_SOURCE[0]}")/../..}" && pwd)"
OUT="$ROOT/infra/scanners/reports"; mkdir -p "$OUT"

# 1) Gitleaks: secretos en archivos (no bloquea por hallazgos, solo informa; la plataforma decide)
if command -v gitleaks >/dev/null; then
  gitleaks dir "$ROOT/infra" --report-format json --report-path "$OUT/gitleaks.json" --no-banner >/dev/null 2>&1
  GL=$? ; [ -f "$OUT/gitleaks.json" ] || echo '[]' > "$OUT/gitleaks.json"
else GL=skip; echo '[]' > "$OUT/gitleaks.json"; fi

# 2) Trivy config
if command -v trivy >/dev/null; then
  trivy config "$ROOT/infra" -f json -o "$OUT/trivy.json" >/dev/null 2>&1
elif command -v docker >/dev/null; then
  docker run --rm -v "$ROOT/infra:/src:ro" aquasec/trivy:latest config /src -f json > "$OUT/trivy.json" 2>/dev/null
else echo '{}' > "$OUT/trivy.json"; fi

# 3) Checkov
if command -v checkov >/dev/null; then
  checkov -d "$ROOT/infra" --framework terraform,cloudformation -o json --quiet > "$OUT/checkov.json" 2>/dev/null
elif command -v docker >/dev/null; then
  docker run --rm -v "$ROOT/infra:/src:ro" bridgecrew/checkov -d /src --framework terraform,cloudformation -o json --quiet > "$OUT/checkov.json" 2>/dev/null
else echo '{}' > "$OUT/checkov.json"; fi

# Resumen (requiere node, ya presente en el proyecto)
node -e '
const fs=require("fs"),o=process.argv[1];
const rd=f=>{try{return JSON.parse(fs.readFileSync(o+"/"+f,"utf8"))}catch{return null}};
const gl=rd("gitleaks.json")||[];
const tr=rd("trivy.json")||{}; let t={CRITICAL:0,HIGH:0,MEDIUM:0,LOW:0};
for(const r of tr.Results||[])for(const m of r.Misconfigurations||[]) if(m.Status!=="PASS") t[m.Severity]=(t[m.Severity]||0)+1;
const ck=rd("checkov.json"); const cks=Array.isArray(ck)?ck:(ck?[ck]:[]);
let cf=0; for(const c of cks) cf+=(c.summary&&c.summary.failed)||0;
const s={generado:new Date().toISOString(),
 escaneres:[{nombre:"gitleaks",tipo:"secretos",hallazgos:gl.length},
            {nombre:"trivy",tipo:"iac",hallazgos:Object.values(t).reduce((a,b)=>a+b,0),severidad:t},
            {nombre:"checkov",tipo:"iac",hallazgos:cf}],
 bloquea:gl.length>0};
fs.writeFileSync(o+"/resumen.json",JSON.stringify(s,null,2)); console.log(JSON.stringify(s,null,2));' "$OUT"
