#!/usr/bin/env bash
# ─── Averrow Brand-Link Cleanup Driver ───────────────────────────
# Loops POST /api/internal/brand-links/cleanup over every linked threat
# (rowid keyset cursor) and prints an aggregated summary. See
# packages/averrow-worker/src/lib/brand-link-cleanup.ts.
#
# Usage:
#   ./scripts/brand-link-cleanup.sh                 # dry run (writes nothing)
#   ./scripts/brand-link-cleanup.sh apply           # apply — prompts for confirmation
#   BATCH=1000 START_CURSOR=123456 ./scripts/brand-link-cleanup.sh   # resume
#
# Required env vars:
#   AVERROW_INTERNAL_SECRET  — must match the averrow Worker secret
#   AVERROW_API_URL          — (optional) defaults to https://averrow.com
#
# Progress (cursor + running totals) is written to
# ${STATE_FILE:-./brand-link-cleanup.state.json} after every batch so an
# interrupted run can resume with START_CURSOR.
#
# Undo (apply mode): every relink/clear is logged in
# brand_link_cleanup_log; see migrations/0271_brand_link_cleanup_log.sql.

set -euo pipefail

MODE="${1:-dry_run}"
API_URL="${AVERROW_API_URL:-https://averrow.com}"
SECRET="${AVERROW_INTERNAL_SECRET:-}"
BATCH="${BATCH:-500}"
CURSOR="${START_CURSOR:-0}"
STATE_FILE="${STATE_FILE:-./brand-link-cleanup.state.json}"
CONFIRM_TOKEN="apply-brand-link-cleanup"

if [ -z "$SECRET" ]; then
  echo "Error: AVERROW_INTERNAL_SECRET is not set." >&2
  exit 1
fi
if [ "$MODE" != "dry_run" ] && [ "$MODE" != "apply" ]; then
  echo "Usage: $0 [dry_run|apply]" >&2
  exit 1
fi

QS="mode=${MODE}&limit=${BATCH}"
if [ "$MODE" = "apply" ]; then
  echo "APPLY mode rewrites threats.target_brand_id on production (logged + reversible)." >&2
  read -r -p "Type '${CONFIRM_TOKEN}' to continue: " answer
  [ "$answer" = "$CONFIRM_TOKEN" ] || { echo "Aborted." >&2; exit 1; }
  QS="${QS}&confirm=${CONFIRM_TOKEN}"
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
echo '{}' > "$TMP.totals"

while :; do
  HTTP_CODE=$(curl -s -o "$TMP" -w "%{http_code}" -X POST \
    -H "Authorization: Bearer ${SECRET}" \
    "${API_URL}/api/internal/brand-links/cleanup?${QS}&cursor=${CURSOR}")
  if [ "$HTTP_CODE" != "200" ]; then
    echo "HTTP ${HTTP_CODE} at cursor ${CURSOR}: $(head -c 500 "$TMP")" >&2
    echo "Resume with: START_CURSOR=${CURSOR} $0 ${MODE}" >&2
    exit 2
  fi

  # Merge this batch into the running totals; print one progress line.
  CURSOR=$(python3 - "$TMP" "$TMP.totals" "$STATE_FILE" <<'PY'
import json, sys
batch = json.load(open(sys.argv[1]))["data"]
totals = json.load(open(sys.argv[2]))
for k in ("scanned", "keep", "relink", "clear", "alerts_affected", "written"):
    totals[k] = totals.get(k, 0) + batch[k]
for k in ("keep_by_method", "by_reason", "removed_by_brand", "added_by_brand"):
    agg = totals.setdefault(k, {})
    for key, n in batch[k].items():
        agg[key] = agg.get(key, 0) + n
totals["next_cursor"] = batch["next_cursor"]
totals["done"] = batch["done"]
if batch.get("reconciled"):
    totals["reconciled"] = batch["reconciled"]
json.dump(totals, open(sys.argv[2], "w"))
json.dump(totals, open(sys.argv[3], "w"))
print(f"scanned={totals['scanned']} keep={totals['keep']} relink={totals['relink']} "
      f"clear={totals['clear']} cursor={batch['next_cursor']}", file=sys.stderr)
print(batch["next_cursor"] if not batch["done"] else "DONE")
PY
)
  [ "$CURSOR" = "DONE" ] && break
done

python3 - "$TMP.totals" <<'PY'
import json, sys
t = json.load(open(sys.argv[1]))
top = lambda d, n=25: dict(sorted(d.items(), key=lambda kv: -kv[1])[:n])
summary = {k: t[k] for k in ("scanned", "keep", "relink", "clear", "alerts_affected", "written")}
summary["keep_by_method"] = t["keep_by_method"]
summary["by_reason"] = t["by_reason"]
summary["top_removed_by_brand"] = top(t["removed_by_brand"])
summary["top_added_by_brand"] = top(t["added_by_brand"])
summary["brands_losing_links"] = len(t["removed_by_brand"])
if "reconciled" in t:
    summary["reconciled"] = t["reconciled"]
print(json.dumps(summary, indent=2))
PY
rm -f "$TMP.totals"
