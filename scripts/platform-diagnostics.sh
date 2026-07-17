#!/usr/bin/env bash
# ─── Averrow Platform Diagnostics ────────────────────────────────
# Calls the /api/internal/platform-diagnostics endpoint and returns
# the full JSON response for Claude Code to interpret.
#
# Usage:
#   ./scripts/platform-diagnostics.sh              # default 6h window
#   ./scripts/platform-diagnostics.sh 24            # 24h window
#   AVERROW_HOURS=12 ./scripts/platform-diagnostics.sh
#
# Required env vars:
#   AVERROW_INTERNAL_SECRET  — must match the secret of the same name on the
#                              averrow Cloudflare Worker
#   AVERROW_API_URL          — (optional) defaults to https://averrow.com
#
# Exit codes:
#   0  success (JSON on stdout)
#   1  missing secret
#   2  HTTP error

set -euo pipefail

HOURS="${1:-${AVERROW_HOURS:-6}}"
API_URL="${AVERROW_API_URL:-https://averrow.com}"
SECRET="${AVERROW_INTERNAL_SECRET:-}"

if [ -z "$SECRET" ]; then
  echo "Error: AVERROW_INTERNAL_SECRET is not set." >&2
  echo "" >&2
  echo "Set it via:" >&2
  echo "  export AVERROW_INTERNAL_SECRET=<your-internal-secret>" >&2
  echo "" >&2
  echo "You can find it in your Cloudflare Worker secrets or wrangler.toml." >&2
  exit 1
fi

ENDPOINT="${API_URL}/api/internal/platform-diagnostics?hours=${HOURS}"

HTTP_CODE=$(curl -s -o /tmp/averrow-diag-response.json -w "%{http_code}" \
  -H "Authorization: Bearer ${SECRET}" \
  "${ENDPOINT}" 2>/dev/null)

if [ "$HTTP_CODE" -ne 200 ]; then
  echo "Error: HTTP ${HTTP_CODE} from ${ENDPOINT}" >&2
  cat /tmp/averrow-diag-response.json >&2
  rm -f /tmp/averrow-diag-response.json
  exit 2
fi

cat /tmp/averrow-diag-response.json
rm -f /tmp/averrow-diag-response.json
