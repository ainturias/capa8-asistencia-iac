#!/usr/bin/env bash
# Construye la app UNA vez en el equipo de control (las VMs t3.micro no deben compilar).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; APP="$HERE/../../admin-docente-alumno"
mkdir -p "$HERE/artifacts"
( cd "$APP/server" && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null \
  && tar -czf "$HERE/artifacts/server.tgz" dist package.json package-lock.json )
( cd "$APP/client" && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null \
  && ( cd dist && tar -czf "$HERE/artifacts/client.tgz" -- * ) )   # sin entrada "./" => idempotente
ls -lh "$HERE/artifacts"
