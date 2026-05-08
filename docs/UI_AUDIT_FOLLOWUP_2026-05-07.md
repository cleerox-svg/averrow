# UI Audit follow-up — what shipped, what's deferred, what needs scoping

**Date:** 2026-05-07
**Source audit:** `docs/UI_AUDIT_2026-05-06.md`
**Bundle-F follow-ups source:** `docs/BUNDLE_F_OPS_2026-05-07.md`

This doc closes the audit punch list. Line items split into three buckets: **shipped**, **deferred to a specific later phase**, and **architectural — not one-shot fixes** (Bundle F).

---

## 1. Shipped in this PR (M-tier + L-tier)

| ID | Item | Where |
|---|---|---|
| **M3** | Cyan/blue accent on `Providers Tracked` tile dropped (no longer a severity-style accent on a non-severity stat) | `Providers.tsx:749` |
| **M5** | `formatDate(date, 'long' \| 'medium' \| 'short' \| 'iso')` + `formatDateTime()` helpers added to `lib/time.ts`. Home greeting band + Audit log relative-fallback migrated as canonical examples. Future date-rendering callsites should use these | `lib/time.ts`, `HomeHeader.tsx`, `AdminAudit.tsx` |
| **M6** | Email Security panel hierarchy — removed redundant grade letter from inline progress bar (was duplicating the StatCard header GRADE), and demoted the BIMI sub-grade from `lg` to `sm` size with a clearer "BIMI/VMC sub-grade" label so the header GRADE is the unambiguous primary signal | `BrandDetail.tsx:445-460, 495-505` |
| **L1** | Greeting copy falls back to "there" when the user's role is `service_account` — kills "Good evening, MCP" for JWT-minted internal logins | `HomeHeader.tsx:29-37` |
| **L3** | Brand-detail tabs renamed to match the v3 module taxonomy (`Apps` → `App Stores`, `Social` → `Social Media`). Pre-aligns the staff-ops view with what customers will see in `averrow-tenant` | `BrandDetail.tsx:62-72` |
| **L5** | `Manage Billing` disabled button gains a tooltip + an "Email billing@averrow.com to change plans" footer line. Removes the dead-end UX | `Organization.tsx:191-205` |

---

## 2. Already shipped in earlier sessions (verified during this audit pass)

| ID | Item | Where it landed |
|---|---|---|
| M2 | StatCard zero-state rule — `value === 0` resolves accent to `M.NEUTRAL` regardless of caller's `accentColor` prop. Kills the red-with-zero anti-pattern | `tokens.ts:23` `resolveStatAccent`, applied at `StatCard.tsx:34`. **Bundle C session 1.** |
| M9 | "10 AGO" truncation — `relativeTime()` returns `${days}d ago` (lowercase d intact) | `lib/time.ts:11`, `ThreatActorDetail.tsx:431`. **Bundle B.** |
| M7 | "No allowlist" / "No execs set" pills already use neutral grey (`white/5` bg, `white/60` text, `white/10` border) — not amber alert | `Apps.tsx:33`, `DarkWeb.tsx:34`. **Pre-existing.** |
| L2 | "Mark all read" affordance exists inside the notification bell dropdown. The bell-level header (collapsed) doesn't need a duplicate; the dropdown is the natural surface | `NotificationBell.tsx:262-267`. **Pre-existing.** |

---

## 3. Deferred — not blocking, but should be revisited

| ID | Item | Why deferred | When |
|---|---|---|---|
| **M1** | "6 different stat-tile patterns across 24 pages — should all be `StatCard`" | Mostly addressed by Bundle C's `StatCard` unification. A full sweep would touch 24+ files; the cost-benefit doesn't pencil out as a one-shot PR. Each page picks up `StatCard` as it's touched in v3 Phase B (per `eager-moseying-papert.md`) | v3 Phase B per-module work |
| **M4** | "Sparklines all-red regardless of trend direction" | `Sparkline.tsx` is in the frozen-component list (per `CLAUDE.md` §4 "Frozen components — never refactor"). Touching it requires explicit operator override — visual change to a SVG component used in multiple high-traffic surfaces | Operator-approved separate PR |
| **M8** | "Inconsistent panel-header iconography — EMAIL SECURITY has shield icon; sibling panels don't" | Brand-detail polish that should travel with the broader Brand-detail tab restructure when `averrow-tenant` collapses 8 tabs → 3 (Surface / Risk / Workflow per v3 plan §9.6) | v3 Phase B Brand-health module |
| **M10** | "Internal agent names surfaced in customer-side copy" | Was Bundle B; verified `grep` returned no remaining "SPARROW QUEUE" / "Powered by Observer" callsites in `averrow-ops/src`. Re-run when `averrow-tenant` is built — staff-side copy is fine but customer-facing copy should be screened | v3 Phase A skeleton review |
| **L4** | "em-dash placeholder used inconsistently with `0` and `N/A`" | Convention sweep across the codebase. `Brands.tsx` already uses `'—'` for empty values consistently; other pages mix. Lower priority — visual rather than functional. Would land cleanest as a tokens.ts constant (`EMPTY_PLACEHOLDER = '—'`) used everywhere | Future cosmetic sweep |

---

## 4. Bundle F C5 / C6 / C7 — architectural, NOT one-shot

The `BUNDLE_F_OPS_2026-05-07.md` doc itself flags these as deferred. Re-quoting:

> **C5** Phase 5 token-cap enforcement — large architectural change; not urgent because $-spend is healthy
> **C6** Worker-kill detection — architectural refactor of partial semantics; future session
> **C7** Per-pipeline throughput — ongoing ops work, no single fix

Each needs a project-shaped scope, not a single-PR fix.

### C5 — Pre-flight token-cap enforcement

**State:** Phase 4.2 added the `monthlyTokenCap` declarations on each agent. Phase 5 was meant to wire the **pre-flight enforcement check** that reads `budget_ledger` and refuses an AI call when the agent is over its declared cap. That wiring was never landed (see `agentRunner.ts:229` comment).

**Why not urgent:** $-spend is healthy at $3.92/24h ≈ $118/mo (under $150/mo target per `CLAUDE.md`). The 1.58M / 500K token reading the UI surfaces is a soft cap that the system isn't enforcing.

**Scope when picked up (~1-2 weeks engineering):**
1. Pre-flight check in `agentRunner.ts:229` — query `agent_budget_rollups` (already cached 60s in KV per `lib/budgetManager.ts`) for current month's token use
2. Three throttle levels (already declared: SOFT 80%, HARD 95%, EMERGENCY 99%) — wire each one to refuse-with-degrade rules
3. Surface the enforcement events in Flight Control + alerts
4. Audit the existing soft-cap declarations vs actual usage and re-tune

**Recommend:** schedule alongside v3 Phase A foundation (when usage instrumentation is being built anyway). Until then, dollar-spend monitoring is the backstop.

### C6 — Partial-state semantics refactor

**State:** Every `agent_runs` row INSERTs at `status='partial'` (`agentRunner.ts:416`). It transitions to `'success'` or `'failed'` only if execution reaches the corresponding code path. If a Cloudflare Worker is killed mid-execution (CPU time limit, unhandled rejection, eviction), the row stays at `'partial'` with `last_error: NULL`.

**Symptom:** the diagnostics' `DEGRADED` flag conflates two unrelated things — *approval-partial* (intentional: agent produced human-review approvals) and *killed-partial* (architectural: Worker runtime ended the agent). Both look the same from the outside.

**Scope when picked up (~2-3 weeks engineering):**
1. Schema: add `partial_reason` enum to `agent_runs` — `approval_required | worker_killed | cpu_timeout | unhandled_rejection`
2. Set the reason at INSERT time when known (approval_required); fall back via post-mortem heuristic (`agent_runs.completed_at IS NULL AND started_at < now()-15min`)
3. Tighten per-agent CPU bounds via Cloudflare Workflows for the long-runners (cartographer 365s wall-clock, enricher 206s, sentinel 174s — all candidates per `BUNDLE_F_OPS_2026-05-07.md` §C6)
4. Diagnostics flags only `worker_killed` / `cpu_timeout` as DEGRADED; approval-partial stays neutral
5. Backfill existing rows with `partial_reason = 'unknown'`

**Recommend:** schedule when v3 Phase B (per-module agents) lands new long-runners — easier to refactor the framework when there's an active reason to.

### C7 — Per-pipeline throughput tuning

**State:** All 12 enrichment pipelines have measurements within the last 6h. **10 of 12 backlogs are GROWING** — pipelines are active but inflow exceeds throughput. AbuseIPDB is the standout at +27.7% / window growth (free-tier rate limit: 1k req/day/key).

**Why not a one-shot fix:** every pipeline has different rate-limit characteristics (free vs paid tier, per-key vs global, daily vs hourly resets). The fix is per-pipeline tuning, not a single architectural change.

**Scope when picked up (~ongoing ops work):**
- AbuseIPDB: investigate key rotation + premium tier ($25/mo for 10k req/day — see if backlog drains at that rate)
- domain_geo at 39K backlog (largest absolute queue): cron is already `*/5`; investigate per-tick yield (how many records does each tick process? what's the bottleneck?)
- Most other pipelines: 4-6%/window growth — slow drift; tune cron frequency where rate limits allow, or parallelize batches where ingest is slow

**Recommend:** treat as ongoing ops work owned by whoever runs Flight Control. Set a recurring monthly check: run `/api/internal/platform-diagnostics?hours=168` and tune the worst-trending pipeline. No single-PR fix exists.

---

## 5. Summary table

| Bucket | Items | This PR ships? |
|---|---|---|
| Already shipped (verified) | M2, M7, M9, L2 | — (no-op) |
| **Shipping in this PR** | **M3, M5, M6, L1, L3, L5** | ✅ |
| Deferred to future PRs (specific phase) | M1, M4, M8, M10, L4 | — |
| Architectural — needs project scope | C5, C6, C7 | This doc + recommendations |
