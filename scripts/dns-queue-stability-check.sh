#!/usr/bin/env bash
# ─── DNS-queue split stability check ─────────────────────────────
#
# Prints a single green/red verdict over five signals documented in
# docs/PLATFORM_DATA_DEPENDENCIES.md §3:
#
#   1. dns-backfill reads from queue (not threats) on every tick
#   2. Throughput parity vs pre-flip baseline
#   3. Zero parity-drift or stalled platform notifications fired
#   4. Reconciler keeps converging (batches_failed=0, delta≈0)
#   5. Main DB read budget actually shrank
#
# Three lifecycle uses for this script:
#
#   A. Pre-PR-4 gate (before shipping cleanup) — confirm signals are
#      stable for 24h after PR-3 deploys. Signal 5 will read YELLOW
#      while the threats-side dual-write is still firing; that's
#      expected pre-cleanup and is in fact the harvest PR-4 collects.
#
#   B. Post-PR-4 verify (immediately after deploy) — re-run to
#      confirm nothing broke. Key signals:
#        Signal 1 — still source=queue on every tick (regression
#                   sentinel: the deploy didn't unbind DNS_QUEUE_DB)
#        Signal 2 — throughput unchanged from pre-cleanup
#        Signal 4 — reconciler still draining + healthy (proves the
#                   reader migration didn't break the candidate-mirror
#                   logic). batches_failed must remain 0.
#        Signal 5 — flips to GREEN. dns-backfill queries vanish from
#                   the main-DB top-N. THIS IS the cleanup proof.
#
#   C. 24h post-PR-4 steady-state check — re-run with `24` and confirm
#      the GREEN verdict holds through a full feed-ingest cycle. The
#      window has rolled past the deploy moment so any deploy-edge
#      noise is gone.
#
# Usage:
#   ./scripts/dns-queue-stability-check.sh          # default 24h window
#   ./scripts/dns-queue-stability-check.sh 6        # 6h window
#   AVERROW_HOURS=12 ./scripts/dns-queue-stability-check.sh
#
# Required env vars (same as platform-diagnostics.sh):
#   AVERROW_INTERNAL_SECRET  — internal-secret on the trust-radar Worker
#   AVERROW_API_URL          — (optional) defaults to https://averrow.com
#
# Exit codes:
#   0  GREEN  — all five signals healthy; safe to ship PR-4 / cleanup verified
#   1  YELLOW — at least one signal warns (degraded but not broken)
#   2  RED    — at least one signal failed; revert/hold

set -euo pipefail

HOURS="${1:-${AVERROW_HOURS:-24}}"
API_URL="${AVERROW_API_URL:-https://averrow.com}"
SECRET="${AVERROW_INTERNAL_SECRET:-}"

if [ -z "$SECRET" ]; then
  echo "Error: AVERROW_INTERNAL_SECRET is not set." >&2
  exit 1
fi

ENDPOINT="${API_URL}/api/internal/platform-diagnostics?hours=${HOURS}"
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

HTTP_CODE=$(curl -s -o "$TMP" -w "%{http_code}" \
  -H "Authorization: Bearer ${SECRET}" \
  "${ENDPOINT}" 2>/dev/null)

if [ "$HTTP_CODE" != "200" ]; then
  echo "Error: HTTP ${HTTP_CODE} from ${ENDPOINT}" >&2
  cat "$TMP" >&2
  exit 2
fi

# All signals are computed in the Worker — this is pure formatting.
exec python3 - "$TMP" "$HOURS" <<'PY'
import json, sys

resp = json.load(open(sys.argv[1]))
hours = sys.argv[2]
d = resp.get("data", {})
gen = d.get("_meta", {}).get("generated_at", "?")

# Signal sources
parity     = d.get("enrichment_pipeline", {}).get("dns_queue_parity") or {}
stability  = d.get("dns_queue_stability") or {}
alerts     = d.get("recent_platform_alerts", {}).get("items", []) or []
top_q      = d.get("d1_top_queries_24h") or []
recent_win = d.get("d1_recent_window", {})

src      = stability.get("source_counts",  {}) or {}
tp       = stability.get("throughput",     {}) or {}
recon    = stability.get("reconciler",     {}) or {}

# Verdict accumulator
verdicts = []  # list of (label, "GREEN"|"YELLOW"|"RED", message)

def note(label, color, msg):
    verdicts.append((label, color, msg))

# ── Signal 1: source=queue everywhere ────────────────────────────
total = src.get("total", 0) or 0
queue = src.get("queue", 0) or 0
threats = src.get("threats", 0) or 0
if total == 0:
    note("1. Read source", "YELLOW",
         f"no dns-backfill diagnostics in last {hours}h — has Navigator run?")
elif threats > 0:
    note("1. Read source", "RED",
         f"{threats}/{total} ticks still source=threats — binding regressed on some deploys")
elif queue == total:
    note("1. Read source", "GREEN",
         f"{queue}/{total} ticks source=queue (100%)")
else:
    note("1. Read source", "YELLOW",
         f"{queue}/{total} source=queue, {total - queue - threats} unparsed")

# ── Signal 2: throughput parity ──────────────────────────────────
ap = tp.get("avg_processed")
ar = tp.get("avg_resolved")
ad = tp.get("avg_dead")
am = tp.get("avg_duration_ms")
if not any([ap, ar, am]):
    note("2. Throughput",   "YELLOW", "no throughput stats available")
else:
    ap_v = ap or 0
    ar_v = ar or 0
    am_v = am or 0
    # Heuristics: pre-flip baseline ~150 processed, ~10-50 resolved,
    # ~7-9s duration. Red if anything looks catastrophically off.
    issues = []
    if ap_v < 20:
        issues.append(f"avg_processed={ap_v:.1f} (<20: pipeline barely running)")
    if am_v > 15000:
        issues.append(f"avg_duration={am_v:.0f}ms (>15s: contention or backpressure)")
    if issues:
        note("2. Throughput", "RED",  "; ".join(issues))
    else:
        note("2. Throughput", "GREEN",
             f"avg_processed={ap_v:.1f}  avg_resolved={ar_v:.1f}  avg_dead={ad or 0:.1f}  avg_duration={am_v:.0f}ms")

# ── Signal 3: notifications ──────────────────────────────────────
dns_alerts = [a for a in alerts if a.get("type", "").startswith("platform_dns_queue_")]
if not dns_alerts:
    note("3. Notifications", "GREEN",
         f"0 platform_dns_queue_drift / 0 platform_dns_queue_stalled in last {hours}h")
else:
    by_type = {}
    for a in dns_alerts:
        by_type[a.get("type", "?")] = by_type.get(a.get("type", "?"), 0) + 1
    breakdown = ", ".join(f"{k}={v}" for k, v in by_type.items())
    note("3. Notifications", "RED", f"{len(dns_alerts)} fired ({breakdown})")

# ── Signal 4: reconciler health ──────────────────────────────────
runs        = recon.get("runs", 0) or 0
fail_runs   = recon.get("runs_with_failures", 0) or 0
total_fails = recon.get("total_batch_failures", 0) or 0
avg_delta   = recon.get("avg_delta")
if runs == 0:
    note("4. Reconciler",    "YELLOW",
         f"no reconciler runs in last {hours}h — binding unset or Navigator silent?")
elif fail_runs > 0:
    note("4. Reconciler",    "RED",
         f"{fail_runs}/{runs} runs had batch failures (total={total_fails}); reconciler is degraded")
else:
    parity_str = ""
    if avg_delta is not None:
        ad_v = abs(avg_delta)
        if ad_v > 500:
            note("4. Reconciler", "YELLOW",
                 f"{runs} runs, 0 failures, but avg|delta|={ad_v:.1f} (>500: parity drift)")
            parity_str = None
        else:
            parity_str = f", avg delta={avg_delta:.1f}"
    if parity_str is not None:
        note("4. Reconciler", "GREEN",
             f"{runs} runs, 0 batch failures{parity_str}")

# ── Signal 5: main DB budget ─────────────────────────────────────
# Main trust-radar-v2 has uuid prefix 'a3776a5f'. Anything else is
# a side DB and irrelevant to this signal.
MAIN_DB_PREFIX = "a3776a5f"
main_db = next(
    (db for db in (recent_win.get("per_database") or [])
     if (db.get("database_id") or "").startswith(MAIN_DB_PREFIX)),
    None
)
# dns-backfill family text patterns. The strict-index SELECT/UPDATE
# UPDATE attempts++/dead are all from threats now-redundant path.
def is_dns_backfill_query(q):
    s = (q.get("query_sample") or "").lower()
    if "from threats" not in s:
        return False
    if "idx_threats_dns_pending_strict" in s:
        return True
    if "attempted_resolve_at" in s and "malicious_domain" in s:
        return True
    if "select distinct malicious_domain" in s and "ip_address is null" in s:
        return True
    return False

dns_family_on_main = [
    q for q in top_q
    if (q.get("database_id") or "").startswith(MAIN_DB_PREFIX)
    and is_dns_backfill_query(q)
]

if main_db is None:
    note("5. Main-DB budget", "YELLOW",
         "main DB metrics unavailable (CF Analytics setup_required?)")
else:
    rows_read = main_db.get("rows_read", 0) or 0
    extra = []
    if dns_family_on_main:
        total_dns_reads = sum(q.get("rows_read", 0) for q in dns_family_on_main)
        extra.append(f"{len(dns_family_on_main)} dns-backfill queries still on main DB ({total_dns_reads:,} reads)")
    if rows_read > 2_000_000_000:
        extra.append(f"main DB rows_read={rows_read:,} (>2B in {hours}h — over budget)")
    if extra:
        note("5. Main-DB budget", "YELLOW", "; ".join(extra))
    else:
        note("5. Main-DB budget", "GREEN",
             f"main DB rows_read={rows_read:,} in {hours}h; "
             f"{len(dns_family_on_main)} dns-backfill queries in top-N (target: 0)")

# ── Render output ────────────────────────────────────────────────
COLORS = {
    "GREEN":  ("\033[32m", "✓"),
    "YELLOW": ("\033[33m", "⚠"),
    "RED":    ("\033[31m", "✗"),
}
RESET = "\033[0m"

print()
print(f"\033[1m=== DNS-queue split stability check ({hours}h window) ===\033[0m")
print(f"Generated:   {gen}")
if parity:
    print(f"Queue size:  {parity.get('queue_size', '?')}   "
          f"Drainable:  {parity.get('drainable_in_threats', '?')}   "
          f"Delta:  {parity.get('delta', '?')}")
print()

rank = {"GREEN": 0, "YELLOW": 1, "RED": 2}
worst = "GREEN"
for label, color, msg in verdicts:
    code, glyph = COLORS[color]
    print(f"  {code}{glyph} {color:6}{RESET}  {label:24}  {msg}")
    if rank[color] > rank[worst]:
        worst = color

print()
if worst == "GREEN":
    print(f"\033[1;32m=== VERDICT: GREEN → safe to ship PR-4 ===\033[0m")
    sys.exit(0)
elif worst == "YELLOW":
    print(f"\033[1;33m=== VERDICT: YELLOW → investigate before shipping PR-4 ===\033[0m")
    sys.exit(1)
else:
    print(f"\033[1;31m=== VERDICT: RED → do not ship PR-4; revert/hold ===\033[0m")
    sys.exit(2)
PY
