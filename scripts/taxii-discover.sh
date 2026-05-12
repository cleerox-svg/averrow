#!/usr/bin/env bash
# ─── Averrow TAXII Discovery Helper ───────────────────────────────
# Probes a TAXII 2.1 server to enumerate its api_roots + collections
# so we know exactly what to seed into feed_configs before adding a
# new TAXII collection. Auto-detects whether the URL you give is a
# discovery resource or an api_root resource — works for both.
#
# This exists to never repeat the OTX seed bug (PR #1271): we
# guessed at the api_root path and collection_id, shipped it, and
# every pull hung for >15 min until we fixed the URL. Now you can
# run this BEFORE inserting the feed_configs row.
#
# Usage:
#   ./scripts/taxii-discover.sh <root_url> [auth_type] [api_key_env] [username]
#
# Examples:
#   # Anonymous public collections (most public TAXII servers).
#   ./scripts/taxii-discover.sh https://otx.alienvault.com/taxii/root/
#   ./scripts/taxii-discover.sh https://cti.eclecticiq.com/taxii/discovery
#
#   # Bearer auth (e.g. OTX private collections).
#   ./scripts/taxii-discover.sh https://otx.alienvault.com/taxii/root/ bearer OTX_API_KEY
#
#   # Basic auth (e.g. CIRCL partner access).
#   ./scripts/taxii-discover.sh https://example.com/taxii/ basic SOME_KEY some_username
#
# Required env vars:
#   AVERROW_INTERNAL_SECRET  — must match the secret on the worker
#   AVERROW_API_URL          — (optional) defaults to https://averrow.com
#
# Exit codes:
#   0  success (JSON on stdout)
#   1  missing args / secret
#   2  HTTP error

set -euo pipefail

ROOT_URL="${1:-}"
AUTH_TYPE="${2:-none}"
API_KEY_ENV="${3:-}"
USERNAME="${4:-}"

if [ -z "$ROOT_URL" ]; then
  echo "Error: root_url is required as the first argument." >&2
  echo "" >&2
  echo "Usage:" >&2
  echo "  ./scripts/taxii-discover.sh <root_url> [auth_type] [api_key_env] [username]" >&2
  echo "" >&2
  echo "Examples:" >&2
  echo "  ./scripts/taxii-discover.sh https://otx.alienvault.com/taxii/root/" >&2
  echo "  ./scripts/taxii-discover.sh https://cti.eclecticiq.com/taxii/discovery" >&2
  exit 1
fi

API_URL="${AVERROW_API_URL:-https://averrow.com}"
SECRET="${AVERROW_INTERNAL_SECRET:-}"

if [ -z "$SECRET" ]; then
  echo "Error: AVERROW_INTERNAL_SECRET is not set." >&2
  echo "Set it via: export AVERROW_INTERNAL_SECRET=<your-internal-secret>" >&2
  exit 1
fi

# Build query string. URL-encode the values to survive shells.
encode() {
  python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"
}

QS="root_url=$(encode "$ROOT_URL")&auth_type=$(encode "$AUTH_TYPE")"
if [ -n "$API_KEY_ENV" ]; then
  QS="${QS}&api_key_env=$(encode "$API_KEY_ENV")"
fi
if [ -n "$USERNAME" ]; then
  QS="${QS}&username=$(encode "$USERNAME")"
fi

ENDPOINT="${API_URL}/api/internal/taxii/discover?${QS}"

HTTP_CODE=$(curl -s -o /tmp/averrow-taxii-discover-response.json -w "%{http_code}" \
  -H "Authorization: Bearer ${SECRET}" \
  "${ENDPOINT}" 2>/dev/null)

if [ "$HTTP_CODE" -ne 200 ]; then
  echo "Error: HTTP ${HTTP_CODE} from ${ENDPOINT}" >&2
  cat /tmp/averrow-taxii-discover-response.json >&2
  rm -f /tmp/averrow-taxii-discover-response.json
  exit 2
fi

cat /tmp/averrow-taxii-discover-response.json
rm -f /tmp/averrow-taxii-discover-response.json
