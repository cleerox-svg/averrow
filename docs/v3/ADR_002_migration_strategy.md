# ADR-002 — Migration strategy: v2 → v3 parallel run, phased cutover

**Status:** Proposed (Phase 0 step 3 — pending operator review)
**Date:** 2026-05-07
**Supersedes:** —
**Superseded by:** —
**Related:** ADR-001 (actor-centric schema), `.claude/plans/v3.md` §5.1 (split lock), §6 Phase 1 + Phase 7, `docs/v3/PHASE_0_AUDIT.md`

---

## 1. Context

§5.1 of the plan is locked at **Option B (Two apps, one platform)**:

> v2 averrow-ui rebadges as `averrow-ops` (staff back-office); new v3 customer tenant app. Shared data layer.

That settles the *shape*. This ADR settles the *sequence* — how we get from one live worker + one live UI to a parallel-run state and then to v3 GA without taking the platform offline, losing customer state, or burning ops bandwidth on bug-for-bug compatibility.

### What's already implied by the phase plan

- **Phase 1 (8w)** — new `packages/trust-radar-v3/` worker exists; ingest engine writes to v3 schema. v2 keeps writing too.
- **Phase 2 (6w)** — correlation engine completes on the v3 schema. NEXUS / Sentinel / Cartographer write actor bindings + pivots + fingerprints natively.
- **Phase 7 (6w)** — parallel run, customer migration tooling, phased cutover (design partners → GA), v2 averrow-ui rebadged as averrow-ops.

This ADR fills in the dual-write/dual-read details, the cutover gates, the rollback story, and the averrow-ops rebadge mechanics.

### Non-goals

- This ADR is about the **production cutover**. v0 (abuse mailbox standalone) keeps running on v2 throughout — its migration into v3 is a separate `abuse_reports` table port (Phase 7 last week), not its own ADR.
- This ADR does not change ADR-001 (the schema). It assumes ADR-001 holds.

---

## 2. Decision

**Strategy: parallel-run dual-write, then phased read-cutover.** Three operating modes, sequenced.

```
Mode A — v2 only (today)        v2 ingest → v2 schema → v2 ui
Mode B — dual-write              v2 ingest → v2 schema   ─┐
                                                          ├─→ both writes acked
                                  v3 ingest ←┘
                                  v3 schema written from same feed events
Mode C — read-cutover, write-back v3 ingest → v3 schema → averrow-tenant (customer)
                                                       ↘
                                                        averrow-ops (staff, reads-only)
                                  v2 schema retired after the last design partner
                                  fully cuts over and the rollback window closes
```

### 2.1 Mode B (dual-write) — Phase 1.2 onwards

The simplest viable parallel-run shape:

- **Single source of truth for ingest events**: feed adapters publish a feed_event into a Cloudflare Queue.
- **Two consumers** read off the queue independently:
  1. v2 ingest worker — writes to v2 D1 (`trust-radar-v2`)
  2. v3 ingest worker (new in `trust-radar-v3` package) — writes to v3 D1 (`trust-radar-v3`)
- **Failure isolation**: if v3 worker errors, the queue retries v3 only; v2 is unaffected.
- **Ack discipline**: each consumer acks the queue independently. Mode B is "alive" only when both consumers are caught up (lag dashboards).
- **v2 stays canonical for reads** during the entire Phase 1-6 window. averrow-ui (which is becoming averrow-ops) reads v2. Nothing customer-facing reads v3 yet.

**What Mode B costs**:
- Two D1 databases, two ingest paths, ~2× ingest write budget. v2's current spend is $118/mo (per `docs/BUNDLE_F_OPS_2026-05-07.md`). Mode B doubles that — call it **+$118/mo for 6-9 months** ($700-1,000 total) — well within the original $150/mo cap once v2 retires.
- One operator-visible metric: queue-consumer lag for v3. If v3 lags >15 min, dashboards flag it. If v3 fails for >1h, alert fires; **but v2 keeps running**. This is the whole point of dual-write — v3 problems can't take the platform down.

**What Mode B does NOT do**: it does not promise the two schemas are byte-identical. They can't be — ADR-001 explicitly restructures. v2 → v3 is **forward compatible by construction**: the same ingest event produces a v2 write and a v3 write, but v3's write fans out to detection + bindings + pivots. No v2 row deletes/changes when a v3 row appears.

### 2.2 Mode C (read-cutover) — Phase 7 onwards

Cutover is **per-tenant**, behind a feature flag.

- Each tenant has a `tenant.read_path` enum: `'v2' | 'v3'`. Default `'v2'`.
- averrow-tenant reads `'v3'`. averrow-ops reads `'v2'` for tenants in v2 mode and reads `'v3'` for tenants already cut over (so support staff impersonating a customer see what the customer sees).
- The cutover sequence:
  1. **Internal validation tenants** (Averrow employees + 1 design partner) cut over **first**. 1-2 weeks of shadowing before the next batch. Define "good": parity for all primary surfaces, no missing rows, no duplicated rows.
  2. **Design-partner cohort 1** (3-5 tenants). 2-week soak.
  3. **Design-partner cohort 2** (rest of design partners). 2-week soak.
  4. **General customer migration**. Batched at 5-10 tenants/day. The `tenant.read_path` flip is the entire migration event from a customer's perspective; v3 already has their data because Mode B wrote it for the past 6+ months.
  5. **v2 read retirement**. Once the last tenant has cut over and a 30-day rollback window closes, v2 D1 reads stop. Writes continue for 30 more days (rollback insurance), then v2 D1 is decommissioned.

### 2.3 Customer migration tooling

What needs to *physically move* across schemas vs *be regenerated by v3 correlation*:

| Customer state | Mode | Why |
|---|---|---|
| Brand inventory (`brands`, `org_brands`, `brand_profiles` if not yet deprecated) | **Replicated by ingest dual-write** during Mode B | Both v2 and v3 see the same feed events |
| Detection history (raw threats / detections) | **Replicated by ingest dual-write** | Both v2 and v3 see the same feed events |
| Notification triage history (`alerts`, `alerts.resolution_notes`, `alert_ai_judge` outputs) | **One-shot port at cutover** | Customer-decision state — needs preservation, not regeneration |
| Takedown evidence (`takedown_requests`, `takedown_evidence_blobs`) | **One-shot port at cutover** | Legal-hold material; never regenerate |
| Incidents + status page (`incidents`, `incident_updates`) | **One-shot port at cutover** | Customer-visible audit trail |
| Notifications preferences (`notifications_preferences_v2`, per-brand subscriptions) | **One-shot port at cutover** | Customer setting — must transfer cleanly |
| Webhook + integration config (`org_integrations`, `org_webhook_endpoints`) | **One-shot port at cutover** | Production integrations; cannot break |
| Actor knowledge (`actor`, `actor_brand_target`, fingerprints, pivots) | **Regenerated by v3 correlation engine, not ported** | This is the v3 thesis — v3 schema does this better than v2 ever did. Backfill from v2 `threat_actors` (17 rows) + `threat_attributions` (47 rows) is one-shot at Phase 1.4 |
| Cube data (`threat_cube_*`) | **Regenerated by v3 cube-builder** | Idempotent rebuild, ~6h |

The "one-shot port at cutover" rows go through a **migration script** (`packages/trust-radar/scripts/migrate-tenant-to-v3.ts`) that:
1. Reads the tenant's rows from v2
2. Writes them into v3 schema (transforming where ADR-001 changes shape)
3. Writes a `migration_audit` row to v3 with checksum + row count for each table
4. Returns a verification report — "12 alerts ported, 47 takedowns ported, 3 webhooks ported"

The script is **re-runnable**: `ON CONFLICT DO NOTHING` everywhere. If a script fails halfway, fix the bug and re-run.

### 2.4 averrow-ops rebadge mechanics

The rebadge is **mostly cosmetic + scope tightening**, not a rewrite:

| Layer | Change |
|---|---|
| Repo path | `packages/averrow-ui/` keeps its name during Phase 1-6. Gets renamed to `packages/averrow-ops/` in Phase 7 week 5 (just before GA cutover) |
| Bundle name in CI | `averrow-ui` → `averrow-ops` |
| Public DNS | `averrow.com/v2/*` stays for now; redirects to `ops.averrow.com` once averrow-tenant is at parity for customer-facing surfaces |
| Sidebar | Drop customer-facing entries (Brands, Threats, Apps, Dark Web, Alerts) — those move to averrow-tenant. Keep ops-facing entries (Agents, Feeds, Metrics, Admin Dashboard, Team, Audit Log, Push Config, Pathfinder). Observatory stays as a staff intel tool |
| RBAC | All routes drop the `brand_admin` role check; they become `super_admin`-only or `staff`-role-only |
| Read path | averrow-ops reads from v2 during Phase 1-6, then **reads from v3** from Phase 7 cutover onwards (see §2.2) |
| Visual style | No design changes. averrow-ops keeps its existing look. The audit (`docs/UI_AUDIT_2026-05-06.md`) work already shipped applies to staff users too |
| Branding (logo / wordmark) | Stays "Averrow" with a small `OPS` chip in the top-bar. Internal-only naming distinction; no separate brand identity |

**What averrow-ops gains** in Phase 7:
- Tenant impersonation surface (already wired — `/api/admin/impersonate` exists)
- Cross-tenant Flight Control views
- Pathfinder lead-gen UI (currently lives in averrow-ui; stays here, drops from customer-facing scope)

### 2.5 Mode B → Mode C cutover gates

A tenant moves from `read_path='v2'` to `read_path='v3'` only when **all four gates** close for that tenant:

| Gate | What it checks | Tooling |
|---|---|---|
| **G1 — Schema parity** | For every entity the customer can see in averrow-ui, the v3 read returns the same set (modulo ADR-001 shape changes) | `scripts/parity-check.ts <tenant_id>` — runs the customer's main read queries against both DBs, diffs results, returns OK/MISMATCH |
| **G2 — Volumes match** | `COUNT(*)` for detection / brand / takedown / alert / incident over the last 30 days agrees within ≤ 0.1% (allows for ingest race conditions) | Same script, `--volumes` mode |
| **G3 — One-shot port verified** | The migration script ran successfully; `migration_audit` row checksums match | Inspect `migration_audit` table |
| **G4 — Customer notified + acknowledged** | Email sent, customer acknowledged or 7 days elapsed silently. Includes opt-out window | Tenant-side `migration_consent` boolean |

A tenant can be **rolled back** from `read_path='v3'` to `read_path='v2'` at any point in the 30-day rollback window. Rollback is just a flag flip + a re-run of `migration_audit` for one-shot ported entities (in case the customer made changes in v3 that need to ship back to v2). Writes during the rollback window go to **both** databases, so there's no split-brain.

### 2.6 Observability during dual-run

Three dashboards become first-class for the duration of Phase 1-7:

1. **Mode B health** — queue lag, consumer error rates, v2 vs v3 detection-count delta (should asymptote to zero modulo ADR-001 shape differences)
2. **Per-tenant cutover state** — `tenant_id`, `read_path`, days since cutover, parity-check last result, rollback eligibility
3. **Cost-tracking** — D1 spend per database, ingest token spend per worker, read replica utilization

These live in averrow-ops' Flight Control surface from Phase 1.5 onwards (already a v2 capability — `flightControl.ts` self-monitors all the v2 paths; v3 paths are added as new self-monitor cases).

---

## 3. Consequences

### 3.1 What gets easier

- **Zero-downtime cutover** — Mode B has been running for months; flipping `read_path` is the entire customer-visible event. No "migration weekend".
- **Cheap rollback** — flag flip is the rollback. No data restoration, no "undo" gymnastics.
- **v3 correlation can be wrong without breaking customers** — during Mode B, only Averrow staff watch v3. Customer-visible surfaces still come from v2. Phase 1-6 is the long debug window.
- **Per-tenant pace** — slow customer batches (5-10/day) keep blast radius small.
- **The schema rewrite isn't load-bearing during the business-critical period.** v0 (abuse mailbox) ships first on v2, generates revenue, and isn't blocked by v3.

### 3.2 What gets harder

- **Two D1 schemas to maintain for 6-9 months.** v2 schema migrations during Phase 1-6 must be replayed against v3. Mitigation: keep v2 schema **frozen** during Phase 1-6; bug fixes only, no new columns. Anything ADR-001 promises lands in v3, not v2.
- **Doubled ingest budget for 6-9 months.** Quantified above (~$700-1,000 total). Within current $150/mo cap once v2 retires.
- **Schema-shape diffs in parity checks.** `threats` → `detection` is a rename + restructure. The parity check has to know the mapping, not naively diff. Mitigation: parity check is per-entity, written once, well-tested.
- **One-shot port during cutover** is the only piece that's not idempotent over arbitrary downtime. If a customer has an in-flight notification triage during the migration, it lands in whichever DB they were on at the moment. Mitigation: cutover happens during a 1-hour low-activity window per tenant, with a 5-minute "freeze" advisory that staff can manually trigger.

### 3.3 What stays the same

- Cloudflare deployment model — Workers + D1 + Queues + KV.
- v2 ingest engine continues running unchanged through Phase 1-6.
- v0 (abuse mailbox standalone) keeps running on v2.
- imprsn8 stays separate (per Phase 0 step 6, separate-product decision).

### 3.4 What this ADR does NOT decide

- **EU residency cutover** — `trust-radar-eu` is a Phase 5 deliverable; its parallel-run pattern reuses Mode B but with a third D1 for EU tenants. Out of scope here; covered when EU residency lands.
- **v0 abuse-mailbox port forward into v3** — Phase 7 last week, not this ADR. The `abuse_reports` table port is small and uses the same one-shot-port pattern as alerts/takedowns.
- **Customer comms strategy for cutover** — marketing/CS responsibility. Engineering provides the timeline + per-tenant schedule.
- **What happens to v2 data after final retirement** — retention ADR. Default is "30-day cold backup, then drop". This ADR carries that as the working assumption.

---

## 4. Alternatives considered

### 4.1 Big-bang cutover (one weekend, all tenants migrate)

**Rejected.** Aligns with v0 ship pressure ("get to revenue fast"), but the actor-centric schema is too different from v2 to validate cheaply. The dual-write window IS the validation. Without it, week 1 of v3 GA would be "find the bugs by losing customer data."

### 4.2 Replication via D1 export → import (no dual-write)

**Rejected.** D1 export/import works for backups but not for live correlation. v3 NEXUS/Sentinel write actor bindings *as detections arrive*. A weekly export wouldn't capture the actor patterns that emerge between exports. Dual-write at the ingest layer is structurally simpler than batched replication.

### 4.3 v3 reads from v2 D1 via cross-database query

**Rejected.** D1 doesn't support cross-database joins. We'd be writing application-layer joins, which would be slower than the v2 read path it replaces. Defeats the point.

### 4.4 Single shared schema (extend v2 to ADR-001 in place)

**Rejected.** ADR-001 deletes 30+ enrichment columns from `threats`, renames the table, splits target_brand_id into a binding table, and promotes `actor` to canonical. A single-shared in-place migration would mean the live worker reads partial-state schemas during the migration window. Inevitable correctness bugs.

### 4.5 Read-cutover before write-cutover

**Rejected.** Reverses the safety order — customers would be reading from v3 while writes still go to v2, so v3 reads would lag arbitrarily. The whole point of Mode B is that **v3 stays current** through dual-write; reads cutover only after writes are reliably caught up.

---

## 5. Implementation sketch (informational — not part of the decision)

When Phase 1 starts:

| Sprint | Deliverable | Owner |
|---|---|---|
| 1 | New `packages/trust-radar-v3/` skeleton; v3 D1 created (empty); v3 worker boots | Engineer A |
| 2 | Cloudflare Queue between feed adapters and ingest workers; v2 worker reads from queue (not direct invocation) | Engineer A |
| 3 | v3 ingest worker subscribes to same queue; writes to v3 schema | Engineer B |
| 4-5 | Parity check script (read both DBs, diff per entity) | Engineer B |
| 6-7 | One-shot port script for migration-day state | Engineer A |
| 8 | Mode B operational dashboards in averrow-ui Flight Control | Engineer A |
| Phase 2-6 | Correlation, mitigation, integrations, customer tenant app — all on v3. v2 stays frozen | All |
| Phase 7 sprint 1 | Internal validation cohort cutover (Averrow staff + 1 design partner) | Engineer A |
| Phase 7 sprint 2-3 | Design partners cohorts 1 + 2 | Engineer A |
| Phase 7 sprint 4-5 | General customer migration in 5-10/day batches | Engineer A |
| Phase 7 sprint 6 | Rebadge averrow-ui → averrow-ops; v2 read-retirement; 30-day rollback window starts | Engineer B |

This is informational; ADR-002 owns the *strategy*, not the calendar.

---

## 6. Open questions

| # | Question | Owner | When |
|---|---|---|---|
| Q1 | Does the parity check tolerate ADR-001 enrichment-column moves automatically, or do we maintain a hand-curated v2-to-v3 column map? | Engineer A | Phase 1.4 |
| Q2 | Cloudflare Queues vs Durable Object fanout for the dual-write pattern? | Engineer A | Phase 1.1 |
| Q3 | What's the SLA on v3 lag during Mode B before we degrade to "v2 only" mode? | Operator + Engineer A | Phase 1.5 |
| Q4 | Do customers see any notice during Mode B (e.g. "Averrow is preparing v3 for you")? Marketing call | Operator | Phase 6 |
| Q5 | After v2 retirement + 30-day rollback window: do we keep v2 D1 cold backup forever, or drop after retention period? | Retention ADR | Phase 7 sprint 6 |

---

## 7. References

- `.claude/plans/v3.md` §5.1 (split LOCKED Option B), §6 phases (Phase 1 foundation, Phase 7 cutover)
- ADR-001 — actor-centric schema (the *what* this ADR plans the migration *for*)
- `docs/v3/PHASE_0_AUDIT.md` — baseline data state
- v2 platform reference:
  - `packages/trust-radar/src/agents/flightControl.ts` — self-monitor pattern v3 dashboards inherit
  - `packages/trust-radar/src/lib/cube-builder.ts` — cube rebuild pattern v3 reuses for actor cubes
  - `docs/BUNDLE_F_OPS_2026-05-07.md` — current $-spend baseline ($3.92/24h ≈ $118/mo)
