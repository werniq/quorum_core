#!/usr/bin/env bash
# Collect soak-test evidence. Does not declare Quorum production-ready.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PROJECT="${QUORUM_SOAK_PROJECT:-quorum-soak}"
BASE="${PUBLIC_BASE_URL:-http://127.0.0.1:3000}"
OUT="${SOAK_REPORT:-$ROOT/docs/verification/artifacts/soak-check-$(date +%Y%m%d-%H%M%S).txt}"
mkdir -p "$(dirname "$OUT")"

{
  echo "=== Quorum soak check $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
  echo "project=$PROJECT base=$BASE"
  echo
  echo "--- containers ---"
  docker compose -p "$PROJECT" -f docker-compose.e2e.yml ps || true
  echo
  echo "--- docker stats (snapshot) ---"
  docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" $(docker compose -p "$PROJECT" -f docker-compose.e2e.yml ps -q 2>/dev/null) 2>/dev/null || true
  echo
  echo "--- health ---"
  for path in /readyz /health/live /health/watcher; do
    code=$(curl -s -o /tmp/quorum-soak-body -w "%{http_code}" "$BASE$path" || echo "err")
    echo "$path → $code"
    head -c 400 /tmp/quorum-soak-body 2>/dev/null || true
    echo
  done
  echo
  echo "--- quorum logs (last 80 lines, redact tokens) ---"
  docker compose -p "$PROJECT" -f docker-compose.e2e.yml logs --tail=80 quorum 2>/dev/null | sed -E 's/(secret|token|password|kek)=[^ ]*/\1=REDACTED/gi' || true
  echo
  echo "--- n8n logs (last 40 lines) ---"
  docker compose -p "$PROJECT" -f docker-compose.e2e.yml logs --tail=40 n8n 2>/dev/null || true
  echo
  echo "Owner must inspect: open incidents, failed notifications, connector health, catalog duplicates, false alerts."
  echo "This script does not auto-pass or fail the soak."
} | tee "$OUT"

echo "[soak] wrote $OUT"
