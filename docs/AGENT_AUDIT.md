# Agent Audit — Phase 1

**Status:** Phase 2 + Phase 3 ✅ done · Phase 4 + Phase 5 in progress
**Original audit date:** 2026-04-29
**Last refresh:** 2026-05-09
**Window:** 7 days (run stats), 24 hours (AI cost) — original snapshot
**Standard:** see [`AGENT_STANDARD.md`](./AGENT_STANDARD.md)

The first concrete read of the platform's agent mesh against the Phase
0 standard. For each agent: what it does, run signal, cost signal,
compliance state, verdict.

This audit is read-only. Phases 2-5 act on the verdicts.

---

## Status check — 2026-05-09 refresh

The 2026-04-29 audit drove a sequence of cleanup PRs across 2026-04
and 2026-05. Current state vs. the original §8 plan:

| Phase | Original estimate | Status |
|---|---|---|
| Phase 2 — structural compliance (5-7 PRs) | ~2 sessions | **✅ Complete.** All 4 hidden agents (`seed_strategist`, `cube_healer`, `navigator`, `enricher`) registered in `agentModules`. `architect` retired with proper retirement comment + source kept per `AGENT_STANDARD §20.1`. `pathfinder` cron demoted (`docs/v3/PATHFINDER_CRON_DECISION.md`). `curator` + `watchdog` kept after addendum review. |
| Phase 3 — sync agent migration (8-10 PRs) | ~1 week | **✅ Complete for the original 15.** All agents listed in §5 are now first-class entries in `agentModules` (`public_trust_check`, `qualified_report`, `brand_analysis`, `brand_report`, `brand_deep_scan`, `honeypot_generator`, `brand_enricher`, `lookalike_scanner`, `admin_classify`, `url_scan`, `scan_report`, `social_ai_assessor`, `geo_campaign_assessment`, `evidence_assembler`, plus the extracted `attributor`). `news_watcher` shipped post-audit and is also registered. |
| Phase 4 — guardrails retrofit (5-6 PRs) | ~3 sessions | **🟡 In progress.** Resource declarations, output schemas, per-agent budgets, and tests still ✗ across the matrix. No agent has Zod output validation yet. Largest remaining item from §6.7. |
| Phase 5 — platform features (4-5 PRs) | ~3 sessions | **🟡 In progress.** Approval workflow UI exists (`features/agents/AgentApprovals.tsx`). Per-agent budget enforcement still pending §11. The "Agent config UI uplift" sub-item is now partially shipping via `/agents-v3` (live behind `VersionToggle('agents')`) — see iteration history in PRs #1163, #1164, #1165. |

**Per-agent fact sheets in §3-§4 below preserve the 2026-04-29
snapshot intentionally** — they remain useful as a "what did the
mesh look like before cleanup" record. Re-running diagnostics for
fresh numbers is a separate task (ping the `/api/internal/platform-diagnostics?hours=168`
endpoint and update those tables in a follow-on refresh).

---

## Headline findings

1. **One dead agent** — `architect` has not run in 18 days. Status `error`. Decommission candidate.
2. **Three low-yield agents** — `curator`, `watchdog`, `pathfinder` — each running ~1 job/24h with very few records produced. Triage required, possible consolidation.
3. **Cost is concentrated** — `cartographer` is 84% of all AI spend ($5.58 / $6.65 daily total). Justified by volume (78 runs/24h × ~50 enrichments/run) but worth a per-call cost review.
4. **Two agents have failure patterns FC isn't catching** — `social_monitor` (14 partial / 14 killed of 19 runs) and `flight_control` itself (14 partial / 14 killed of 50 runs). High-priority investigation.
5. **Three structural compliance gaps** carried over from Phase 0 — `seed_strategist` not in registry, `cube_healer` and `navigator` bypass the runner pattern, `enricher` writes to a different table.
6. **15 inline AI call-sites** still need to migrate to formal sync agents per the standard.
7. **No agent has output schema validation today.** All AI output is persisted unchecked. Largest hallucination exposure.
8. **No agent has a per-agent budget.** Platform-wide cost guard only.

---

## Table of contents

1. [Methodology](#1-methodology)
2. [Decommission verdicts](#2-decommission-verdicts)
3. [Per-agent fact sheets — registered agents](#3-fact-sheets-registered)
4. [Per-agent fact sheets — hidden agents](#4-fact-sheets-hidden)
5. [Sync agent migration candidates (15)](#5-sync-candidates)
6. [Cross-cutting findings](#6-cross-cutting)
7. [Compliance against AGENT_STANDARD.md](#7-compliance)
8. [Prioritised action list (Phases 2-5)](#8-actions)

---

<a id="1-methodology"></a>
## 1. Methodology

- Run stats from `/api/internal/platform-diagnostics?hours=168` (7 days)
- 24h AI spend from the same endpoint's `ai_spend_24h` block
- Per-agent status from `/api/agents`
- Resource access patterns from static read of agent source files
- Compliance verdicts mapped against [`AGENT_STANDARD.md`](./AGENT_STANDARD.md)

Run-quality spot-check (manual eyeball of recent `agent_outputs.summary` for hallucination + value) is **deferred** to Phase 2. This audit's verdicts are based on structural and operational signals only — output content review needs separate tooling.

---

<a id="2-decommission-verdicts"></a>
## 2. Decommission verdicts

| Agent | Verdict | Confidence | Reason |
|---|---|---|---|
| `architect` | **Decommission** | High | Dead — last run 2026-04-11 (18d ago), status `error`, never had a meaningful run cadence. Meta-agent designed to audit other agents but the architect_bundles R2 bucket is empty. |
| `curator` | **Investigate, lean retire** | Medium | 8 runs / 7d, 3 records processed total. Vague mandate ("platform hygiene"). Cannot point at a single user-visible outcome it produced. |
| `watchdog` | **Consolidate into Flight Control** | Medium | 9 runs / 7d, 26 records. FC's stall-recovery loop overlaps with watchdog's stale-run detection. Worth a deeper inventory pass before retirement, but the smell is strong. |
| `pathfinder` | **Keep, demote to manual trigger** | Medium | 1 run/24h, 0 records produced. Sales-leads workload is tangential to threat intel. Don't kill it — it has explicit ROI when it does fire — but stop the weekly cron and let admins trigger on demand. |
| `narrator` | Keep | High | 8 runs/7d, 0 records, but `narrator` produces `agent_outputs` (briefings) rather than processed records. The 0 in `records_processed` is a metric mismatch, not an output gap. |
| All others | Keep | High | Active, doing work, run signal matches expected cadence. |

### Total impact of decommissioning the 4 candidates

- **Code surface removed:** 4 agent modules, 4 metadata entries, 4 icons, 4 group memberships, 4 STALL_THRESHOLDS rows.
- **Cost saved:** ~$0.07/24h ≈ $2.10/month. Negligible.
- **Operational complexity removed:** 4 less things to monitor, debug, document. **This is the real win.**

The cost savings are tiny. The signal-to-noise improvement on the Agents page and in alerting is the actual value.

---

<a id="3-fact-sheets-registered"></a>
## 3. Per-agent fact sheets — registered agents (18)

Format: 1 row per agent with the operational signals that matter for the verdict. Sorted by run volume (descending).

### Detection & Surveillance

| Agent | 7d runs | success / partial / killed | records | avg ms | 24h $ | Verdict |
|---|---:|---:|---:|---:|---:|---|
| **sentinel** | 31 | 31 / 0 / 0 | 1,550 | 85,712 | $0.78 | ✅ healthy. ~50 records/run, success-only, $0.78/24h proportional to volume. |
| **cartographer** | 98 | 95 / 3 / 3 | 4,750 | 291,278 | $5.58 | ✅ healthy but **biggest spender**. Cost-per-call review recommended. P50 latency at ~5min — Workflow path explains this. 3 killed runs / 7d worth investigating. |
| **analyst** | 48 | 48 / 0 / 0 | 1,440 | 62,532 | $0.58 | ✅ healthy. No partials, ~30 records/run. |
| **nexus** | 3 | 2 / 1 / 1 | 4,763 | 35,232 | $0 | ⚠️ runs every 4h via Workflow. 1 killed run is concerning given the small total. Needs a quality spot-check on the output (correlation findings). |
| **navigator** | 577 | 551 / 26 / 0 | 6,833 | 4,169 | $0 | ✅ healthy. 26 partials acceptable for high-frequency agent. **Hidden agent** — bypasses runner pattern (Phase 2 fix). |
| **social_discovery** | 5 | 5 / 0 / 0 | 50 | 11,182 | $0 | ✅ healthy at low volume. |
| **social_monitor** | 19 | 5 / 14 / **14** | 50 | 156,101 | $0 | ❌ **failing pattern**. 14 of 19 runs partial AND 14 killed (some overlap). Either timing out or hitting a consistent error. **High-priority investigation**. |
| **app_store_monitor** | 11 | 11 / 0 / 0 | 0 | 110,842 | $0.03 | ⚠️ healthy run signal but `records_processed: 0`. Either it's filtering everything or the metric is wrong. Output check needed. |
| **dark_web_monitor** | 11 | 11 / 0 / 0 | 0 | 17,180 | $0 | Same shape as `app_store_monitor` — clean run signal, no records. |
| **auto_seeder (Recon)** | 1 | 1 / 0 / 0 | 2 | 0 | $0 | ✅ first weekly run completed (post-merge of #877). Avg ms = 0 because placeholder body returned instantly. Real body merged but hasn't fired yet. |

### Intelligence & Analysis

| Agent | 7d runs | success / partial / killed | records | avg ms | 24h $ | Verdict |
|---|---:|---:|---:|---:|---:|---|
| **observer** | 7 | 7 / 0 / 0 | 6 | 15,485 | $0.05 | ✅ healthy. Daily briefings. 6 records over 7d = 0.86/day = roughly aligned with daily cadence. |
| **strategist** | 12 | 12 / 0 / 0 | 80 | 14,429 | $0.04 | ✅ healthy. Every-6h cadence, ~7 records/run. |
| **narrator** | 8 | 8 / 0 / 0 | 0 | 324 | $0 | ✅ healthy but **subtle metric problem** — 324ms avg, 0 records. Either narrator is no-oping daily, or its work writes to `agent_outputs` (briefings) without incrementing `records_processed`. Confirm in Phase 2. |

### Response

| Agent | 7d runs | success / partial / killed | records | avg ms | 24h $ | Verdict |
|---|---:|---:|---:|---:|---:|---|
| **sparrow** | 8 | 8 / 0 / 0 | 32 | 37,983 | $0 | ✅ healthy. ~4 takedown ops/run. Should be a candidate for `requiresApproval: true` per-run gate (§12.2 of standard). |

### Operations

| Agent | 7d runs | success / partial / killed | records | avg ms | 24h $ | Verdict |
|---|---:|---:|---:|---:|---:|---|
| **flight_control** | 50 | 36 / **14** / **14** | 18.2M | 135,658 | $0 | ⚠️ **concerning**. 14 partial + 14 killed of 50 runs (28% / 28%). FC supervises the mesh — its own failure rate dampens supervision quality. 18M "records processed" is the count of mesh observations, not real work. Investigate the kill pattern. |
| **curator** | 8 | 8 / 0 / 0 | 3 | 36,467 | $0 | ❌ low yield. **Decommission candidate** (§2). |
| **watchdog** | 9 | 9 / 0 / 0 | 26 | 6,888 | $0.03 | ❌ low yield. Overlaps with FC. **Consolidate into FC** (§2). |
| **pathfinder** | 8 | 8 / 0 / 0 | 0 | 315 | $0 | ❌ no records, 315ms = noop. **Demote to manual trigger** (§2). |
| **cube_healer** | 8 | 8 / 0 / 0 | 325,440 | 2,675 | $0 | ✅ healthy. Massive record count is expected (30-day cube rebuild). **Hidden agent** — bypasses runner pattern (Phase 2 fix). |

### Meta

| Agent | 7d runs | success / partial / killed | records | avg ms | 24h $ | Verdict |
|---|---:|---:|---:|---:|---:|---|
<a id="4-fact-sheets-hidden"></a>
## 4. Per-agent fact sheets — hidden agents (4)

The four agents found in Phase 0's preflight that don't fit the `agentModules`-registered + `executeAgent`-dispatched pattern. All four MUST become standard-compliant in Phase 2.

| Agent | What | Why it's hidden | Fix |
|---|---|---|---|
| **seed_strategist** | AI-driven daily seeding strategy planning. Generates campaign recommendations + auto-creates seed_addresses. | Has a proper `AgentModule` but **missing from `agentModules` registry**. Dispatched manually from `runObserverBriefing()`. FC's stall-recovery loop is blind to it — if observer briefing skips a tick, seed_strategist dies silently. | Phase 2 — register in `agentModules`. One-line fix. |
| **cube_healer** | 30-day OLAP cube rebuild every 6h. | Dedicated cron (`12 */6 * * *`), writes `agent_runs` directly via raw INSERT. No `AgentModule`. UI metadata exists. | Phase 2 — wrap in `AgentModule` + use `executeAgent()`. Keep the dedicated cron. |
| **navigator** (`fast_tick`) | DNS resolution, OLAP cube refresh, KV cache pre-warming. | Dedicated cron (`*/5 * * * *`), writes `agent_runs` directly. No `AgentModule`. Documented as intentional in CLAUDE.md but still bypasses the standard. | Phase 2 — wrap in `AgentModule`. Keep the dedicated cron. |
| **enricher** | Domain geo, brand logo/HQ, RDAP enrichment. Runs every hourly tick. | **Truly hidden** — writes to `agent_activity_log` (a *different* table), `agent_id='enricher'`. Doesn't appear on the Agents page or in `agent_runs` queries. | Phase 2 — pick: either migrate to `agent_runs` or document why `agent_activity_log` is its home. Either way, surface it on the Agents page. |

The `cube_healer` and `navigator` cases are particularly worth addressing because they're the precedent — without fixing them, future agents will keep getting the "I'll just write directly to agent_runs" treatment.

---

<a id="5-sync-candidates"></a>
## 5. Sync agent migration candidates (15)

The 15 inline AI call-sites in `handlers/*` and `lib/*` that should become formal sync agents per the standard's §2.

Each row: which file, what user-facing functionality it powers, model used, and migration risk.

| `agentId` (from budget_ledger) | Where it lives | Powers | Model | Risk |
|---|---|---|---|---|
| `admin-classify` | `handlers/admin.ts` | Admin manual threat classification UI | Haiku | Low |
| `ai-attribution` | `agents/cartographer.ts` | Brand attribution for unlinked threats (sub-call) | Haiku | Medium — already inside an agent, may just need extracting |
| `brand-analysis` | `handlers/brands.ts` | Brand detail page AI summary | Haiku | Medium — high traffic |
| `brand-deep-scan` | `handlers/admin.ts` | Admin "deep scan" of a brand | Sonnet | Medium |
| `brand-enricher` | `lib/brand-enricher.ts` | Brand metadata enrichment (logo, HQ, sector) | Haiku | Low — already library-shaped |
| `brand-report` | `handlers/admin.ts` | Per-brand AI report PDF generation | Sonnet | Low |
| `evidence-assembler` | `handlers/qualifiedReports.ts` | Evidence package generation for qualified reports | Sonnet | Medium — customer-facing |
| `geo-campaign-assessment` | `agents/observer.ts`-adjacent | Geopolitical campaign attribution | Haiku | Low |
| `honeypot-generator` | `honeypot-generator.ts` | Generates fake business sites for trap domains | Haiku | Low |
| `lookalike-scanner` | `scanners/lookalike-domains.ts` | AI scoring of typosquat candidates | Haiku | Low |
| `public-trust-check` | `handlers/public.ts` | Anonymous homepage `POST /api/v1/public/assess` | Haiku | **High — anonymous user input, prompt-injection vector**. First migration target. |
| `qualified-report` | `handlers/qualifiedReports.ts` | Customer-facing qualified report content | Sonnet | High — customer-facing |
| `scan-report` | `handlers/scans.ts` | One-shot scan report | Haiku | Medium |
| `social-ai-assessor` | `scanners/social-monitor.ts` | Social profile classification | Haiku | Medium |
| `url-scan` | `handlers/admin.ts` | Admin manual URL scan | Haiku | Low |

**Phase 3 ordering recommendation:**
1. `public-trust-check` first — highest blast-radius (anonymous input). Establishes the prompt-injection defense pattern.
2. `evidence-assembler` + `qualified-report` next — customer-facing, both deserve schema validation.
3. `brand-report`, `brand-deep-scan`, `brand-analysis` — admin/internal but frequent.
4. `honeypot-generator`, `brand-enricher`, `lookalike-scanner` — already library-shaped, low risk.
5. The rest (`admin-classify`, `url-scan`, `scan-report`, `social-ai-assessor`, `geo-campaign-assessment`) — low traffic, batch them in 2-3 PRs.

Total: **8-10 PRs over a week** (matches Phase 3 estimate in standard §23).

---

<a id="6-cross-cutting"></a>
## 6. Cross-cutting findings

### 6.1 Cost concentration

```
cartographer:  $5.585  (84.0%)
sentinel:      $0.779  (11.7%)
analyst:       $0.577  ( 8.7%)
all others:    $0.21   ( 3.2%)
─────────────────────────────
total:         $6.65 / 24h ≈ $200/month
```

Cartographer dominates because it makes per-threat `ai-attribution` calls. The sub-call extraction (Phase 3) is the right structural fix; the volume itself is justified.

### 6.2 Failure-pattern outliers

Two agents have a "lots of partial / killed runs" pattern that doesn't surface as `failed` (which would trip the circuit breaker):

- **`social_monitor`**: 14 partial AND 14 killed of 19 runs. 73% partial rate. Either the social_monitor → external-API path is timing out, or the run is hitting an internal error and the agent recovers gracefully but reports partial. Investigate before Phase 2.
- **`flight_control`**: 14 partial + 14 killed of 50. FC failing at 28% rate is structurally bad — it's the supervisor. Spot-check: are these kills happening at specific hours (cron CPU contention) or distributed?

### 6.3 Records-processed metric is unreliable

Multiple agents show `records_processed: 0` despite clearly doing work:
- `app_store_monitor`, `dark_web_monitor` — likely scanning but filtering everything as "no match"
- `narrator` — produces `agent_outputs` (briefings) but doesn't count those as records
- `pathfinder` — declared no-op recently?

The `records_processed` field is overloaded. Phase 4 should audit each agent's definition of "record" and either standardize or split into `inputs_examined` vs `outputs_emitted`.

### 6.4 Spam-trap subsystem is over-fragmented

Three agents touch spam-trap data: `seed_strategist` (planning), `auto_seeder` (Recon, planting), and the `spam_trap` email handler (capture). Plus the dark-web/app-store monitors which are conceptually "trap"-shaped.

Worth considering for Phase 5: a "Trap Mesh" supervisor that owns the planning → planting → capture → analysis loop end-to-end, vs. having each piece dispatched independently.

### 6.5 Architect's failure mode

`architect` is a meta-agent designed to audit other agents. It's been dead for 18 days. Two readings:

1. The audit was never useful enough to be missed — confirmation it should be retired.
2. The audit IS useful but the agent shipped broken — we need it back, refactored.

Reading the source: `architect` writes its findings as `agent_outputs` of type `diagnostic`. Querying for these in the last 30 days returns 0 rows. **Reading 1 is correct — retire.**

### 6.6 Single-FC scaling

Today one Flight Control supervises all agents. With 19 in the registry + 4 hidden + 15 sync candidates incoming, FC will supervise ~38 agents post-Phase 3. Per-agent budgets (standard §11) make this less critical because each agent caps its own spend, but the coordination overhead grows.

**Phase 5 verdict (preliminary):** keep single FC. The coordination work scales linearly with agent count and CPU is not the bottleneck. Domain-split FCs add cross-FC handoff complexity that isn't justified at this size.

---

<a id="7-compliance"></a>
## 7. Compliance against AGENT_STANDARD.md

Per-agent compliance against the standard's 12-point wiring checklist + the §6-§12 contract requirements. ✓ = compliant, ✗ = missing, ~ = partial.

| Agent | In registry | Has metadata | Has icon | In a group | Stall thresh | Resource decls | Output schemas | Per-agent budget | Approval gate | Tests |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| sentinel | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | n/a | ✗ |
| analyst | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | n/a | ✗ |
| cartographer | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | n/a | ~ |
| nexus | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | n/a | ✗ |
| navigator | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | n/a | ✗ |
| social_discovery | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | n/a | ✗ |
| social_monitor | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | n/a | ✗ |
| app_store_monitor | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | n/a | ✗ |
| dark_web_monitor | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | n/a | ✗ |
| auto_seeder (Recon) | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | n/a | ✗ |
| observer | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | n/a | ✗ |
| strategist | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | n/a | ✗ |
| narrator | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | n/a | ✗ |
| sparrow | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | **needs** | ✗ |
| flight_control | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | n/a | exempt | n/a | ✗ |
| curator | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | n/a | ✗ |
| watchdog | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | n/a | ✗ |
| pathfinder | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | n/a | ✗ |
| cube_healer | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | n/a | exempt | n/a | ✗ |
| architect | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | n/a | ✗ |
| seed_strategist | ✗ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ | n/a | ✗ |
| enricher | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | n/a | exempt | n/a | ✗ |

**Summary**: every agent fails the standard on resource declarations, output schemas, per-agent budgets, and tests. This is expected — the standard was just written. The audit's purpose is to size the gap, which is **structural compliance for 18 + uplift for 4 hidden agents + add the new contract requirements (resource decls, output schemas, per-agent budgets) for everyone**.

The compliance work splits naturally across Phases 2-4:

- **Phase 2** lights up the `In registry / Has metadata / Has icon / In a group / Stall thresh` columns for hidden agents (4 fixes).
- **Phase 3** introduces the sync agent class + 15 new agents that comply with the new requirements from day one — and migrates existing agents' AI calls to use the same helpers.
- **Phase 4** retrofits resource declarations, output schemas, per-agent budgets, and tests onto the existing 18 agents.

---

<a id="8-actions"></a>
## 8. Prioritised action list (Phases 2-5)

Ranked by impact ÷ effort. Each is a small PR.

### Phase 2 — structural compliance ✅ DONE (2026-05-09)

1. ✅ **Register `seed_strategist` in `agentModules`** — done. Closes the defect where FC was blind to it.
2. ✅ **Decommission `architect`** — removed from `agentModules`, source retained per `AGENT_STANDARD §20.1` (registry comment documents the retirement).
3. ✅ **Migrate `cube_healer` to `AgentModule`** — wrapped + registered. Dedicated cron preserved.
4. ✅ **Migrate `navigator` to `AgentModule`** — wrapped + registered. Same pattern as cube_healer.
5. ✅ **Surface `enricher`** — registered in `agentModules`, surfaced on the Agents page.
6. ✅ **Demote `pathfinder` to manual trigger** — done. See `docs/v3/PATHFINDER_CRON_DECISION.md` for the operator-decision context.
7. ✅ **Investigate `curator` and `watchdog`** — both KEPT after code-level review reversed the lean-retire verdicts. See changelog 2026-04-29 (later) for the addendum that corrected the misclassifications. Metadata subtitles updated.

### Phase 3 — sync agent migration ✅ DONE for original 15 (2026-05-09)

All 15 sync agents called out in §5 are now first-class `agentModules` entries:
`public_trust_check`, `qualified_report`, `brand_analysis`, `brand_report`,
`brand_deep_scan`, `honeypot_generator`, `brand_enricher`, `lookalike_scanner`,
`admin_classify`, `url_scan`, `scan_report`, `social_ai_assessor`,
`geo_campaign_assessment`, `evidence_assembler`, plus the extracted `attributor`.

`news_watcher` shipped post-audit and is also registered. Phase 3 ordering
recommendation in §5 was followed — `public_trust_check` landed first,
establishing the `runSyncAgent()` pattern + prompt-injection defense.

### Phase 4 — guardrails retrofit (5-6 PRs, ~3 sessions)

For each existing agent, add:
- `reads` + `writes` resource declarations
- `outputSchema` (Zod) for every output type
- `budget` block with monthly token cap + alert threshold
- Three-test coverage (unit + integration + snapshot)

The architect manifest's static-analysis gives us auto-population for `reads`/`writes` — we get that for free.

### Phase 5 — platform features (4-5 PRs, ~3 sessions)

- Approval workflow UI (deployment review screen) — §12.1 of standard.
- Per-run approval inline notification — §12.2.
- Per-agent budget enforcement (pre-flight check) — §11.
- `pnpm new-agent` scaffolder — §21.
- `audit-agent-standard.ts` enforcement script + CI gate — §22.
- **Agent config UI uplift** (post-audit follow-up). Surface the audit's findings directly in the Agents admin/config screens so the operator sees compliance state, run signal, cost trend, decommission verdicts, and the `reads`/`writes` resource graph inline — not in a markdown file. Specifically:
  - **Compliance badges** on each agent card (✓ resource decls / ✓ output schema / ✓ per-agent budget) so non-compliant agents are immediately visible.
  - **Cost trend sparkline** + monthly-to-cap gauge on each card (fed from the per-agent budget block).
  - **Run signal panel** in the detail view: 7d run history, p50/p99 latency, partial/killed rate. The data is already in `agent_runs` — needs surfacing.
  - **Decommission warning banner** when an agent matches a heuristic (no successful run in 30d, 0 records over 14d, etc.) — earlier signal than the once-per-quarter audit.
  - **Resource graph** chip set for declared `reads`/`writes`, click-through to the audit doc's row for context.
  - **Output preview** carousel showing the last 5 `agent_outputs.summary` rows so the operator can spot-check quality without needing a separate tool. (Closes the "Output content review" gap deferred from this audit.)
  - **Failure-pattern alert** when partial-rate or kill-rate exceeds the §16 SLO. Mostly addresses the social_monitor + flight_control cases flagged in §6.2.

**🟡 In progress (2026-05-09):** the Agent config UI uplift is shipping
behind a `VersionToggle('agents')` at `/agents-v3`. Three iterations
landed (PRs #1163, #1164, #1165):

- **iter 1** (#1163) — toggle infrastructure (generic `useVersionToggle`
  + `VersionToggle` component) + `/agents-v3` shell
- **iter 2** (#1164) — failure-pattern badge (derived from existing
  Agent payload), 24h activity sparkline, click-to-expand detail panel
  with output preview + 7d health
- **iter 3** (#1165) — Flight Control rendered as a SUPERVISOR section
  at top, workers grouped by `AGENT_METADATA.category`, ← upstream / →
  downstream connectivity chips on every card, real compliance signals
  (2/4 honest), Network View placeholder footer

**Still pending behind the toggle:**
- Per-agent cost gauge — needs §11 budget block
- Resource-graph chip set — needs §22 static-analysis manifest
- Compliance Schemas + Budget chips — flip to ✓ when Phase 4 ships
- Interactive Network View visualisation (placeholder card live; impl pending)

### Total estimate

- 22-29 PRs across Phases 2-5
- 2-3 weeks of focused work
- No big-bang: each PR is small, reversible, ships behind existing test gates.

---

## Open questions surfaced by this audit

1. **Quality spot-check tool** — Phase 2 should land a small admin endpoint that returns the last N `agent_outputs` for a given agent so output review isn't a SQL-archeology exercise.
2. **`flight_control` failure pattern** — 28% kill rate worth a Phase 2 sub-task before we add more agents to its supervision load.
3. **`social_monitor` failure pattern** — 73% partial rate is high enough to gate Phase 4's "add output schemas" work on this agent.
4. **`enricher`'s home table** — does the `agent_activity_log` pattern have any benefit over `agent_runs`? If not, Phase 2 should converge it.
5. **Records-processed metric** — Phase 4 standardize? Or accept that some agents emit outputs (briefings) and others process records (threats), and rename the field in agents/index UI.

---

## Changelog

- 2026-04-29: Initial draft, Phase 1 audit. Per-agent fact sheets, decommission verdicts, compliance matrix, action list.
- 2026-04-29 (later): **Phase 2.7 verdict-reversal addendum.** Triage of `curator` and `watchdog` reversed their lean-retire verdicts after a code-level review:
  - **curator** — the audit's "vague mandate" assessment was wrong. The agent runs three concrete jobs: email security scanning for unscanned brands, safe-domain false-positive cleanup, and social profile discovery for high-threat brands. Records-processed metric mismatch hid the work — it does scans, not threat-row INSERTs. **KEPT.** Metadata subtitle updated.
  - **watchdog** — the audit's "overlaps with FC stall-recovery" assessment was completely wrong. Watchdog has nothing to do with uptime — it's a Haiku-powered social-mention threat classifier that escalates high/critical findings to the threats table. The metadata subtitle ("Uptime Monitoring & Alert Escalation") was misleading and matched a stale role. **KEPT.** Metadata subtitle + category updated (`ops` → `intelligence`).
  - **Lesson for Phase 1 methodology**: structural signal alone (run count, records processed, descriptive metadata) was insufficient to issue retirement verdicts. Future phases should always pair the structural read with a brief code-level inspection before any `Decommission` row goes in.
- 2026-05-09: **Phase 2 + Phase 3 status refresh.** All 7 Phase 2 actions
  closed (4 hidden agents registered, architect retired, pathfinder
  demoted, curator/watchdog kept per addendum). All 15 Phase 3 sync
  agents from §5 are now first-class `agentModules` entries. Agent
  config UI uplift (Phase 5.6) shipping behind `VersionToggle('agents')`
  at `/agents-v3` — three iterations landed:
  - **#1163** — generic version-toggle infrastructure + `/agents-v3` shell
  - **#1164** — failure-pattern badge + 24h activity sparkline +
    click-to-expand detail with output preview + 7d health
  - **#1165** — Supervisor section at top + worker grouping by category
    + connectivity chips (← upstream / → downstream from
    `TRIGGER_CHAIN` constant) + real compliance signals + Network View
    placeholder footer (impl pending)

  **Per-agent fact sheets in §3-§4 deliberately preserve the
  2026-04-29 snapshot** — they're the historical record. Re-running
  diagnostics for fresh numbers is a separate task (`/api/internal/platform-diagnostics?hours=168`).

  **Still queued:** Phase 4 (resource decls + output schemas + per-agent
  budgets + tests for every agent) and the remaining Phase 5 items
  (per-run approval inline notification, per-agent budget enforcement,
  scaffolder, audit script + CI gate, interactive Network View
  visualisation).

