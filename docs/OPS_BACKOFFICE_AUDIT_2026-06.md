# Averrow Back-Office (averrow-ops) — UX & Capability Audit (2026-06)

> Companion to `TENANT_ANALYST_UX_RESEARCH_2026-06.md`. That doc audited the
> **customer** surface (averrow-tenant). This one audits the **staff
> back-office** (averrow-ops, the React /v2 SOC console, ~49 routes) and its
> backing Worker endpoints — **interleaved per domain** so UI and API findings
> reinforce each other.

---

## 1. Purpose & method

Same proven method as the tenant audit: a **competitor benchmark**, a **gap
table with severity**, and a **phased roadmap** — but run in **domain
batches** (a few cohesive pages at a time) because the surface is ~3× the
tenant's. Goals, in the user's words:

- Find **missing key features** vs competitor SOC / threat-intel platforms.
- Check the **UI is logical**: every list → entity → evidence → action
  drill-down works, with no dead-ends or orphaned surfaces.
- **Consolidate / simplify without losing features** (e.g. parallel v2/v3
  surfaces).
- Confirm **access logic** (RBAC) is coherent per page.

**Per-page rubric (the lens).** Each page scored on:
`purpose clarity · drill-down depth · redundancy · missing capability ·
access/RBAC logic · actionability`.

**Batch order** (chosen 2026-06): entity/pivot first, then working queues,
automation, big-picture, admin cluster.

| Batch | Pages | Status |
|---|---|---|
| **1 — Entity/pivot** | Brands, Providers, Threat Actors, Campaigns | 🔄 in progress |
| 2 — Working queues | Threats, Alerts, Intelligence | ⏳ |
| 3 — Automation | Agents, Approvals, Architect | ⏳ |
| 4 — Big-picture | Observatory, Trends | ⏳ |
| 5 — Admin cluster | Users, Orgs, Pricing, Incidents, Takedowns, Audit, Push | ⏳ |

**Cadence:** audit a batch → ship 1–2 consolidation/feature slices behind
draft PRs → next batch.

---

## 2. Competitor benchmark — what a staff threat-intel console is expected to do

Reference set for the *staff* (SOC/analyst) surface — distinct from the
tenant's brand-protection benchmark: **Recorded Future** (Intelligence Graph /
Intelligence Cards), **ZeroFox**, **Group-IB**, **Doppel** (Threat Graph),
**Microsoft Defender TI**, **Censys**, **Intel 471**, **Silobreaker**,
**Spamhaus**.

### 2.1 Entity/pivot domain — the expected-capability set

The repeated finding across vendors: **the entity is the unit of
investigation, and entities form a connected, pivotable graph** — not isolated
list rows.

| # | Expected capability | Source / precedent |
|---|---|---|
| E1 | **Entity "card" as investigation unit** — a bundled view of an entity (brand/provider/actor/campaign) that is the *starting point for triage and provides pivot points*. | RF **Intelligence Cards** |
| E2 | **Entity pivoting / link analysis** — pivot across IP ↔ domain ↔ provider ↔ actor ↔ campaign to uncover relationships; the graph is connected with **no dead-ends**. | RF **Intelligence Graph**, ThreatBook pivoting |
| E3 | **Threat-actor profile** with the standard spine: aliases, attribution/country, motivation, active-since, **targeted industries/geos (victimology)**, **MITRE ATT&CK TTPs**, malware/tools, associated campaigns, **recent-activity timeline**, linked IOCs. | Intel 471, SOCRadar, Google TI/VirusTotal actor cards, Silobreaker (MITRE) |
| E4 | **Hosting-provider / ASN reputation scoring** — a reputation/risk score per provider+ASN, **bulletproof-hosting signal**, abuse-contact + abuse correlation, trend over time. | MS Defender TI reputation, Censys, Spamhaus, ASwatch |
| E5 | **Campaign clustering + graph** — related infra/domains/profiles grouped into a coordinated **campaign**, shown as an **interactive graph** that exposes attacker infrastructure and drives bulk action. | **Doppel Threat Graph**, **ZeroFox** automated clustering |
| E6 | **Cross-entity consistency** — list views share search/filter/sort conventions; detail views share a notes/timeline/activity affordance so an analyst's muscle memory transfers between entity types. | General TIP UX (Cyware, Silobreaker) |

> _Inventory map (§3) and the Batch-1 gap table (§4) are populated from the
> in-flight recon and land in the next pass._

### 2.2 Sources

- [Recorded Future — Intelligence Graph](https://www.recordedfuture.com/platform/intelligence-graph) · [Threat Intelligence product](https://www.recordedfuture.com/products/threat-intelligence) · [What is Threat Intelligence](https://www.recordedfuture.com/threat-intelligence-101/what-is-threat-intelligence)
- [ThreatBook — Pivoting Analysis](https://docs.threatbook.io/guide/pivoting-analysis)
- [Intel 471 — Threat Actor Profiling & Modeling](https://www.intel471.com/use-cases/threat-actor-profiling-modeling) · [SOCRadar Threat Actor DB](https://socradar.io/free-tools/threat-actor) · [Google TI / VirusTotal — Threat Actors card](https://gtidocs.virustotal.com/docs/threat-actors-card)
- [Silobreaker — MITRE ATT&CK TTP detections](https://www.businesswire.com/news/home/20240304148696/en/Silobreaker-Integrates-MITRE-ATTCK%C2%AE-TTP-Detections-Into-Its-Threat-Intelligence-Platform)
- [Microsoft Defender TI — reputation scoring](https://learn.microsoft.com/en-us/defender/threat-intelligence/reputation-scoring) · [Censys — tracking bulletproof hosting](https://censys.com/blog/hiding-in-plain-sight-tracking-bulletproof-hosting-and-abused-rdp-infrastructure/) · [Spamhaus — anatomy of bulletproof hosting](https://www.spamhaus.org/resource-hub/bulletproof-hosting/the-anatomy-of-bulletproof-hosting-past-present-future-/) · [ASwatch (SIGCOMM 2015)](https://conferences.sigcomm.org/sigcomm/2015/pdf/papers/p625.pdf)
- [Doppel — Platform / Threat Graph](https://www.doppel.com/platform) · [ZeroFox — brand protection](https://www.zerofox.com/solutions/protection/brand-protection/)

---

## 3. Inventory & redundancy map

Source: full-surface recon of `src/App.tsx` + `components/layout/Sidebar.tsx`
(`OPS_SECTIONS`). ~49 routes across **3 nav sections**.

### 3.1 Information architecture (current Sidebar)

```
INTELLIGENCE   Home · Observatory · Brands · Threats · Apps · Dark Web ·
               Trademarks · Providers · Campaigns · Threat Actors · Intelligence(→/trends)
RESPONSE       Incidents · Takedowns · Signals(badge) · Spam Trap* · Abuse Mailbox* · Leads
PLATFORM       Agents · Feeds · Metrics · Dashboard · Team · Customers* · Pricing* ·
               Audit Log · Attribution Backlog
                                                        (* = super_admin-only)
```

### 3.2 Redundancy — mostly already resolved (corrects my initial read)

| Suspected dupe | Reality | Verdict |
|---|---|---|
| `observatory` vs `observatory-v3` | **Intentional A/B** — one nav item toggles via `ObservatoryVersionToggle`/`useObservatoryVersion()`; v3 = GPU particle viz, v2 = deck.gl. Both maintained. | Not redundant. (Open Q: is carrying two renderers worth the maintenance?) |
| `brands` vs `brands-v3` | **Cleanly deprecated** — `/brands-v3[/:id]` *redirects* to `/brands[/:id]`; v2 brands decommissioned, "v3 IS the brands surface." | Resolved. |
| `admin/customers` vs `admin/organizations` | Same component, alias kept for bookmarks (renamed in Stripe sprint). | Resolved. |
| `leads` vs `admin/scan-leads` | Scan Leads is now a **tab** in Leads; legacy path redirects to `/leads?view=scan`. | Resolved. |

**So the consolidation opportunity is NOT v2/v3 cruft** — that's been handled.
The real findings are below.

### 3.3 Real findings from the inventory

**F-A · No deep-linkable entity detail for Providers & Threat Actors.**
`/providers/:providerId` and `/threat-actors/:actorId` both **redirect to the
list** — detail is "inline-only via card expansion." Brands and Campaigns
*have* real detail routes (`/brands/:id`, `/campaigns/:id`). So the entity
model is **inconsistent**: two of the four core entities can't be linked to,
bookmarked, or pivoted *into* from elsewhere. (Direct hit on benchmark **E1/E2**.)

**F-B · Label/route mismatch in the IA.** A nav item literally named
**"Intelligence"** sits inside the **INTELLIGENCE** section and points to
`/trends` (the Trends/briefings page). Confusing twice over.

**F-C · 8 orphaned routes** (defined, not in nav). Some are deliberate
(`/admin/push` = one-time VAPID bootstrap, surfaced as a dashboard card), but
several are user-facing surfaces reachable only by header icon or direct URL:
`/profile`, `/notifications`, `/notifications/preferences`,
`/agents/approvals`, `/agents/:id/review`, `/agents/architect`,
`/admin/notifications`. The **agent-approvals** orphans matter most — see
Batch 3.

**F-D · RBAC is mostly "shell-gated, not route-gated."** Most INTELLIGENCE/
RESPONSE pages have **no route-level guard** — access is the staff-only app
shell + brand-admins redirected home. A handful of admin pages add an explicit
`isSuperAdmin` guard (Spam Trap, Abuse Mailbox, Customers, Pricing, Push,
Notifications-admin, agent approvals). Coherent, but worth confirming the
level-3 sub-roles (sales/support/billing/analyst) see a sensible subset rather
than the full INTELLIGENCE firehose (revisit per-batch).

**F-E · `RESPONSE` section mixes ops + sales.** Leads (sales pipeline) sits in
the same section as Incidents/Takedowns/Signals (SOC response). Different jobs,
different roles — an IA seam to revisit in Batch 5.

> Full per-route table (component file · nav location · data sources · actions ·
> RBAC) retained in the recon transcript; condensed here to the findings that
> drive change.

---

## 4. Batch 1 — Entity/pivot gap analysis

Deep recon of Brands, Providers, Threat Actors, Campaigns (list + detail +
backing endpoints), scored against the **E1–E6** benchmark (§2.1).

### 4.1 Per-entity scorecard (rubric: 0–5)

| Lens | Brands | Providers | Threat Actors | Campaigns |
|---|---|---|---|---|
| Purpose clarity | 5 | 4 | 4 | 4 |
| Drill-down depth | 4 | 2 | 2 | 3 |
| Actionability | 4 (deep-scan, scans) | 1 (read-only) | 1 (read-only) | 1 (read-only) |
| **Pivot (in/out)** | 3 (out to Actor only) | **0 (terminal)** | **0 (terminal)** | 2 (out to Actor only) |
| Deep-linkable detail | 5 (`/brands/:id`) | **0 (redirects to list)** | **0 (redirects to list)** | 5 (`/campaigns/:id`) |
| Cross-entity consistency | — | search ✓ / no detail route | **no search**, no detail route | **no search**, dead links |

**Reading:** Brands is the reference implementation (6-tab outcome-shaped detail,
real actions). The other three degrade sharply on **pivoting** and
**deep-linkability** — the two things the benchmark says *define* a threat-intel
console.

### 4.2 The pivot graph — what connects vs what dead-ends

```
Brand ──click actor──▶ Threat Actor          ✓ works
Campaign ──actor badge──▶ Threat Actor        ✓ works
Brand ─▶ Provider / Campaign                  ✗ v2 deep-link only (not wired in v3)
Campaign ─▶ Brand   (Brand Impact table)      ✗ shows count, NOT clickable
Campaign ─▶ Provider (Infrastructure table)   ✗ shows count, NOT clickable
Threat Actor ─▶ Campaign                       ✗ data exists (active_campaigns) but not rendered as links
Provider ─▶ anything                           ✗ terminal node, zero outbound nav
```

Of the ~9 natural edges between these four entities, **only 2 are wired.** The
data to wire most of the rest **already exists in the endpoint responses** —
this is largely a UI-wiring gap, not a data gap.

### 4.3 Gap table vs benchmark (severity-ranked)

| # | Gap | Benchmark | Backend exists? | Severity |
|---|---|---|---|---|
| G1 | **Dead-end pivots** — Campaign→Brand, Campaign→Provider, Actor→Campaign render as plain text/counts despite the ids being in the response. | E2 | ✅ ids already returned | **Critical** |
| G2 | **Providers & Threat Actors aren't deep-linkable** — `/providers/:id` and `/threat-actors/:id` redirect to the list; detail is inline-only, so nothing can link *into* them. | E1/E2 | ✅ `GET /:id` endpoints exist | **Critical** |
| G3 | **Provider is a terminal node** — no "brands targeted / campaigns" lists to pivot out to (only counts shown). | E2/E4 | ⚠️ counts exist; needs a brands/campaigns-by-provider read | High |
| G4 | **No interactive campaign graph** — infrastructure shown as 3 tables, not the connected Threat-Graph competitors use to expose attacker infra. | E5 | ⚠️ infra data exists | High |
| G5 | **Threat-actor profile gaps** — strong on aliases/attribution/TTPs(MITRE)/sectors/infra, but missing **motivation**, explicit **active-since**, a **recent-activity timeline**, and clickable campaigns/IOCs. | E3 | ⚠️ partial | Medium |
| G6 | **Cross-entity UX drift** — search on Brands/Providers but **not** Actors/Campaigns; pagination only on Brands; detail-route on Brands/Campaigns but not Providers/Actors. | E6 | — | Medium |
| G7 | **Brand→Provider/Campaign still bounces to v2** — the only remaining v2 dependency in the entity graph. | E2 | ✅ v3 surfaces exist | Medium |

**Headline:** of the 2 Critical gaps, **both are UI wiring on data that already
exists** — the same pattern the tenant audit found. G1 is mostly turning
existing names into `<Link>`s; G2 is making Providers/Actors deep-link targets.

### 4.4 Consolidation / simplification (no feature loss)

- **C1 — One shared entity-list shell.** Brands/Providers/Actors/Campaigns each
  re-implement card grid + filters + sparkline + status badge slightly
  differently. A shared `EntityList` (search + sort + pagination + status filter,
  consistent) collapses four bespoke implementations into one and fixes G6 for
  free. *Simplifies code AND UX; loses nothing.*
- **C2 — Deep-link via `?focus=:id` auto-expand**, rather than reviving full
  detail pages for Providers/Actors. Respects the existing "inline detail"
  decision while making them linkable targets (fixes G2 cheaply).
- **C3 — Resolve the `Intelligence`→`/trends` label/route mismatch** (F-B) — rename
  the nav item to "Trends/Briefings" or move the route; it's mislabeled today.

### 4.5 Recommended slice order (highest leverage first)

1. **Slice A — Complete the pivot graph (G1 + G7).** Make the already-present
   ids clickable: Campaign→Brand, Campaign→Provider, Actor→Campaign,
   Brand→Provider/Campaign (v3). Mostly `<Link>` wiring. *Biggest logic win,
   lowest cost.*
2. **Slice B — Make Providers & Threat Actors deep-link targets (G2 + C2).**
   `?focus=:id` auto-expands+scrolls the inline card. Unlocks Slice A's
   destinations and bookmarkability.
3. **Slice C — Provider pivot-out lists (G3).** Small read endpoint(s) for
   "brands targeted / campaigns" by provider, rendered as links.
4. **Slice D — Cross-entity consistency (G6 via C1).** Shared list shell: add
   search to Actors/Campaigns, consistent sort/pagination.
5. **Slice E — Actor profile completeness (G5).** Activity timeline + motivation
   + active-since.
6. **(Larger, separate) Slice F — Interactive campaign graph (G4).** Bigger
   visualization lift; flag for its own batch/PR.

> Slices A–B are the "make the entity graph logical" core and should ship first.

### 4.6 Implementation note — corrections from code verification (Slice A+B shipped)

Verifying against the live components (per the standing "confirm current-state in
code" rule) **corrected several recon claims** — the dead-ends were real, but in
a different place than the recon reported:

- **Campaign detail already links out** — Brand→`/brands/:id`, Provider→
  `/providers/:id`, Threat→`/threats/:id` are all `<Link>`s today (recon said
  "not clickable" — wrong).
- **Threat-Actor detail is already richly connected** — `active_campaigns`→
  `/campaigns/:id`, Targeted Brands→`/brands/:id`, plus a real recent-activity
  timeline + news mentions (recon called it "view-only, terminal" — wrong; G5 is
  largely already met).
- **The actual bug:** those Provider/Actor links pointed at `/providers/:id` and
  `/threat-actors/:id`, which **redirected to the bare list (dropping the id)**;
  and `/threats/:id` **had no route at all** (Campaign→Threat was a 404).

**Shipped fix (Slice A+B):**
1. `?focus=:id` deep-link on the Providers and Threat Actors lists — auto-expands
   + scrolls the target card (Threat Actors broadens past active-only so a
   dormant target still appears).
2. Rewrote the `/providers/:id` and `/threat-actors/:id` redirects to **carry the
   id as `?focus`** instead of dropping it — instantly resolving the existing
   Campaign→Provider and Brand→Actor pivots.
3. Seeded the Threats table from `?q=` and repointed Campaign→Threat at
   `/threats?q=<indicator>` (fixes the 404; the filtered table is the resolution
   since there's no single-threat route).

**Still open after this slice:** Brand→Provider/Campaign (brand detail doesn't
link *out* to those entities at all — needs a "providers/campaigns targeting this
brand" read, G3/G7); interactive campaign graph (G4); shared `EntityList` shell
(C1/G6); actor `motivation`/`active-since` (G5 remainder).
