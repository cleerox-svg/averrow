# Averrow Deployment Phases — July 2026

**Source plan:** `docs/IMPROVEMENT_PLAN_2026-07.md` (build plan — waves of PR-sized
sessions). **Assessment:** `docs/PLATFORM_ASSESSMENT_2026-07.md`. **Deploy mechanics:**
`docs/DEPLOYMENT.md`.

**What this document is:** the *release* plan, not the *build* plan. The improvement plan
says **what** to build and in what dependency order. This says **how each change reaches
production safely** — the merge-gate sequence, migration/flag posture, post-deploy
verification, and rollback for each phase.

**Status legend:** ⬜ not started · 🟡 in progress · ✅ deployed & verified

---

## Current status & session handoff (updated 2026-07-19)

**Phases 0–3 are done and deployed to prod; the 24h post-deploy verification has run.** A new
session should resume at **Phase 4 (terminology re-anchor), starting with session S1.0** (the
naming occurrence map / rename-safety review — a hard prerequisite for S1.1–S1.6).

| Phase | Sessions | Merged PRs | State |
|---|---|---|---|
| 0 Baseline | — | #1633 (plan), #1634 (baseline) | ✅ done |
| 1 Security P0 | S0.3 (S1+S2), S0.5 (TK1) | #1635, #1636 | ✅ live |
| 2 Ops P0 | S0.1, S0.2 | #1637, #1638, #1641 (ct_monitor fix) | ✅ live · scanners ✅ verified; ct_monitor fixed (0238), re-verify pending |
| 3 D1 hot-path | S0.4 | #1639 | ✅ live · 24h verify ✅ pass (89.7%, trending down) |
| 4 Terminology | S1.0–S1.6 | — | ⬜ **next** |
| 5 Takedown + differentiator | S2.1–S2.4 | — | ⬜ |
| 6 Debt & hardening | S3.1–S3.6 | — | ⬜ |

**24h post-deploy verification — DONE (2026-07-19).** Full record:
`docs/deploy-baselines/phase-2-3-verify-2026-07-19.md`. Summary: **S0.2** — `dns_queue_parity.delta`
✅ (`-138`, phantom 9091 gone); **S0.4** — `d1_budget_state` ✅ (91.7% → 89.7%, still "warn" but
trending down); **S0.1** scanner cadence ✅ (`lookalike_scanner`/`trademark_monitor` 17/24, a
mid-window-deploy artifact — hourly post-deploy, reads 24/24 on a clean day); **S0.1** `ct_monitor`
telemetry ❌ **regression** — `pollCertificates` wasn't writing `agent_runs` because the S0.1 PR
omitted `ct_monitor`'s `agent_approvals` grandfather row, so `executeAgent`'s deployment-approval
gate blocked every tick. Fixed by `migrations/0238_ct_monitor_approval.sql` (PR #1641, merged into
master).

**ct_monitor re-verification — DONE ✅ (2026-07-19 04:26Z).** 0238 deployed with PR #1641;
`./scripts/platform-diagnostics.sh 6` after the `18 * * * *` tick shows `ct_monitor` present in
`agent_mesh.per_agent[]` (2 runs / 2 success, last 04:19:18Z). **Phase 2 go/no-go now fully met** —
scanners ✅ and ct_monitor ✅ visible to Flight Control. See
`docs/deploy-baselines/phase-2-3-verify-2026-07-19.md`.

**Scope corrections landed during execution** (a new session should trust these over the
original assessment line-items): **S0.2/R3** was a phantom metric, not a backlog — became a
diagnostics-metric fix. **S0.4/T1** was 4 genuinely-swappable sites + 5 entity-bounded
(not full-table) sites left as-is, not 9 uniform full-table scans. See each phase's inline
correction note.

**Deferred follow-ups logged during Phases 1–3** (candidates for Phase 6): the sub-role
write matrix (`support`/`sales`/`billing` reach generic mutation routes); the takedown
terminal-state transition-table gap (flips *out of* terminal states are unrestricted); the
DNS candidate-predicate consolidation across reconciler/reaper; and a pre-existing **local**
D1 migration-replay break (`cf_scan_id` in migrations 0016/0017/0086/0198 — prod unaffected).

---

## 0. The governing deployment fact

**Every merge to `master` is a live production deploy.** `deploy-radar.yml` fires on push
to `master` for any `packages/**` change and runs, with no manual release step:

```
typecheck → build averrow-ops + averrow-tenant + averrow-marketing
          → run migrations (DB, audit, geoip, dns-queue; each retried ×4)
          → verify seeded rows landed (db:verify:prod — fails loud)
          → wrangler deploy (Worker + /v2 + /tenant + / assets)
```

Consequences that shape every phase below:

1. **A phase = one or more merges, each of which ships to prod on merge.** There is no
   "staging then promote" in CI. Sequence merges so master is always releasable; never
   merge half a phase.
2. **Migrations auto-apply on deploy and are forward-only.** `ALTER TABLE … ADD COLUMN` /
   new tables/indexes only (latest is `0237`; additive discipline verified in the
   assessment). `wrangler rollback` reverts **code, not schema** — a rolled-back Worker
   must still run against the newer schema, so every migration must be back-compatible with
   the prior Worker.
3. **Staging exists but is out-of-band.** `[env.staging]` → `averrow-worker-staging` /
   `staging.averrow.com`, deployed only by manual `wrangler deploy --env staging`. Use it
   as the pre-prod gate for the **auth-behavior-changing** phases (Phase 1), where a wrong
   guard locks out real staff.
4. **External traffic ships dark behind a flag.** The pattern already exists —
   `TAKEDOWN_SEND_MODE = live|dark|off` in `wrangler.toml`. Anything that emails a customer
   or submits to a third party ships with its flag **off**; the owner flips it post-verify.
5. **The D1 read budget is a release gate, not a background metric.** Live budget was
   **92.9% of the daily plan** at assessment time (R4). Phase 3 (hot-path discipline) is
   sequenced early *because* it buys headroom; until it lands, treat any phase that adds
   read volume as budget-gated and check `d1_budget_state` in diagnostics after deploy.

**Per-phase gate (runs before every merge — from CLAUDE.md §1A + §12):**
`npx tsc --noEmit` clean · `check:resource-drift` · `test` (vitest) · `qa-verifier`
end-to-end drive · `code-reviewer` (+ `appsec-reviewer` when auth/RBAC/data-exposure;
`design-reviewer` when UI). Reviewers never ship — a failing gate goes back to the owning
engineer.

**Per-phase post-deploy verification:** `./scripts/platform-diagnostics.sh 24` (or the
narrower assertion named in the phase), compared against the **baseline captured in
Phase 0**.

---

## Phase 0 — Pre-flight baseline (no code) ✅

Establish the "before" picture so every later phase has something to diff against, and
confirm the release machinery is healthy before loading it.

- [ ] Confirm CI green on `master`; no pending migrations (`db:migrate:status:prod`).
- [ ] Capture baseline `./scripts/platform-diagnostics.sh 24` → save to
      `scratchpad/deploy-baseline-2026-07.json`. Record specifically: the 3 starved
      scanners' run counts (R1), `ct_monitor` telemetry presence (R2), `dns_queue` drift
      delta (R3), and `d1_budget_state` (R4).
- [ ] Confirm staging deploys: `wrangler deploy --env staging` succeeds and
      `staging.averrow.com` serves. This is the Phase 1 safety net — prove it works while
      nothing depends on it.
- [ ] Confirm `wrangler rollback` target exists (a known-good prior deployment).

**Go/no-go to Phase 1:** baseline captured, staging deployable, CI green.

---

## Phase 1 — Security P0 hardening (highest blast radius → goes first, via staging) ✅

**Ships:** improvement-plan **S0.3** (S1 internal-secret escalation + S2 auditor read-only
bypass) and **S0.5** (TK1 takedown status-flip integrity). Owner: backend-engineer →
appsec-reviewer.

**Why first, why staged:** these change **who can do what**. S1/S2 tighten auth; a wrong
guard doesn't corrupt data, it locks out legitimate staff — invisible to `tsc`, caught only
by driving real roles. This is the one phase that goes to **staging first**.

**Deploy procedure:**
1. Land S0.3 and S0.5 as separate PRs (independent files — S0.3 in `handlers/auth.ts` /
   `middleware/auth.ts` / role routes; S0.5 in `handlers/takedowns.ts`).
2. `wrangler deploy --env staging` for each; on staging drive: super_admin (full),
   admin (mutations still work), analyst/sales/support/billing (unchanged), and a **minted
   `auditor`** token (every mutation → 403, every read → 200). Confirm a diagnostics-scoped
   `AVERROW_INTERNAL_SECRET` can **no longer** mint an admin-mutation JWT.
3. For TK1: attempt `draft→submitted` on an orgless/unauthorized takedown → must be
   rejected; on an authorized one → still allowed. Confirm no dispatch side-effect.
4. Merge to `master` (prod deploy) only after staging drive is clean + `appsec-reviewer`
   sign-off.

**Migration impact:** none expected (guard/logic changes). If S2 adds a hierarchy tier or
role-set table, it's additive.

**Rollback:** `wrangler rollback` — safe, no schema change. Because these are *tightenings*,
a rollback re-opens a known hole rather than breaking users; still, prefer roll-forward.

**Go/no-go to Phase 2:** all six role personae behave correctly in prod; TK1 integrity
check rejects unauthorized flips; appsec sign-off recorded.

---

## Phase 2 — Live ops / reliability P0 (cron surgery) ✅ *(deployed; 24h diagnostics verify pending)*

**Ships:** **S0.1** (kill agent starvation — dedicated crons for CT monitor / lookalike /
trademark; wrap `runCTMonitor` in `executeAgent`) and **S0.2** (DNS-queue drift root-cause +
fix). Owner: backend-engineer / platform-sre → qa-verifier.

> **S0.2 scope correction (2026-07-18):** the live investigation found the
> "R3 DNS-queue drift = 9,091" finding was a **phantom** — a mislabeled
> diagnostics metric, not a real backlog. `dns_queue_parity.drainable_in_threats`
> was built from the cooldown-filtered `dns_queue` count instead of the
> threats-side candidate count, so it always looked ~18× over threshold in
> normal operation while FC's real drift alert stayed correctly silent. S0.2
> therefore became a **metric-correctness fix** (read-path only, no reaper/
> notification change, no migration): repoint `drainable_in_threats` at the
> true threats-side candidate count. See the corrected R3 note in
> `docs/deploy-baselines/phase-0-baseline-2026-07-17.md`.

**Why second:** it's live-firing (dropping ~67% of 3 scanners' runs) but, unlike Phase 1,
a regression is *observable in diagnostics* rather than a silent lockout — so it deploys
straight to prod behind the standard gate.

**The mandatory extra gate — the cron-audit rule (CLAUDE.md §6):** S0.1 changes
`wrangler.toml` crons. **Audit every time-gate in the touched handler for minute
assumptions** before merge; the cron fires at one minute and any `minute === X` check that
doesn't match is dead code. This rule exists because the exact same class of change caused
a 22-hour mesh outage. `qa-verifier` must confirm the new crons' minutes match their gates.

**Deploy procedure:**
1. Merge S0.1 (new `[triggers]` crons + `executeAgent` wrap). Migration: none.
2. Merge S0.2 (reaper/notification fix). Migration: none expected.
3. **Post-deploy verification is time-delayed** — re-run `platform-diagnostics.sh 24`
   after a **full day**:
   - lookalike + trademark scans show **24/24** (was 8/24).
   - `ct_monitor` now has `agent_runs` rows and appears in `agent_mesh.per_agent[]`.
   - **(revised)** `dns_queue_parity.delta` now tracks the reaper's *true*
     queue-vs-reality parity (~0) instead of the phantom cooldown gap. The
     real verification is that `drainable_in_threats` equals the threats-side
     `COUNT(DISTINCT malicious_domain)` candidate count and `delta` matches
     the reaper's `scanned - candidatesInThreats` (~0). The original
     "drift delta back under 500" target was based on the bogus metric.
     `platform_dns_queue_drift` was never blind — it already gated on the
     real predicate and stayed correctly silent.

**Rollback:** `wrangler rollback`. Cron changes revert cleanly; the wrapped
`executeAgent` telemetry is additive.

**Go/no-go to Phase 3:** the 24h diagnostics diff confirms the three scanners at full
cadence and `ct_monitor` visible to Flight Control.

---

## Phase 3 — D1 hot-path discipline (budget headroom) ✅ *(deployed; 24h D1-budget verify pending)*

**Ships:** **S0.4** (T1 — swap 9 page-load `GROUP BY`-over-`threats` aggregates to the
matching cube / pre-computed column). Owner: backend-engineer → qa-verifier.

> **S0.4 scope correction (2026-07-18):** of the 9 cited sites, only **4 were
> genuinely swappable** while preserving parity — `dashboard.ts`
> handleDashboardProviders (worst + improving) and `trends.ts` brand + provider
> momentum. The worst-providers *count* now reads `hosting_providers.total_threat_count`
> (all-status all-time — **exact** parity); the other three read `threat_cube_provider`/
> `threat_cube_brand` (**approximate**: active-only + created_at buckets), each matching
> an already-shipped sibling handler (`handleWorstProviders`/`handleImprovingProviders`/
> `handleBrandMovers`/`handleProviderMovers`) so the approximation is pre-existing platform
> behavior, not a new divergence. The other **5 sites were left as-is** with guard comments:
> they cross brand×provider or are campaign-scoped/all-status-1y (no cube carries those
> dimensions) — and, like T1's own framing, they are **entity-bounded** (indexed by
> `target_brand_id`/`campaign_id`), not the full-table scans the line-item implied. A wrong
> count is worse than a slow one, so they were not forced.

**Why here:** low code risk (read-only query swaps) but high operational value — it buys
back D1 read budget (live at **92.9%**). Sequenced right after the P0s so later,
read-heavier phases deploy with headroom.

**The mandatory extra gate — row-count parity:** each swapped query must return the **same
row counts / values** as the old `GROUP BY` before merge. `qa-verifier` captures old-vs-new
for each of the 9 sites (`dashboard.ts:273/295`, `brands.ts:789/1125/1203`,
`campaigns.ts:81/91`, `trends.ts:116/257/280`). A cube can lag by up to its rebuild window —
confirm the endpoints tolerate that or read the pre-computed column instead.

**Deploy procedure:** one PR (or a few grouped by handler). Migration: none — cubes and
pre-computed columns already exist. Post-deploy: confirm `d1_budget_state` trends **down**
in the next full-day diagnostics; confirm the affected pages render identical numbers.

**Rollback:** `wrangler rollback` — pure read-path, trivially safe.

**Go/no-go to Phase 4:** parity confirmed on all 9 sites; read budget trending down.

> **End of Wave 0.** Phases 1–3 are the "deploy first" set — the live/security-material
> fixes. They touch disjoint files and could be *built* in parallel, but they *deploy* in
> this risk order (auth → cron → read-path) so each has a clean verification window.

---

## Phase 4 — Terminology & positioning re-anchor (Wave 1) ⬜

**Ships:** improvement-plan **S1.0–S1.6** — purge internal code names from customer
surfaces, fix the three wrong agent descriptions, canonicalize core nouns, adopt the DRPS
category label, surface unmarketed capabilities, re-anchor the differentiator trio. Owners:
content-strategist + frontend-engineer + seo-strategist.

**Blast radius:** mostly copy/config, but it rebuilds all three SPAs + marketing on merge.
Low runtime risk, high commercial leverage.

**The mandatory extra gate — the rename-safety protocol (improvement-plan Wave 1 header):**
**S1.0 is a hard prerequisite** and ships as a doc, not code
(`docs/NAMING_RENAME_SAFETY_2026-07.md`). No `agent_id`, DB table/column, API route, role
string, or event/notification `type` key is renamed as part of this phase **unless** it
passes the full protocol: occurrence trace + migration + `qa-verifier` proof it still
dispatches/authorizes/groups/returns. **Default is display-string-only; keep the
identifier.** One PR per coherent rename.

**Deploy procedure:**
1. Merge S1.0 (doc + menu/nav alignment table). No deploy impact.
2. Merge S1.1–S1.6 as separate copy/config PRs. Each is a prod deploy (SPA/marketing
   rebuild). Migration: none for display renames; any structural rename that clears the
   protocol carries its own additive migration and its own merge.
3. Post-deploy: `design-reviewer` confirms token adherence + light/dark parity on changed
   surfaces; spot-check that no code name (Sentinel/ASTRA/Observer/Navigator/Blackbox/
   Pathfinder/Sparrow/"cockpit") survives on customer surfaces.

**Rollback:** `wrangler rollback` — copy changes are safe. A cleared-protocol structural
rename rolls back code but not its (additive) migration — verify back-compat as always.

**Go/no-go to Phase 5:** customer surfaces free of internal code names; no structural
rename shipped without its protocol artifact.

---

## Phase 5 — Takedown surfaces + close the differentiator (Wave 2) ⬜

**Ships:** **S2.1** (takedown metrics instrumentation), **S2.2** (analyst hand-submit path,
**dark**), **S2.3** (Ops takedowns → execution + prospect surfaces), **S2.4** (detection
depth in ROI order, D4 first). Owners: backend-engineer + frontend-engineer +
threat-intel-analyst.

**Why this order inside the phase:**
- **S2.1 before any public number.** Instrument submission→resolution time / volume /
  success from `takedown_submissions` first; **do not publish a takedown metric (the S1.5
  marketing claim) until this confirms a real figure.**
- **TK1 (Phase 1) must already be live** so the audit trail is truthful before S2.2 adds a
  new submit path.
- **S2.2 ships dark** behind the existing `TAKEDOWN_SEND_MODE` gate — it re-runs Phase G's
  per-row standing checks (`requireAuthorizationForModule` + entitlement + provider
  resolve) then `dispatchSubmission`. Merge with the flag **off**; owner flips after
  verifying on an authorized test org that a hand-submit dispatches, and an
  unauthorized/orgless one is refused.
- **S2.4 sequenced D4 → D2/D3/D5 → D6 → C5/D7.** D4 (newly-registered-domain from the
  VirusTotal `creation_date` already on the wire) is the cheapest, highest-ROI first drop.

**Deploy procedure:** S2.1 and S2.3 are internal/ops — deploy on merge behind the standard
gate. S2.2 deploys dark. S2.4 lands as incremental detection PRs, each with test coverage
for the new signal. Migrations: additive as needed (metrics rollups, new signal columns).

**Owner-gated flips (never automatic):** the `TAKEDOWN_SEND_MODE` flip for S2.2; publishing
any takedown metric; anything customer- or third-party-facing.

**Rollback:** code via `wrangler rollback`; S2.2 also instantly neutralized by flipping its
flag back to `off` without a redeploy.

**Go/no-go to Phase 6:** metrics instrumented and reconciled; hand-submit verified dark;
prospect surface composed from existing ingredients (no new detection claims unbacked by
code).

---

## Phase 6 — Debt & hardening (Wave 3, deploy as capacity allows) ⬜

**Ships:** improvement-plan **S3.1–S3.6** — shared `verifyOrgAccess` + single global-read
predicate (S3, S4); blanket `POST /api/internal/*` auth guard + manifest/CORS/TTL hygiene
(S5, S6); tenant vitest (T2); split `handlers/admin.ts` + orchestrator dispatch-table test
(T3, T4); finish R4/R7/R9 restructure cleanup (T5, T6); D1 budget trend + docblock drift
(R4, R5).

Non-urgent P2/P3. Each is an independent, low-risk merge deployed behind the standard gate.
**S3.1/S3.2 still route through `appsec-reviewer`** (they touch org isolation + the
internal surface). No dark flags, no time-delayed verification beyond the standard gate.

**Go/no-go:** none downstream — this phase drains debt continuously.

---

## Cross-cutting deployment guardrails (apply to every phase)

| Guardrail | Rule |
|---|---|
| **Master is always releasable** | Never merge a partial phase. Each PR must stand alone as a deployable unit. |
| **Migrations are forward-only + back-compatible** | Additive DDL only; a rolled-back Worker must run against the newer schema. Add a `db:verify:prod` assertion for any migration that seeds rows. |
| **External traffic ships dark** | Customer emails / third-party submissions merge with their flag off; owner flips post-verify. Pattern: `TAKEDOWN_SEND_MODE`. |
| **Cron changes trigger the cron-audit rule** | Any `wrangler.toml` cron edit → audit every minute-gate in the touched handler before merge. |
| **D1 read budget is a gate** | Check `d1_budget_state` after any read-heavy deploy; it was at 92.9% pre–Phase 3. |
| **Auth changes go via staging** | Guard/role changes prove out on `staging.averrow.com` against all six personae before prod. |
| **Owner-only flips** | Pricing/billing, MSA/legal text, anything sent to a customer/third party, agent retire/promote, external signups, and every dark-flag flip are always the owner's call. |
| **Post-deploy = diagnostics diff** | Verify each phase against the Phase 0 baseline, not against an assumption. |

---

## Deployment sequence at a glance

| Phase | Ships (plan IDs) | Deploy path | Extra gate | Verify |
|---|---|---|---|---|
| 0 | baseline | none | — | capture diagnostics + prove staging/rollback |
| 1 | S0.3, S0.5 (S1/S2/TK1) | **staging → prod** | 6-persona auth drive + appsec | roles behave; unauthorized flip rejected |
| 2 | S0.1, S0.2 (R1/R2/R3) | prod | **cron-audit rule** | 24h diff: scanners 24/24, `ct_monitor` visible; `dns_queue_parity.delta` ~0 vs reaper parity (R3 was a metric artifact, not a real drift) |
| 3 | S0.4 (T1) | prod | row-count parity | pages identical; D1 budget trends down |
| 4 | S1.0–S1.6 | prod | **rename-safety protocol** | no code names on customer surfaces |
| 5 | S2.1–S2.4 | prod (+ **dark** S2.2) | metrics-before-marketing; TK1 first | hand-submit dark-verified; real metric |
| 6 | S3.1–S3.6 | prod | appsec on S3.1/S3.2 | standard gate |

---

*Prepared 2026-07-17. Build plan: `IMPROVEMENT_PLAN_2026-07.md`. Assessment:
`PLATFORM_ASSESSMENT_2026-07.md`. Deploy mechanics: `DEPLOYMENT.md`. Naming map:
`TERMINOLOGY_LEXICON_2026-07.md`.*
</content>
</invoke>
