# Bundle F — Production Ops Investigation
**Date:** 2026-05-07
**Trigger:** UI audit (`docs/UI_AUDIT_2026-05-06.md`) flagged 4 live production issues (C5, C6, C7, C12)

---

## Summary

| Audit | Audit-state | Now-state | Action |
|---|---|---|---|
| **C5** Token budget at 315% (1.58M / 500K) | Real over-spend; guard not enforcing | Same — pre-flight token-cap enforcement is **not yet implemented** (Phase 5 architectural item per `agentRunner.ts:229` comment); $-spend is healthy at $3.92/24h ≈ $118/mo (under $150/mo target) | Documented; no fix shipped |
| **C6** Sentinel/Analyst/Cartographer DEGRADED | 3 core agents flagging partial | Cartographer 1/28 (3.6%), Sentinel 2/16 (12.5%), enricher 2/13 (15.4%); Analyst recovered. All have `last_error: <none>` — Workers killed mid-run | Documented; root cause is architectural (Worker CPU limits + initial-row partial state in `agentRunner.ts:416`); fix is a future refactor |
| **C7** 8 enrichment pipelines STALE | No measurements in last cycle | All 12 pipelines now have measurements within last 6h; **10 of 12 backlogs are GROWING** (active but falling behind on inflow) | Documented; per-pipeline throughput tuning is ongoing ops, not a one-shot fix |
| **C12** Daily briefing not sent in 36h | Real — incident auto-created 2026-05-05 02:08 UTC | Briefing pipeline healthy. Manual trigger via `/api/internal/briefing/send` returns `{ briefingId: 25, emailSent: true }`. No new `platform_briefing_silent` alerts in 48h+ | ✅ **Incident resolved** (manual transition with explanation); ✅ **FC self-monitor improved** to auto-resolve on heal |

---

## C5 detail — Token budget enforcement

The audit's "315% over budget" reading is the **UI surfacing actual usage** against the documented monthly cap. The cap itself is just a **declaration**, not yet enforced. From `agentRunner.ts:229`:

> Phase 4.2 only adds the declarations; **Phase 5 wires the pre-flight enforcement check** that reads `budget_ledger` and refuses an AI call when the agent is over `monthlyTokenCap`.

**Reality check on actual cost:**
- 24h spend: **$3.92** (3,819 calls)
- Top consumers: cartographer ($2.05, 1,380 calls), sentinel ($0.85, 729 calls), analyst ($0.63, 693 calls)
- Monthly run-rate: ~$118
- CLAUDE.md target: ~$150/mo

**Verdict:** The token-count over-spend is real but the **dollar** spend is well within budget. Wiring Phase 5 token-cap enforcement is correct future work but not urgent — the system isn't burning money, the UI is just surfacing a soft cap that isn't gated yet.

---

## C6 detail — "Partial" status semantics

Every `agent_runs` row INSERTs at `status='partial'` (`agentRunner.ts:416`). It transitions to `'success'` or `'failed'` only if execution reaches the corresponding code path. If a Cloudflare Worker is killed mid-execution (CPU time limit, unhandled rejection, eviction), the row stays at `'partial'` with `last_error: NULL`.

**Implication:** the diagnostics' DEGRADED flag doesn't distinguish:
1. **Approval-partial** (intentional — the agent produced human-review approvals)
2. **Killed mid-run** (architectural — Worker runtime ended the agent)

Current production data:
| Agent | Partial rate | Avg duration | Likely cause |
|---|---|---|---|
| brand_enricher | 0.4% (1/234) | 2.4s | benign |
| cartographer | 3.6% (1/28) | 365s wall-clock | long RDAP chains |
| enricher | 15.4% (2/13) | 206s | long batches |
| sentinel | 12.5% (2/16) | 174s | long Haiku chains |
| nexus | 100% (1/1) | 0ms | single recent run, no error |
| watchdog | 33% (1/3) | 80s | small N |

**Fix path** (deferred):
- Distinguish initial-state partial from approval-partial in the schema (e.g. add `partial_reason` enum).
- Tighten per-agent CPU bounds via Cloudflare Workflows for the long-runners (cartographer, enricher, sentinel).
- Diagnostics flags only "killed-partial" as DEGRADED, not approval-partial.

---

## C7 detail — Pipeline backlogs

Audit found 8 pipelines marked STALE (no measurement in last cycle). Current state: all 12 pipelines have recent measurements (cube-healer ran). New problem: most are GROWING.

**Backlog trends (current vs previous, hours apart):**
| Pipeline | Current | Previous | Trend | Δ% |
|---|---|---|---|---|
| seclookup | 18,463 | 17,605 | +858 | +4.9% |
| greynoise | 3,594 | 3,230 | +364 | +11.3% |
| dbl | 14,031 | 13,454 | +577 | +4.3% |
| pdns | 13,265 | 12,678 | +587 | +4.6% |
| gsb | 12,583 | 12,034 | +549 | +4.6% |
| surbl | 11,578 | 11,095 | +483 | +4.4% |
| virustotal | 11,571 | 10,910 | +661 | +6.1% |
| abuseipdb | 4,489 | 3,515 | +974 | +27.7% ⚠️ |
| analyst | 255 | 208 | +47 | +22.6% |
| domain_geo | 39,028 | 38,952 | +76 | +0.2% |
| **brand_enrich** | **6,826** | **6,850** | **−24** | **−0.4%** ✅ |
| **cartographer** | **76** | **136** | **−60** | **−44.1%** ✅ |

Eight pipelines are growing 4-6%/window (slow drift), AbuseIPDB +28% is the standout. AbuseIPDB has free-tier rate limits (1k req/day/key); inflow likely outpaces those limits.

**Fix path** (deferred):
- Per-pipeline throughput tuning (more cron frequency where rate limits allow, parallel batches where ingest is slow).
- Investigate AbuseIPDB rate-limit headroom; consider key rotation or premium tier.
- Domain_geo at 39K backlog is the absolute biggest queue — its cron is `*/5` already; investigate per-tick yield.

---

## C12 detail — Briefing pipeline (FIXED)

### What was actually broken on 2026-05-05

`flightControl.ts:713` runs an N6c self-monitor every FC tick: query `MAX(generated_at) FROM threat_briefings WHERE emailed = 1 AND generated_at >= datetime('now', '-72 hours')`. If `hoursSince >= 36`, fire `platform_briefing_silent`.

The 2026-05-05 02:08 UTC incident was real — at that moment, no successful briefing had landed in the last 36h.

### Current state

- Manual trigger `POST /api/internal/briefing/send` → `{ briefingId: 25, emailSent: true }`
- No new `platform_briefing_silent` alerts in 48h+ (FC would have re-fired if hoursSince climbed back to 36)
- Incident `f6d7b63e-…cbf93f` still in `monitoring` because nobody clicked Resolve

### Action shipped

1. **Manually transitioned** incident `f6d7b63e-…cbf93f` to `resolved` with explanatory message via `POST /api/admin/incidents/:id/transition` using the super_admin JWT.
2. **Auto-resolution improvement** in `flightControl.ts`: when `hoursSince < 36` AND an open incident with `source='auto:platform_briefing_silent'` exists, FC now appends a resolution update + transitions to resolved. Symmetric to the existing dedup-on-fire logic. Stops the platform from accumulating stale "monitoring" tickets that the underlying issue has already healed.

The same auto-resolve pattern can be extended to other auto-created incidents in future sessions (e.g., feed-paused, agent-tripped) — kept narrow to briefing here so the change is testable.

---

## What this bundle didn't fix (intentional)

- **C5** Phase 5 token-cap enforcement — large architectural change; not urgent because $-spend is healthy
- **C6** Worker-kill detection — architectural refactor of partial semantics; future session
- **C7** Per-pipeline throughput — ongoing ops work, no single fix

These remain in the audit doc as known follow-ups.
