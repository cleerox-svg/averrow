# Phase 0 — Closeout

**Status:** Closeout (Phase 0 step 8 — operator-action list)
**Date:** 2026-05-07
**Phase:** Closes Phase 0 of `.claude/plans/v3.md` §6
**Related:** all docs in `docs/v3/`

---

## 1. What Phase 0 was

The v3 plan splits into a 49-week roadmap with Phase 0 carved out as **3-4 weeks of decisions + research before any v3 worker code gets written**. Phase 0 runs in parallel with Phase v0 (abuse mailbox standalone, ships first on v2 for early revenue).

This closeout summarizes the seven in-session steps that landed in `docs/v3/`, lists the operator-required actions, and hands the remaining work cleanly to Phase 1.

---

## 2. What shipped (steps 1–7)

| # | Step | Doc | PR |
|---|---|---|---|
| 1 | §8.6 customer-profile audit (re-run + tracked) | `docs/v3/PHASE_0_AUDIT.md` | #1094 |
| 2 | ADR-001: Actor-centric schema | `docs/v3/ADR_001_actor_centric_schema.md` | #1095 |
| 3 | ADR-002: Migration strategy (parallel run, phased cutover) | `docs/v3/ADR_002_migration_strategy.md` | #1096 |
| 4 | Observatory v2/v3 toggle (already shipped earlier) | — | #1091 |
| 5 | Brand Profiles deprecation reconciliation | `docs/v3/BRAND_PROFILES_DEPRECATION.md` | #1097 |
| 6 | imprsn8 convergence decision (keep standalone) | `docs/v3/IMPRSN8_CONVERGENCE_DECISION.md` | #1098 |
| 7 | Pathfinder cron decision memo (recommend Option C) | `docs/v3/PATHFINDER_CRON_DECISION.md` | #1099 |
| 8 | This closeout | `docs/v3/PHASE_0_CLOSEOUT.md` | *(this PR)* |

---

## 3. Operator-required actions (Phase 0 outputs)

These need **your decisions** before Phase 1 starts. Most are small.

| # | Action | Surfaced by | Block status |
|---|---|---|---|
| **OP1** | Pick Pathfinder cron path (A / B / **C** recommended). If C, also: (Q2) who curates the 20–30-name v0 outreach list? (Q3) does outreach copy reference platform-already-sees-X data? | Step 7 | Doesn't block Phase 1; blocks v0 outreach |
| **OP2** | Decide Brand Profiles R1–R5 retirement scheduling (early Phase 1 vs deferred). Default in Step 5 doc: schedule for Phase 1 sprint 1 | Step 5 | Doesn't block Phase 1 start; should land before Mode B |
| **OP3** | Decide on the 1 remaining `brand_profiles` row at R4 — reconstruct into `org_brands` form, or drop as test data? | Step 5 Q1 | Affects R4 scheduling only |
| **OP4** | Tranco import bug fix priority — schedule the ~2-hour engineering task. Ungating Pathfinder Option A and closing PHASE_0_AUDIT blocker #2 | Step 1, Step 7 | Doesn't block Phase 1; gates Pathfinder Option A |
| **OP5** | Sector backfill cadence — accept the current `brand_enricher` rate (~25 days to drain) or refactor to batch-classify? | Step 1 (PHASE_0_AUDIT blocker #3) | Doesn't block Phase 1; gates §5.2 re-audit |

None of OP1–OP5 require a docs PR; they're decisions or scheduling calls.

---

## 4. What was already locked (no operator action needed)

The original Phase 0 outline anticipated operator decisions on §5.1 / §5.3 / §5.4 / §5.5. Re-reading confirms all four are already **LOCKED** in the plan:

| Section | Status | Implication |
|---|---|---|
| §5.1 — v2/v3 split | ✅ LOCKED Option B (two apps, one platform) | ADR-002 already builds on this |
| §5.3 — Customer entry path | ✅ LOCKED Hybrid | Phase 6 self-serve onboarding builds on this |
| §5.4 — Pricing instrumentation | ✅ LOCKED Per-tenant tier + volume overlays | v0 abuse mailbox SKU follows this |
| §5.5 — Cross-tenant intel pricing tier | ✅ LOCKED Default-on at all tiers | Gap #9 (cross-tenant intel emit) is unblocked for Phase 5 |

Only §5.2 (mid-market sweet-spot) was DIRECTIONAL — and Step 1's audit (`PHASE_0_AUDIT.md`) explicitly concluded **it cannot close on the current snapshot**. The directional answer (`tech × {D,F}`, US-HQ, with the platform-mirage filter from §4) carries forward into v0 design-partner targeting via Pathfinder Option C.

§5.2 will re-close post-v0 launch, once the four PHASE_0_AUDIT blockers resolve and the v0 customer cohort provides real customer-fit anchors.

---

## 5. What's parked for later phases (no Phase 0 action)

These are **deferred to specific phases** by the ADRs and decision docs. Listed here so they're not forgotten.

### From ADR-001 (actor-centric schema):

| # | Question | Phase |
|---|---|---|
| Q1 | `detection.severity` vs `attribution_evidence.severity` | Phase 1.3 |
| Q2 | `actor_brand_target.target_relationship` enum | Phase 6.0 |
| Q3 | `detection_enrichment` retention policy | Phase 1.5 |
| Q4 | Kit-name auto-merge logic | Phase 2 |
| Q5 | `attribution_evidence` per-tenant vs cross-tenant scoping | Phase 5 |

### From ADR-002 (migration strategy):

| # | Question | Phase |
|---|---|---|
| Q1 | Parity-check column-mapping discipline | Phase 1.4 |
| Q2 | Cloudflare Queues vs Durable Object fanout | Phase 1.1 |
| Q3 | v3 lag SLA before degrading to v2-only | Phase 1.5 |
| Q4 | Customer comms during Mode B | Phase 6 |
| Q5 | Post-retirement v2 cold-backup duration | Phase 7 sprint 6 |

### From Brand Profiles deprecation:

| # | Question | When |
|---|---|---|
| (See OP3 above) | 1-row archive vs drop | Pre-R4 |

### From imprsn8 convergence:

| # | Question | When |
|---|---|---|
| Q1 | Architect agent's imprsn8 framing | Whenever architect agent next gets work |
| Q2 | Personal-brand SKU re-opens convergence question | Before §5.5 reaches personal-brand market |
| Q3 | Unified cost-tracking dashboard | When OP1 closes |

### From Pathfinder:

| # | Question | When |
|---|---|---|
| Q1–Q4 | Option pick + curator + copy + Tranco-fix scheduling | Operator action OP1 + OP4 |

### External work (not engineering-side):

- §9.9 customer-interview round (5 × 3 personas) — externally scheduled; not in scope for this session

---

## 6. Phase 1 readiness check

Phase 1 (8-week foundation port) can start when:

| Gate | Status |
|---|---|
| ADR-001 actor-centric schema documented | ✅ Step 2 |
| ADR-002 migration strategy documented | ✅ Step 3 |
| Brand Profiles retirement plan documented | ✅ Step 5 |
| imprsn8 scope clarified | ✅ Step 6 |
| Pathfinder decision surfaced | ✅ Step 7 (operator-pending) |
| §5.1 / §5.3 / §5.4 / §5.5 locked | ✅ pre-existing in plan |
| §5.2 directional (re-audit deferred) | ✅ Step 1 |
| Phase v0 abuse mailbox shipping path clear | ✅ pre-existing in plan §6 / §7 |

**Phase 1 is unblocked from a decisions standpoint.** Only OP1 (Pathfinder pick) and OP2 (Brand Profiles R1–R5 scheduling) want operator input before sprint 1 starts; neither is on the critical path.

Phase v0 (abuse mailbox standalone, ships first on v2) is also unblocked — its dependencies were §5.4 + §5.5 + disclaimer legal review, all of which sit outside Phase 0.

---

## 7. Suggested order of operator actions

If the operator wants to close OP1–OP5 before Phase 1 starts:

1. **OP1 first** — Pathfinder cron (Step 7, recommend C). Lowest engineering cost; immediately unblocks v0 outreach if you're going with C.
2. **OP3 + OP2** together — decide brand_profiles row fate, schedule R1–R5 for early Phase 1.
3. **OP4** — Tranco fix can be a side-task in any quiet engineering slot. Doesn't block anything until Pathfinder Option A is the chosen path.
4. **OP5** — sector backfill cadence is pure throughput tuning; default is "leave it" unless v0 outreach pushes for faster sector coverage.

OP1 + OP2 + OP3 in a single 30-minute conversation closes most of the open Phase 0 surface.

---

## 8. References

- `.claude/plans/v3.md` §6 phase plan (Phase 0 location)
- `docs/v3/PHASE_0_AUDIT.md` (Step 1)
- `docs/v3/ADR_001_actor_centric_schema.md` (Step 2)
- `docs/v3/ADR_002_migration_strategy.md` (Step 3)
- `docs/v3/BRAND_PROFILES_DEPRECATION.md` (Step 5)
- `docs/v3/IMPRSN8_CONVERGENCE_DECISION.md` (Step 6)
- `docs/v3/PATHFINDER_CRON_DECISION.md` (Step 7)
- `RESTRUCTURE_SPEC.md` — R10 (Observatory toggle, Step 4 already shipped)

---

**Phase 0 is closed. Phase 1 is ready when the operator is.**
