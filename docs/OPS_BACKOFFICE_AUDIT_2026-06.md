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

### 4.7 Implementation note — shared `EntityListShell` (C1 / G6 shipped)

Verifying the four lists in code corrected the control matrix the recon implied:

| Control | Brands | Providers | Threat Actors | Campaigns |
|---|---|---|---|---|
| Search | ✓ | ✓ | **✗ → now ✓** | ✓ |
| Sort | ✓ | ✓ | **✗ → now ✓** | ✓ |
| Pagination | ✓ | ✗ | **✗ → now ✓** | **✗ → now ✓** |

(Campaigns already had search+sort — only pagination was missing; Threat Actors
had only a country filter.)

**Shipped:** a shared `EntityListShell<T>` (`components/ui/EntityListShell.tsx`,
exported from the design-system barrel) that owns the three inconsistent
controls — client-side **search**, **sort**, **pagination** — plus result count,
skeleton grid, and empty state, while each entity keeps its **bespoke card**
(`renderItem`) and **server-side/segment filters** (passed through to the same
`FilterBar`). It supports `focusKey` so deep-links still page to + expand the
target card.

**Migrated:** Threat Actors (gains search + sort + pagination; focus deep-link
preserved via a frame-polled scroll) and the Campaigns "Active Campaigns" section
(gains pagination; search/sort now shared). Providers and Brands already have
richer server-side list flows and were left as-is — the shell is available for
them to adopt in a later pass without a forced rewrite. No card renderer or
frozen sparkline was touched.

### 4.8 Implementation note — Brand outbound pivots (G3 / G7 shipped)

The last open edges in the entity graph. Verifying in code: the endpoints
`/api/brands/:id/providers` and `/api/brands/:id/campaigns` **already existed**
*and* `useBrandFullDetail` **already fetched both** — but BrandDetail never
rendered them, so the data was loaded and thrown away.

**Shipped:** an "Attacking infrastructure" section on the Brand **Risk** tab
(two columns: Hosting providers + Linked campaigns) whose rows link OUT —
providers to `/providers?focus=:id` (the inline auto-expand from §4.6),
campaigns to `/campaigns/:id`. Hidden entirely when a brand has no
provider/campaign attribution so it adds no noise. Pure UI wiring — no new
endpoint, no backend change.

**Pivot graph status:** Brand now pivots out to **Actor** (existing) +
**Provider** + **Campaign**; Campaign↔Brand/Provider/Actor and Actor↔Campaign/
Brand all resolve; Provider/Actor are deep-link targets. The four-entity graph
is connected. Remaining Batch-1 items are enhancements, not dead-ends:
interactive campaign graph (G4) and actor `motivation`/`active-since` (G5).

### 4.9 Implementation note — interactive campaign graph (G4 shipped)

The Doppel/ZeroFox "threat graph" capability. The Campaign detail page showed
infrastructure as three disconnected tables (providers / IPs / domains); this
adds a **connected node-link view** of the same data so the *shape* of the
operation is visible.

**Shipped:** `CampaignGraph` (`features/campaigns/CampaignGraph.tsx`) — a custom
SVG radial graph (no graph-lib dependency, in the platform's bespoke-SVG
tradition). Infra fans right (campaign → provider → IP → domain), brands arc
left; capped fan-out per tier keeps dense campaigns legible; hovering a node
highlights its connected edges. Nodes are **clickable and pivot into the rest
of the entity graph** — provider → `/providers?focus=:id`, brand →
`/brands/:id`, IP/domain → `/threats?q=<indicator>` — so the graph isn't a
dead-end visualization but an entry point to the same drill-downs. Rendered on
Campaign detail above the existing tables (graph = overview, tables = detail);
built entirely from data the page already fetched — no backend change.

**Batch 1 now complete** except the minor actor `motivation`/`active-since`
fields (G5).

_Follow-up:_ the graph was static (desktop hover-highlight only). Added a subtle
entrance fade, a breathing pulse on the campaign node, animated flow on
highlighted edges, and **tap-to-select on touch** (first tap reveals the label +
highlights, second tap pivots) so the IP/domain labels and the highlight are
reachable without a mouse.

---

## 5. Batch 2 — Working queues (Threats · Alerts/Signals · Intelligence)

The surfaces where SOC analysts spend the day. Status: 🔄 in progress.

### 5.1 Competitor benchmark — what a triage queue is expected to do

Reference set: **Microsoft Sentinel** (Incidents), **Splunk ES** (Notable
Events), **Google Chronicle/SecOps** (Cases), **Expel**, **Swimlane**, **Torq**,
plus the CTI vendors from §2. The recurring theme: a queue isn't a list — it's a
**prioritized, ownable, enrichable workflow** that tells an analyst *what to work
next* and lets them act in bulk.

| # | Expected capability | Source / precedent |
|---|---|---|
| W1 | **Severity-then-age prioritization** — order by severity, then oldest-first within a severity; an explicit "work next" signal. | Sentinel/Splunk triage; SOC L1 guides |
| W2 | **Status lifecycle + ownership** — assign-to-self → In Progress → Resolved; case management groups related alerts and tracks investigation status. | Sentinel Incidents, Chronicle Cases |
| W3 | **Bulk actions** — select-all + bulk status / acknowledge / dismiss / suppress, so analysts clear noise in one gesture. | Splunk Notable Events, Chronicle |
| W4 | **Dedup + grouping** — collapse identical/recurrent alerts in a time window; correlate incoming IOCs against active alerts. | Springer CTI dedup, Sentinel correlation |
| W5 | **Risk scoring / "likely to matter"** — a real-time score that estimates whether an event matters, drives ordering. | Dropzone, Swimlane, StrangeBee |
| W6 | **Saved views / smart filters** — save the Crit+High filter and return to it; tag-by-SLA/client to auto-route into queues. | Chronicle saved filters |
| W7 | **Inline enrichment** — every alert pre-enriched with TI/asset/history so the analyst doesn't manually look up (saves 3–5 min/alert). | Torq, Expel lifecycle |
| W8 | **SLA / aging indicators** — visible age + SLA-breach warning per severity (Crit 15m, High 1h, Med 4h, Low 24h). | SOC SLA standards |
| W9 | **Assignment + notes/comments** — assign to an analyst, attach notes / a comment thread / evidence to a case. | Chronicle Cases, Sentinel |

> Platform context to check against the UI: Trust-Radar already has rule-based
> **alert auto-triage** (`lib/alert-triage.ts`), an **AI judge**
> (`lib/alert-ai-judge.ts` — Haiku verdict + confidence), and backfill endpoints
> (`POST /api/admin/alerts/backfill-triage`, `…/run-ai-judge`). The open question
> is how much of this (triage reasons, AI assessment, auto-dismissed counts) the
> Alerts UI actually surfaces vs. backend-only — directly relevant to W5/W7.

### 5.2 Sources

- [Strike48 — Alert Triage guide](https://www.strike48.com/post/alert-triage) · [CyberDefenders — Alert Triage Process](https://cyberdefenders.org/blog/alert-triage-process/) · [Expel — SOC alert lifecycle](https://expel.com/cyberspeak/what-does-the-soc-alert-lifecycle-look-like/)
- [Google Chronicle/SecOps — Triage and respond to cases](https://docs.cloud.google.com/chronicle/docs/secops/respond-cases)
- [Dropzone — Alert Triage guide](https://www.dropzone.ai/glossary/alert-triage-in-2025-the-complete-guide-to-90-faster-investigations) · [Swimlane — AI Alert Triage](https://swimlane.com/blog/ai-alert-triage/) · [StrangeBee — incident prioritization](https://strangebee.com/blog/security-incident-prioritization-proven-methods-to-improve-alert-triage/) · [Torq — alert fatigue](https://torq.io/blog/cybersecurity-alert-fatigue/)
- [Springer — Reducing alert fatigue via CTI correlation & dedup](https://link.springer.com/chapter/10.1007/978-3-032-19540-1_2)

### 5.3 Inventory & gap analysis

Recon of `features/threats/Threats.tsx` (+ shared `threats-table`),
`features/alerts/Alerts.tsx`, `features/trends/Trends.tsx` and their endpoints.

**Capability matrix vs the W1–W9 benchmark:**

| W | Capability | Threats | Alerts/Signals | Intelligence/Trends |
|---|---|---|---|---|
| W1 | severity + **age** ordering | severity sort ✓ · no age | severity sort ✓ · no age | n/a (briefing) |
| W2 | status lifecycle + **ownership** | **no status action ✗** | new→ack→resolved/FP ✓ · no owner | n/a |
| W3 | bulk actions | **none ✗** | ack-all + bulk-takedown ✓ | n/a |
| W4 | dedup / grouping | flat list | brand-grouped ✓ | n/a |
| W5 | risk scoring | confidence in detail only | AI verdict badges ✓ | n/a |
| W6 | saved / smart views | **none** (URL state only) ✗ | **none ✗** | n/a |
| W7 | inline enrichment | rich ✓✓ | partial (AI assessment) | n/a |
| W8 | **SLA / aging** | **none ✗** | **none ✗** | n/a |
| W9 | assignment + notes | **none ✗** | notes ✓ · no assignment | n/a |

**Per-surface read:**
- **Threats** is a **read-only catalog** with strong situational dashboards
  (slice summary, hero tiles, surging signals, leaderboards) + rich per-row
  enrichment + pivots to Brand/Actor — but **no triage mutation** (statuses
  `active/down/remediated` exist and a `PATCH /api/threats/:id` reportedly
  exists, yet nothing in the UI changes a threat's state).
- **Alerts/Signals** is the real **triage queue**: per-alert
  new→ack→resolved/false_positive, **bulk** acknowledge + create-takedown,
  notes, and AI-judge verdict badges. Missing the queue-ergonomics layer.
- **Intelligence/Trends** is a **read-only briefing dashboard**, not a queue —
  appropriate for its purpose; the "Intelligence"→`/trends` label/route
  mismatch (F-B) persists.

**Gap table (severity-ranked):**

| # | Gap | Benchmark | Backend exists? | Severity |
|---|---|---|---|---|
| GQ1 | **No SLA / aging anywhere** — an acknowledged alert can sit for weeks with no visual warning; no "work next by age". | W1/W8 | `created_at` present | **High** |
| GQ2 | **Threats has no triage action** — can't mark down/remediated/false-positive from the UI. (NB: threat status is largely machine-managed — confirm intent before adding operator mutation.) | W2 | `PATCH /api/threats/:id` (verify) | High |
| GQ3 | **No saved / smart views** — every session starts fresh; can't pin "new high-sev app-store impers". | W6 | — | Medium |
| GQ4 | **Auto-triage is invisible in the queue** — backend computes rule/AI dismissals + reasons (`run-ai-judge`, `backfill-triage`) but the UI shows no summary ("N auto-dismissed by rule, M by AI"), and the AI-verdict filter is client-side over a 200-row cap. | W5/W7 | stats from admin endpoints | Medium |
| GQ5 | **No assignment / ownership** — neither surface lets an analyst claim or route work. | W2/W9 | needs `assigned_to` column | Medium |
| GQ6 | **Alert→source-threat dead-end** — when `source_type='threat'` the detail shows the threat's technique but won't pivot to the threat. | W4/E2 | join exists | Medium |
| GQ7 | `Intelligence` nav label → `/trends` mismatch (carryover F-B). | — | — | Low |

**Recommended slice order:**
1. **Slice A — SLA/aging on the Alerts queue (GQ1).** Per-severity SLA (Crit 15m
   · High 1h · Med 4h · Low 24h) from `created_at` while unresolved; an
   age/SLA chip per row (within → approaching → breached) + a "breaching first"
   sort/filter. Pure client-side, no backend. The single most-cited SOC queue
   capability, currently absent. *Highest leverage, lowest risk.*
2. **Slice B — Alert→threat pivot + triage transparency (GQ6/GQ4).** Link the
   alert detail to its source threat; surface a small auto-triage summary line.
3. **Slice C — Saved views (GQ3).** localStorage-backed named filter sets on
   Alerts (and Threats), reusing the existing filter state.
4. **(Bigger, needs backend) Slice D — assignment/ownership (GQ5)** and **Slice E
   — operator threat triage (GQ2, pending intent check).**

> Slice A is the clear first ship. Slices D/E touch schema or platform intent
> and should be confirmed before building.

### 5.4 Implementation note — SLA / aging on the Alerts queue (Slice A, GQ1 shipped)

The W8 gap: an open alert could sit indefinitely with no visual urgency. Added,
pure client-side from `created_at` (no backend, no schema change):

- **Per-severity SLA windows** — Crit 15m · High 1h · Med 4h · Low 24h — measured
  while an alert is open (`new`/`acknowledged`); resolved/dismissed have no SLA.
- **Per-row chip** — open alerts approaching their window show `Due {t}` (amber),
  past it show `Overdue {t}` (red). Calm by default: nothing until ≥75% of the
  window is spent.
- **Breach banner** — counts open alerts past SLA (+ how many are approaching),
  with a one-click "Show breached".
- **SLA filter pill** — All / At risk / Breached, same client-side scope as the AI
  verdict filter.

Remaining Batch-2 slices: B (alert→threat pivot + triage transparency), C (saved
views), D/E (assignment, operator threat triage — need backend/intent check).

### 5.5 Implementation note — Alert pivots + triage transparency (Slice B, GQ4/GQ6 shipped)

Two of the recon's alert dead-ends, fixed pure-frontend:

- **Detail had no outbound pivots** (GQ6). Added: the brand name/favicon now links
  to `/brands/:id`, plus a "View brand's threats →" link to
  `/threats?brand_id=:id`. (A link to the *specific* source threat still isn't
  possible — there's no single-threat route and `?q=` searches domain/IP not id;
  the brand-threat slice is the resolving pivot.)
- **Auto-triage was invisible** (GQ4). The dismissal reason
  (`resolution_notes`, e.g. "auto: matches brand official handle") was only shown
  for *resolved* alerts — so auto-**dismissed** alerts vanished with no visible
  reason. Now shown for dismissed too, with an **"Auto-triaged"** badge when the
  reason is machine-stamped.
- **Bug fix:** the detail header hardcoded a "Social Impersonation" badge on
  *every* alert; now renders the real `alert_type` (App Store / Phishing / BIMI…)
  and the actual `source_type`.

GQ4's queue-level summary ("N auto-dismissed by rule vs AI") and GQ6's
specific-threat link remain open (the latter needs a threat-focus/search-by-id,
same constraint as Batch 1).

### 5.6 Implementation note — Saved views on the Alerts queue (Slice C, GQ3 shipped)

W6 (saved/smart views) was absent — every session rebuilt filters from scratch.
Added a localStorage-backed **Views** bar on the Alerts queue:

- A generic `useSavedViews<T>(key)` hook (`hooks/useSavedViews.ts`) following the
  codebase localStorage convention (SSR guard, try/catch, cross-tab sync).
- A view captures the **full operator filter state** — severity, status, type,
  search, AI verdict, and SLA.
- **Built-in presets** (Breaching SLA · New·Critical · AI: Threat) cover common
  triage entry points; **user views** persist per-device and are deletable.
- The active view highlights when the current filters match it; "+ Save current"
  is disabled until at least one filter is set.

Reusable on the Threats queue later via the same hook. Remaining Batch-2:
D/E (assignment, operator threat-triage) — schema/intent, pending confirmation.

### 5.7 Implementation note — Operator threat-triage (Slice E, GQ2 shipped)

Intent check first (the recon flagged threats as "machine-managed"): the
`PATCH /api/threats/:id` handler exists, is **requireAdmin**-gated, accepts
`status`, and manual status writes already happen elsewhere
(`handlers/brands.ts` bulk-remediate, `agents/curator.ts` false-positive). So
operator triage is **consistent with platform intent** — the catalog just never
exposed it in the UI.

**Shipped:** admin-gated triage buttons in the Threats detail slot
(`renderExtraDetail`) — **Mark remediated · False positive · Re-open** — reusing
the existing endpoint, no shared-table edit. Gated to admins because the
endpoint is `requireAdmin` (analysts would 403; relaxing that is a separate
permission decision). The list query carries a 5-min server cache, so the
mutation does an **optimistic in-place status update** and reconciles on settle.

Batch-2 remaining: D — assignment/ownership (GQ5, needs an additive
`assigned_to` column).

### 5.8 Implementation note — Alert assignment / ownership (Slice D, GQ5 shipped)

W9 (assignment) — neither queue let an analyst claim work. Discovery: the
`assigned_to`/`assigned_at` columns **already existed** (migration 0221, added
for the *tenant* analyst queue) and the list already returned them via
`SELECT a.*` — but the ops side had no write path or UI, and the tenant endpoint
(`/api/orgs/:orgId/alerts/:alertId`) already supports assignment. So this brings
the **ops** Signals queue to parity:

- **Backend:** `PATCH /api/alerts/:id` now accepts `assigned_to` (a users.id, or
  `null` to unassign; stamps `assigned_at`) in addition to / instead of `status`
  (status no longer required). The list SELECTs join `users` for
  `assigned_to_name`/`assigned_to_email`.
- **Frontend:** an **Owner** row in the alert detail (Assign to me / Take over /
  Unassign), an owner chip on each row (initials, or "You"), and a **Mine**
  toggle to filter to signals you own. No migration (column pre-existed).

**Batch 2 complete** — all of GQ1–GQ6 addressed (GQ7 is the cosmetic
Intelligence-label carryover). Open follow-ups noted earlier: specific
alert→threat link + queue-level auto-triage summary (both need small backend
additions).

### 5.9 Carryover cleanups (GQ7 + the GQ4/GQ6 follow-ups closed)

- **GQ7 / F-B — `Intelligence` label/route mismatch.** The nav item "Intelligence"
  pointed to `/trends` and sat inside the section *also* named INTELLIGENCE, while
  the page's own `<h1>` said "Intelligence". Renamed nav label **and** page title
  to **Trends** (route-consistent; `/intelligence` alias kept for bookmarks).
- **GQ6 — specific alert→threat link.** Extended `/api/threats` so `?q=` matches an
  exact threat `id` (in addition to the indicator LIKEs), then added a **"View
  source threat →"** link in the alert detail when `source_type='threat'`. The
  earlier "no single-threat route" limitation is resolved via the filtered table.
- **GQ4 — queue-level auto-triage summary.** Added `auto_dismissed` to
  `/api/alerts/stats` (false_positive rows stamped `auto…`) and a caption under the
  Signals stat grid: "Auto-triage cleared N of M dismissed signals (X%)".

With this, **all of Batch 2's GQ1–GQ7 are addressed.**

---

## 6. Batch 3 — Automation (Agents · Approvals · Architect)

How operators observe and control the AI agent mesh. Status: 🔄 in progress.

### 6.1 Competitor benchmark — agent observability + orchestration control

Reference set: **LangSmith**, **Langfuse**, **AgentOps**, **Arize/Phoenix**,
**Braintrust**, **Datadog LLM Observability**, plus multi-agent orchestration /
HITL guidance. Theme: a multi-agent system needs a **control plane** — not just
a status list — that makes each agent observable (traces, cost, errors),
controllable (pause/trigger/breaker), and gated where risk is high (human-in-the-
loop approval).

| # | Expected capability | Source / precedent |
|---|---|---|
| A1 | **Per-agent health dashboard** — run counts, success/failure + error rate, last run, avg/p95 latency, per-agent token usage. | Langfuse/LangSmith dashboards (uptime·latency·error·cost) |
| A2 | **Run history + traces** — drill into a run: input → LLM calls → tool calls → output, with error messages; session/replay view. | LangSmith node-by-node traces, AgentOps session replay |
| A3 | **Cost per agent / per successful task** — token × model pricing, cost visibility per agent and per outcome. | "cost per successful task" (DEV/Braintrust) |
| A4 | **Health + stalled/anomaly detection** — stuck runs, agent-specific anomalies, alerting on failure spikes. | AgentOps anomaly detection; dashboards surface stalled |
| A5 | **Lifecycle control plane** — pause/resume, manual trigger, retry/terminate from the UI (not just an internal endpoint). | orchestration lifecycle (start/fail/retry/terminate) |
| A6 | **Circuit-breaker visibility + control** — breaker state (open/closed), failure threshold, toggle. | circuit-breaker pattern (N fails / M min) |
| A7 | **Human-in-the-loop approval** — approve/reject/request-changes checkpoints, **discoverable**, triggered by confidence/risk. | HITL layered model (in-loop / on-loop) |
| A8 | **Orchestration/lane visibility** — which agent dispatches which, dispatch source (cron vs event), event lanes. | multi-agent routing/context-flow |

> Platform context to score against: Trust-Radar already has deep telemetry —
> `agent_runs`, `agent_events`, `agent_outputs`, `agent_configs.enabled`
> (circuit-breaker), and `/api/internal/platform-diagnostics` (per-agent
> total_runs/success/failed/running/last_error/avg_duration_ms/dispatch_source,
> `stalled[]`, `ai_spend_24h`). The audit question is **how much of this reaches
> the operator-facing Agents UI vs. lives only in the internal diagnostics
> endpoint** — and whether the breaker/manual-trigger are UI-controllable
> (A5/A6) or internal-only. Also: Approvals/Review/Architect are **orphaned**
> (not in nav — Batch-1 F-C), a direct A7 discoverability hit.

### 6.2 Sources

- [Latitude — best agent observability tools 2026](https://latitude.so/blog/best-ai-agent-observability-tools-2026-comparison) · [Confident AI — best AI agent observability 2026](https://www.confident-ai.com/knowledge-base/compare/best-ai-agent-observability-tools-2026) · [aimultiple — agentic monitoring](https://aimultiple.com/agentic-monitoring)
- [LangSmith observability](https://www.langchain.com/langsmith/observability) · [Langfuse — agent observability](https://langfuse.com/blog/2024-07-ai-agent-observability-with-langfuse) · [Arize — best observability for autonomous agents 2026](https://arize.com/blog/best-ai-observability-tools-for-autonomous-agents-in-2026/)
- [DEV — what is agent observability (traces, loop rate, cost per successful task)](https://dev.to/mostafa_ibrahim_774fe947b/what-is-agent-observability-traces-loop-rate-tool-errors-and-cost-per-successful-task-bl5) · [groundcover — AI agent observability guide](https://www.groundcover.com/learn/observability/ai-agent-observability)
- [Elementum — human-in-the-loop agentic AI](https://www.elementum.ai/blog/human-in-the-loop-agentic-ai) · [MindStudio — agent orchestration](https://www.mindstudio.ai/blog/agent-orchestration-biggest-unsolved-problem-ai-stack)

### 6.3 Inventory & gap analysis

Recon of `features/agents/{Agents,AgentApprovals,AgentReview,ArchitectDetail,AgentConfig}.tsx`
+ handlers `agents.ts` / `agent-approvals.ts` / diagnostics.

**Capability matrix vs A1–A8:**

| # | Capability | State |
|---|---|---|
| A1 | per-agent health dashboard | **Strong** — 24h jobs/outputs/errors, hourly charts, recent_ticks, last-run, circuit_state, dispatch_source, network view |
| A2 | run history + traces | **Partial** — detail shows recent outputs + last error; run-history endpoint exists; **no per-run trace/logs/tokens/model** |
| A3 | cost per agent | **Weak** — token-usage + `ai_spend_24h` + budget-vs-cap all **exist as endpoints but aren't on the Agents UI** (ai_spend only in internal diagnostics; budget is super_admin-only) |
| A4 | stalled / anomaly | **Partial** — circuit_state shown; **`stalled[]` only in `/platform-diagnostics`** (internal), not operator-facing |
| A5 | lifecycle control plane | **Backend-only** — `trigger` / `toggle` / `reset-circuit` / `threshold` endpoints exist (requireAdmin) but **no buttons on the grid/detail** (trigger only on the orphaned AgentConfig page) |
| A6 | circuit-breaker control | **Backend-only** — breaker state is *shown* but **can't be reset/paused from the UI** |
| A7 | human-in-the-loop approval | **Exists but orphaned** — approve/reject/request-changes work; reached only via a banner on /agents or direct URL |
| A8 | orchestration/lane visibility | **Partial** — TRIGGER_CHAIN is **hardcoded** in the component, not driven by live dispatch data |

**Gap table (severity-ranked):**

| # | Gap | Benchmark | Backend exists? | Severity |
|---|---|---|---|---|
| GA1 | **Control plane not wired to the UI** — operator sees a tripped breaker / failing agent but can't **trigger / pause-resume / reset-circuit** from the Agents detail. All endpoints exist (requireAdmin). | A5/A6 | ✅ `trigger`,`toggle`,`reset-circuit`,`threshold` | **Critical** |
| GA2 | **Cost/budget invisible on the Agents UI** — per-agent tokens, 24h $ spend, and budget-vs-cap exist but aren't surfaced where operators look. | A3 | ✅ `token-usage`, `ai_spend_24h`, module-metadata | High |
| GA3 | **Orphaned automation surfaces** — Architect + AgentConfig are URL-only; Approvals only via a conditional banner. | A7/F-C | ✅ routes exist | Medium-High |
| GA4 | **Stalled runs not operator-visible** — only in the internal `/platform-diagnostics`. | A4 | ✅ diagnostics computes it | Medium |
| GA5 | **No per-run trace/log/token drill-down** — detail stops at last-error + recent outputs. | A2 | ⚠️ per-run tokens in DB, not returned | Medium |

**Headline:** like Batch 1/2, the top gap is **UI wiring on endpoints that already
exist** — GA1 is the flagship: the entire admin control plane
(trigger/pause/resume/reset-breaker) is built and tested server-side but has no
buttons where an operator would use it.

**Recommended slice order:**
1. **Slice A — Wire the agent control plane (GA1).** Admin-gated **Trigger now ·
   Pause/Resume · Reset circuit** controls in the agent detail panel, reusing the
   existing `requireAdmin` endpoints. Highest leverage, lowest risk.
2. **Slice B — Surface cost on the Agents UI (GA2).** Per-agent token usage / 24h
   spend in the detail (and a cost signal on the card).
3. **Slice C — Discoverability (GA3).** Nav entries (or an Agents-page tab) for
   Approvals / Architect / Config so they're not URL-only.
4. **Slice D — Stalled-runs surface (GA4).** Operator-facing stalled list.

> Slice A is the clear first ship — it turns a read-only dashboard into an actual
> control plane using machinery that already exists.

### 6.4 Implementation note — Agent control plane wired to the UI (Slice A, GA1 shipped)

The flagship gap: the admin control plane existed entirely server-side
(`/api/agents/:name/{trigger,toggle,reset-circuit}`, all requireAdmin) but had
no buttons where operators look — they could *see* a tripped breaker and not
reset it.

- **Frontend:** an admin-gated **Controls** bar in the agent detail panel —
  **Trigger now**, **Pause/Resume** (shows Resume when `circuit_state ===
  'manual_pause'`), and **Reset circuit** (only when `tripped`). Reuses the
  existing `useTriggerAgent`/`useResetAgentCircuit` hooks; added the missing
  `useToggleAgent`. Gated to admin (the endpoints are requireAdmin).
- **Backend:** the three mutation handlers now **bust the `agents_list:v4` KV
  cache** (it's cached 5 min) so the action reflects immediately instead of
  looking like a no-op for minutes.

Remaining Batch-3 slices: B (surface cost — GA2), C (discoverability of the
orphaned Approvals/Architect/Config — GA3), D (operator stalled-runs — GA4).

### 6.5 Implementation note — Token usage on the Agents UI (Slice B, GA2 partial)

A2/A3 said cost should be visible per agent. The `/api/agents/token-usage`
endpoint (all-time per-agent input/output/total tokens + runs-with-tokens)
existed but wasn't surfaced on the Agents page. Added a **Token usage** block to
the agent detail panel (Total · In·Out · Runs-with-AI), via the existing
`useAgentTokenUsage` hook — pure frontend.

Scope note: **$ cost** isn't shown — the only cost-in-dollars figures
(`ai_spend_24h`, budget-vs-cap) live behind super_admin/internal endpoints, and
deriving $ from tokens needs a per-model pricing dimension. Tokens are the cost
driver and the standard observability metric, so this is the honest staff-level
view; a true cost-$ panel would need the pricing dimension wired in (follow-up).

Remaining Batch-3: C (discoverability — GA3), D (stalled runs — GA4).

### 6.6 Implementation note — Discoverability + stalled runs (Slices C+D, GA3/GA4 shipped)

- **GA3 — orphaned surfaces.** Added **Approvals** (super_admin) and **Architect**
  (admin) link buttons to the Agents page header, so the two routed orphans are
  reachable without knowing the URL. (`AgentConfig.tsx` has **no route at all**
  and its trigger/threshold function now overlaps the Slice-A control bar, so it
  was intentionally not surfaced.)
- **GA4 — stalled runs.** A **stalled-runs banner** on the Agents page: runs
  stuck in `running` >15min, computed client-side from
  `useAgentRuns({status:'running'})` (the same signal the internal diagnostics
  computes, now operator-facing) — agent id + how long ago it started.

**Batch 3 complete** — GA1 (control plane), GA2 (token usage), GA3
(discoverability), GA4 (stalled runs). GA5 (per-run trace/token drill-down)
remains as a deeper follow-up.
