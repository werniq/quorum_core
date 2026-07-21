#!/usr/bin/env bash
# Start a manual soak-test environment for Quorum + n8n.
# Does NOT declare production readiness. Collects a long-running setup for the owner.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PROJECT="${QUORUM_SOAK_PROJECT:-quorum-soak}"
export QUORUM_CREDENTIAL_KEK="${QUORUM_CREDENTIAL_KEK:-soak-test-kek-change-me-32chars}"
export QUORUM_SETUP_TOKEN="${QUORUM_SETUP_TOKEN:-soak-setup-token-min-24-chars}"
export QUORUM_UI_AUTH_ENABLED="${QUORUM_UI_AUTH_ENABLED:-true}"
export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-http://127.0.0.1:3000}"
export N8N_IMAGE="${N8N_IMAGE:-n8nio/n8n:1.95.3}"
export QUORUM_HOST_PORT="${QUORUM_HOST_PORT:-3000}"
export N8N_HOST_PORT="${N8N_HOST_PORT:-5678}"

echo "[soak] project=$PROJECT"
echo "[soak] Ensure you have configured at least:"
echo "  - one scheduled n8n → Quorum signed heartbeat workflow"
echo "  - one webhook-triggered heartbeat workflow"
echo "  - one workflow that can return zero items"
echo "  - one workflow calling an external test API"
echo "  - one intentionally interrupted / disabled workflow"
echo "[soak] Starting compose (e2e stack as soak base)..."

docker compose -p "$PROJECT" -f docker-compose.e2e.yml up --build -d

echo "[soak] Quorum: $PUBLIC_BASE_URL"
echo "[soak] n8n:    http://127.0.0.1:${N8N_HOST_PORT}"
echo "[soak] Run scripts/check-soak-test.sh periodically. See docs/known-limitations.md (Owner soak)"
echo "[soak] Stop with: docker compose -p $PROJECT -f docker-compose.e2e.yml down -v"
