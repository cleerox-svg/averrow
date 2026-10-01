#!/usr/bin/env bash
# ─── Averrow Brand-Link Cleanup Driver ───────────────────────────
# Loops POST /api/internal/brand-links/cleanup over every linked threat
# (rowid keyset cursor) and prints an aggregated summary. See
# packages/averrow-worker/src/lib/brand-link-cleanup.ts.
#
# Usage:
#   ./scripts/brand-link-cleanup.sh                       # dry run (writes nothing)
#   RUN_ID=cleanup-2026-10 ./scripts/brand-link-cleanup.sh apply
#   RUN_ID=cleanup-2026-10 ./scripts/brand-link-cleanup.sh undo
#   START_CURSOR=123456 ./scripts/brand-link-cleanup.sh   # resume (totals reloaded)
#
# apply/undo prompt for the confirm token, then run ONE brand-counter
# reconcile at the end. After apply/undo, rebuild cube history older than
# the cube-healer's 30-day window:  ./scripts/cube-backfill.sh all <days>
#
# Required env vars:
#   AVERROW_INTERNAL_SECRET  — must match the averrow Worker secret
#   AVERROW_API_URL          — (optional) defaults to https://averrow.com
# Optional: BATCH (default 500), RUN_ID (apply/undo; default
#   cleanup-<UTC date>), STATE_FILE (default ./brand-link-cleanup.state.json)

set -euo pipefail

MODE="${1:-dry_run}"
API_URL="${AVERROW_API_URL:-https://averrow.com}"
SECRET="${AVERROW_INTERNAL_SECRET:-}"
BATCH="${BATCH:-500}"
CURSOR="${START_CURSOR:-0}"
RUN_ID="${RUN_ID:-cleanup-$(date -u +%Y-%m-%d)}"
STATE_FILE="${STATE_FILE:-./brand-link-cleanup.state.json}"

if [ -z "$SECRET" ]; then
  echo "Error: AVERROW_INTERNAL_SECRET is not set." >&2
  exit 1
fi
case "$API_URL" in
  https://*) ;;
  *) echo "Error: AVERROW_API_URL must be https:// (the secret is sent as a header)." >&2; exit 1 ;;
esac
case "$MODE" in
  dry_run) TOKEN="" ;;
  apply)   TOKEN="apply-brand-link-cleanup" ;;
  undo)    TOKEN="undo-brand-link-cleanup" ;;
  *) echo "Usage: $0 [dry_run|apply|undo]" >&2; exit 1 ;;
esac

QS="mode=${MODE}&limit=${BATCH}&run_id=${RUN_ID}"
if [ -n "$TOKEN" ]; then
  echo "${MODE^^} mode rewrites threats.target_brand_id on production (run_id=${RUN_ID}; logged + reversible)." >&2
  read -r -p "Type '${TOKEN}' to continue: " answer
  [ "$answer" = "$TOKEN" ] || { echo "Aborted." >&2; exit 1; }
  QS="${QS}&confirm=${TOKEN}"
fi

TMP="$(mktemp)"
TOTALS="$(mktemp)"
trap 'rm -f "$TMP" "$TOTALS"' EXIT

# Resume: reload the running totals saved by the interrupted run.
if [ "$CURSOR" != "0" ] && [ -f "$STATE_FILE" ]; then
  cp "$STATE_FILE" "$TOTALS"
else
  echo '{}' > "$TOTALS"
fi

resume_hint() {
  echo "Resume with: START_CURSOR=${CURSOR} RUN_ID=${RUN_ID} $0 ${MODE}" >&2
}

# The secret goes to curl on stdin (-K -), never on its command line.
post() {
  printf 'header = "Authorization: Bearer %s"\n' "$SECRET" \
    | curl -sS -K - -o "$TMP" -w "%{http_code}" -X POST "${API_URL}/api/internal/brand-links/cleanup?$1"
}

while :; do
  HTTP_CODE=$(post "${QS}&cursor=${CURSOR}") || HTTP_CODE="000"
  if [ "$HTTP_CODE" != "200" ]; then
    echo "HTTP ${HTTP_CODE} at cursor ${CURSOR}: $(head -c 500 "$TMP" 2>/dev/null)" >&2
    resume_hint
    exit 2
  fi

  # Merge this batch into the running totals; print one progress line.
  NEXT=$(python3 - "$TMP" "$TOTALS" "$STATE_FILE" <<'PY'
import json, sys
batch = json.load(open(sys.argv[1]))["data"]
totals = json.load(open(sys.argv[2]))
for k in ("scanned", "keep", "relink", "clear", "alerts_affected", "changed", "skipped"):
    totals[k] = totals.get(k, 0) + batch[k]
for k in ("keep_by_method", "by_reason", "removed_by_brand", "added_by_brand"):
    agg = totals.setdefault(k, {})
    for key, n in batch[k].items():
        agg[key] = agg.get(key, 0) + n
totals["next_cursor"] = batch["next_cursor"]
json.dump(totals, open(sys.argv[2], "w"))
json.dump(totals, open(sys.argv[3], "w"))
print(f"scanned={totals['scanned']} keep={totals['keep']} relink={totals['relink']} "
      f"clear={totals['clear']} changed={totals['changed']} cursor={batch['next_cursor']}", file=sys.stderr)
print("DONE" if batch["done"] else batch["next_cursor"])
PY
) || { echo "Could not parse the response at cursor ${CURSOR}." >&2; resume_hint; exit 2; }
  [ "$NEXT" = "DONE" ] && break
  CURSOR="$NEXT"
done

if [ "$MODE" != "dry_run" ]; then
  HTTP_CODE=$(post "mode=reconcile&run_id=${RUN_ID}") || HTTP_CODE="000"
  if [ "$HTTP_CODE" = "200" ]; then
    python3 -c 'import json,sys; t=json.load(open(sys.argv[2])); t["reconciled"]=json.load(open(sys.argv[1]))["data"]["reconciled"]; json.dump(t,open(sys.argv[2],"w"))' "$TMP" "$TOTALS"
  else
    echo "Reconcile failed (HTTP ${HTTP_CODE}); re-run: curl … ?mode=reconcile — counters also self-heal on the 6-hourly cube_healer." >&2
  fi
fi

python3 - "$TOTALS" <<'PY'
import json, sys
t = json.load(open(sys.argv[1]))
top = lambda d, n=25: dict(sorted(d.items(), key=lambda kv: -kv[1])[:n])
summary = {k: t.get(k, 0) for k in ("scanned", "keep", "relink", "clear", "alerts_affected", "changed", "skipped")}
summary["keep_by_method"] = t.get("keep_by_method", {})
summary["by_reason"] = t.get("by_reason", {})
summary["top_removed_by_brand"] = top(t.get("removed_by_brand", {}))
summary["top_added_by_brand"] = top(t.get("added_by_brand", {}))
summary["brands_losing_links"] = len(t.get("removed_by_brand", {}))
if "reconciled" in t:
    summary["reconciled"] = t["reconciled"]
print(json.dumps(summary, indent=2))
PY
if [ "$MODE" != "dry_run" ]; then
  echo "Next: rebuild cube history beyond 30 days — ./scripts/cube-backfill.sh all <days>" >&2
fi
