# imprsn8 convergence decision — keep standalone

**Status:** **Decided — keep standalone.** Phase 0 step 6.
**Date:** 2026-05-07
**Related:** `.claude/plans/v3.md` §2.6 (imprsn8 reference), §4 (v3 architecture), `CLAUDE.md` repo structure note

> **Superseded — imprsn8 decommissioned 2026-07-12.** The question this
> doc answers (standalone vs. converge) is moot now that `packages/imprsn8`
> no longer exists. Left as-is for historical record of the Phase 0
> reasoning; do not treat anything below as current state.

---

## 1. The question

The v3 plan was originally silent on imprsn8. The Phase 0 audit (2026-05-06) flagged this as a Phase 0 decision:

> **imprsn8 convergence decision** — separate product vs. converge into v3? Recommend separate (different audience).

This doc closes the question with the rationale and what stays decoupled.

---

## 2. Decision

**Keep imprsn8 standalone**. Two parallel Cloudflare Workers under the same parent (LRX Enterprises Inc.), no code-level coupling, no shared data.

The v3 work in `packages/averrow-worker/` and the in-flight `packages/trust-radar-v3/` work do **not** touch `packages/imprsn8/`. imprsn8 keeps its own:

- Cloudflare Worker (`imprsn8.com`)
- D1 (`imprsn8-db`)
- KV namespace (`SESSIONS`)
- R2 bucket (`imprsn8-assets`)
- Cron schedule (`*/30 * * * *` for data-feed pulls)
- Migrations (currently 0001-0018)
- Frontend SPA (in `packages/imprsn8/public/`)
- Brand / domain / audience

---

## 3. Why standalone wins

### 3.1 Audiences don't overlap

| Product | Audience | Sells what |
|---|---|---|
| **Averrow** (corporate brand protection) | T&S teams, threat intel teams, brand-protection orgs at mid-market+ companies | Threat-actor intelligence + brand impersonation detection + takedown workflow |
| **imprsn8** (personal-brand digital-impression scoring) | Influencers, agencies managing influencer rosters, individual creators | Score & monitor an individual's digital impression; impersonation alerts on personal-brand accounts |

A buyer for one doesn't naturally buy the other. The pitch, the price point, the IA, the success criteria all diverge.

### 3.2 Zero code coupling today

```
$ grep -rn "imprsn8" packages/averrow-worker/src/
packages/averrow-worker/src/agents/architect/collectors/repo-fs.ts:36   # comment only
packages/averrow-worker/src/agents/architect/collectors/repo-fs.ts:92   # comment only
packages/averrow-worker/src/lib/cors.ts:8-9                              # CORS allowlist

$ grep -rn "trust-radar\|averrow" packages/imprsn8/src/
packages/imprsn8/src/templates/homepage.ts:416  # "Also by LRX: Averrow →" link
packages/imprsn8/src/lib/cors.ts:4-7            # CORS allowlist
```

Two CORS allowlists (so the two products can call each other if a feature ever needs that) plus one footer link. **No shared modules. No shared data. No shared types.**

Convergence would have to *create* coupling. There's nothing to keep together.

### 3.3 Operational independence is already paid for

imprsn8 is its own worker with its own deploy pipeline, its own cron, its own monitoring. Converging it into the v3 worker would mean:

- Merging 18 imprsn8 migrations into the v3 migration tree
- Merging a `*/30` cron into the v3 cron schedule (which already has `*/5`, `7 * * * *`, `12 */6 * * *`)
- Sharing read-replica + KV-cache budgets — and imprsn8 has its own KV (`SESSIONS`) that's session-scoped (not appropriate for the broader cache pattern)
- Cross-tenant-data-leak risk: imprsn8 customers' data and Averrow customers' data in one DB
- Carrying imprsn8's brand / domain / SPA into the v3 customer tenant codebase

Each of those is a *new* problem. The current setup has **none** of them.

### 3.4 Different release cadences

Averrow is on a 49-week v3 roadmap. imprsn8 is iterating on a different cadence (data feeds, agent runs, takedown flow). Coupling release trains slows whichever product is moving faster — typically the smaller one.

### 3.5 Brand strategy aligns with separation

`CLAUDE.md` already documents the parent-company structure:

> **Parent company:** LRX Enterprises Inc. (Canadian-incorporated)
> **Domains:** averrow.com (primary), averrow.ca (Canadian market)
> imprsn8/ ← Separate Worker for imprsn8.com (digital-impression scoring)

LRX runs two consumer-facing products. The pattern (parent + sub-brands) is well-precedented and works without code-level convergence (e.g. Atlassian's products, Adobe's, Microsoft's).

---

## 4. Where convergence WOULD make sense (deferred indefinitely)

This decision can be revisited if any of the following becomes true. None are true today:

| Condition | Why it would change the answer |
|---|---|
| Customer overlap exceeds ~10% | If brand-protection buyers also buy personal-brand monitoring at scale, a single login + unified billing surface would be customer-valuable |
| Shared correlation engine becomes the differentiator | If imprsn8's per-influencer impersonation detection benefits from Averrow's actor-centric correlation (ADR-001), the pull would be on imprsn8's side. Today imprsn8 has its own (smaller) detection logic |
| Cross-tenant intel becomes a single product | If LRX decides to sell unified "all impersonation across corporate + personal brand" intel as one SKU, the products converge at the data layer |
| Operational cost of two stacks > value of separation | Currently both stacks are tiny on Cloudflare's free / low tiers. Cost difference is negligible |

If any of these triggers, the convergence path is relatively clean — the lack of coupling means a future merge can be deliberate rather than accidental.

---

## 5. What this decision implies for v3

**Nothing changes** in:
- v3 architecture (`.claude/plans/v3.md` §4 — `packages/trust-radar-v3/`, `packages/averrow-tenant/`, `packages/averrow-ops/`)
- ADR-001 (actor-centric schema) — applies to Averrow's data only; imprsn8 keeps its own schema
- ADR-002 (migration strategy) — applies to v2 → v3 cutover; imprsn8 untouched
- Phase plan §6 — phases 0-7 are Averrow-only

**`packages/imprsn8/` is explicitly out of scope** for every v3 phase. Operators working on v3 should not touch imprsn8 unless they're explicitly working on imprsn8 features.

The two products *may* eventually share infrastructure tooling (e.g. a common deploy script, a shared CI workflow template), but at the application layer they remain separate.

---

## 6. Open questions

| # | Question | Owner | When |
|---|---|---|---|
| Q1 | Should the architect agent (`packages/averrow-worker/src/agents/architect/`) document imprsn8 as a sibling system in its architecture maps? Currently it has comments excluding it from its scan | Engineer A | Whenever architect agent next gets work |
| Q2 | If Averrow grows a "personal brand" SKU via cross-tenant intel, would that re-introduce the convergence question? | Operator | Before cross-tenant intel pricing tier (§5.5) reaches the personal-brand market |
| Q3 | Cost-tracking dashboard: should imprsn8 spend roll up into the same Averrow-master view, or stay separate? | Operator | When Phase 0 step 7 (Pathfinder cron decision) closes — they're in similar ops territory |

---

## 7. References

- `.claude/plans/v3.md` §2.6 (imprsn8 description), original silence corrected here
- `CLAUDE.md` — repo structure note placing imprsn8 as a separate worker
- `packages/imprsn8/wrangler.toml` — confirms standalone Cloudflare deployment
- `packages/imprsn8/migrations/` — 18 migrations on `imprsn8-db`
- ADR-001 (actor-centric schema) — applies to Averrow data; imprsn8 keeps its own
- ADR-002 (migration strategy) — Averrow-only; imprsn8 untouched
