# Brand Profiles deprecation reconciliation

**Status:** Confirmed dead in production. Code retirement scheduled as v2-side cleanup before Mode B ingest dual-write starts (per ADR-002).
**Date:** 2026-05-07
**Phase:** Phase 0 step 5
**Related:** `.claude/plans/v3.md` §2.8 (Brand Profiles deprecated note), §9.6 (brand-health destination), ADR-001, ADR-002

---

## 1. The reconciliation question

The v3 plan's §2.8 marks `brand_profiles` as **DEPRECATED**, but the §9.6 brand-health destination doesn't say what to read instead. The Phase 0 audit (2026-05-06) flagged this as work to close before §9.6 design ships:

> **Brand Profiles deprecation** — confirm `brand_profiles` is being retired; update §9.6 brand-health design to use `brands` + `org_brands.monitoring_config_json` instead.

This doc closes the question with empirical evidence and a code-side retirement plan.

---

## 2. Empirical state — `brand_profiles` is functionally dead

Live `trust-radar-v2` snapshot, 2026-05-07:

```sql
SELECT
  (SELECT COUNT(*) FROM brand_profiles) AS bp_total,
  (SELECT MAX(created_at) FROM brand_profiles) AS bp_last_created,
  (SELECT MAX(updated_at) FROM brand_profiles) AS bp_last_updated,
  (SELECT COUNT(*) FROM org_brands) AS ob_total,
  (SELECT MAX(created_at) FROM org_brands) AS ob_last_created;
```

| Table | Rows | Last write |
|---|---:|---|
| `brand_profiles` | **1** | 2026-03-22 (≈ 6 weeks ago) |
| `org_brands` | **4** | 2026-04-27 (≈ 10 days ago) |

`brand_profiles` hasn't received an INSERT or UPDATE in 6 weeks. `org_brands` is the actively-written tenant-scoped binding. The deprecation isn't aspirational — it already happened.

---

## 3. The replacement model

`brand_profiles` was a **per-user brand registry** (each user could register their own brand for monitoring). The platform shifted to a **per-org binding** model where a brand is a tenant-scoped resource.

| Concern | brand_profiles (old) | brands + org_brands (new) |
|---|---|---|
| Brand identity | `brand_name`, `domain`, `aliases`, `official_handles`, `brand_keywords`, `executive_names`, `logo_url` | `brands` table (canonical, deduplicated, shared across tenants) |
| Ownership | `user_id` FK | `org_brands(org_id, brand_id)` binding (tenant-scoped) |
| Monitoring tier override | `brand_profiles.monitoring_tier` | `org_brands.monitoring_config_json` (richer JSON config per tenant) |
| Status | `brand_profiles.status` | Implicit — row presence in `org_brands` means active |
| Risk scores | `social_risk_score`, `domain_risk_score`, `email_grade`, `exposure_score` | All migrated to `brands` table (see migration 0028 + admin backfill) |
| Last scan timestamps | `last_full_scan`, `next_scheduled_scan` | `brands.last_social_scan` / `brands.next_social_scan` etc. |

Every column `brand_profiles` carried is now either on `brands` (canonical, shared) or `org_brands.monitoring_config_json` (tenant overlay). The split is correct: brand identity is global; what a tenant chooses to monitor about a brand is tenant-specific.

---

## 4. Code references still alive on master (2026-05-07)

`brand_profiles` is referenced in **57 lines across 9 files** (per `grep -rn brand_profiles packages/`). The UI doesn't reference it at all — every callsite is in the worker.

| File | Role | What touches `brand_profiles` |
|---|---|---|
| `packages/trust-radar/src/handlers/brandProfiles.ts` | The CRUD handler | All read/write paths for `/api/brand-profiles*` |
| `packages/trust-radar/src/routes/brands.ts` | Route registration | 7 routes mount the brandProfiles handler |
| `packages/trust-radar/src/handlers/lookalikeDomains.ts` | Ownership-verify joins | 3 SELECT + 1 JOIN |
| `packages/trust-radar/src/handlers/ctMonitor.ts` | Ownership-verify joins | 3 SELECT + 1 JOIN |
| `packages/trust-radar/src/handlers/admin.ts` | One-shot backfill endpoint | `POST /api/admin/backfill-social-config` — already-run migration tool |
| `packages/trust-radar/src/agents/sentinel.ts` | Read-only join | 1 declared `reads:` entry + 1 JOIN in social-mention enrichment |
| `packages/trust-radar/src/agents/narrator.ts` | Read-only ownership lookup | 1 declared `reads:` entry + 1 SELECT for alert→brand-owner resolution |
| `packages/trust-radar/src/agents/architect/manifest.generated.ts` | Auto-generated agent manifest | 2 mentions (downstream of the agent declarations above) |

UI: zero references. The averrow-ui side already uses `org_brands` exclusively.

---

## 5. Why these references aren't urgent — but ARE legacy debt

Each remaining callsite is doing one of three things:

1. **Serving dead routes** (`/api/brand-profiles*`) — no UI calls them; they're effectively unreachable from production traffic. **Cost of leaving them: zero.**
2. **Ownership-verify joins in lookalikeDomains / ctMonitor** — these check `brand_profiles.user_id = ?` to authorize per-user lookalike or CT log subscriptions. With 1 row in the table, this is functionally a no-op for almost every request. The new pattern is `org_brands.org_id = ?` ownership.
3. **Read-only JOINs in sentinel + narrator** — sentinel resolves social mentions to a brand owner; narrator resolves an alert to a brand owner. With `brand_profiles` empty, these JOINs return zero rows and the agents fall through to alternative paths (`brands.canonical_domain` resolution). Already de-facto migrated.

So: **nothing is broken**, but a meaningful chunk of the worker codebase still pretends `brand_profiles` is alive.

---

## 6. Retirement plan

Sequenced as a **v2-side cleanup** before Mode B ingest dual-write starts (ADR-002 Phase 1.2). The v3 worker should never reference `brand_profiles` — clean v2 first so v3 inherits a smaller surface.

| Step | What | Risk | Effort |
|---|---|---|---|
| **R1** | Mark `/api/brand-profiles*` routes as deprecated (return `410 Gone` with a body explaining the replacement) | None — zero production traffic | 1 hour |
| **R2** | Rewrite `lookalikeDomains.ts` + `ctMonitor.ts` ownership joins to use `org_brands.org_id` instead of `brand_profiles.user_id`. Delete the unused `brand_profiles` handler | Low — these handlers are gated behind auth that's already org-scoped | 4 hours |
| **R3** | Rewrite `sentinel.ts` + `narrator.ts` JOINs to drop `brand_profiles` entirely; resolve via `brands.canonical_domain` (already the fallback path) | Low — JOINs return 0 rows today; the fallback already runs | 2 hours |
| **R4** | Migration 014X: archive the single remaining `brand_profiles` row to a `_legacy_brand_profiles_2026_05` table; drop `brand_profiles` | Low — single row, no FKs from production code after R1-R3 | 30 minutes |
| **R5** | Regenerate `architect/manifest.generated.ts` after R3 lands | None — auto-generated | 5 minutes |

**Total: ~1 day of focused engineering** before Mode B starts. Deferring R1-R4 doesn't break anything but means v3 carries the dead surface forward (counter to ADR-002's "v3 starts clean" framing).

R1-R5 are not part of this Phase 0 docs PR — they're scheduled as an early-Phase-1 cleanup task. This doc captures the plan; the work itself ships when Phase 1 begins.

---

## 7. v3 plan §9.6 confirmation

§9.6's brand-health destination already uses the right surface:

> **Brand-health** (`features/brands/BrandDetail.tsx`)
> - Reuses: same handlers (`/api/brands/...` unchanged); only the IA changes.

`/api/brands/...` reads from `brands` (canonical) and authorizes via `org_brands` (tenant scope) — no `brand_profiles` involvement on the read path. The 8-tab → 3-tab Surface/Risk/Workflow collapse in v3 is purely a presentation-layer change; the data model is already correct.

**No §9.6 plan-text update needed.** The reconciliation is: §2.8's "Brand Profiles deprecated" note is correct; §9.6's reads from `brands` + `org_brands.monitoring_config_json` are correct; the only gap is the v2-side code cleanup (R1-R5 above), which is now scheduled.

---

## 8. ADR-001 implications

ADR-001 (actor-centric schema) places `brand` at the "context" tier — preserved from v2 in shape. `org_brands` follows the same context-tier preservation. **`brand_profiles` does not appear in ADR-001's entity ranking** — that was the implicit deprecation signal in the schema design. This doc makes it explicit.

When v3 ingest starts dual-writing in Mode B, the v3 schema does **not** include a `brand_profiles` table. The retirement plan in §6 ensures v2 also stops referencing it, so the parallel-run dual-write window doesn't inherit the legacy.

---

## 9. Open question

| # | Question | Owner | When |
|---|---|---|---|
| Q1 | Does the single remaining `brand_profiles` row need to be reconstructed into `org_brands` form before R4 archives it? Or is it operator test data that can just be dropped? | Operator | Pre-R4 (Phase 1 start) |

---

## 10. References

- `.claude/plans/v3.md` §2.8 (Brand Profiles deprecated), §9.6 (brand-health destination)
- ADR-001 (actor-centric schema; `brand` stays in context tier, `brand_profiles` absent)
- ADR-002 (migration strategy; R1-R5 scheduled before Mode B)
- v2 code references:
  - `packages/trust-radar/src/handlers/brandProfiles.ts`
  - `packages/trust-radar/src/handlers/lookalikeDomains.ts`
  - `packages/trust-radar/src/handlers/ctMonitor.ts`
  - `packages/trust-radar/src/handlers/admin.ts` — `POST /api/admin/backfill-social-config`
  - `packages/trust-radar/src/agents/sentinel.ts`
  - `packages/trust-radar/src/agents/narrator.ts`
- Replacement model:
  - `packages/trust-radar/src/handlers/tenantData.ts` (org-scoped reads from `org_brands`)
  - `packages/trust-radar/src/middleware/auth.ts` (tenant scope via `org_brands`)
  - Migration 0049 (`org_brands.monitoring_config_json`)
