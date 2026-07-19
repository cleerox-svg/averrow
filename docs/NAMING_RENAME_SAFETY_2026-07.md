# Naming Occurrence Map & Rename-Safety Review — July 2026

**Session:** Phase 4 / Wave 1, **S1.0** (`docs/IMPROVEMENT_PLAN_2026-07.md`).
**Status:** this document. Ships as a **doc, not code** — no deploy impact.
**Executes:** `docs/TERMINOLOGY_LEXICON_2026-07.md`. **Gated by:** the Phase 4
rename-safety protocol (`docs/DEPLOYMENT_PHASES_2026-07.md`).

> **This is the single gate S1.1–S1.6 execute from.** Those sessions do **not**
> re-decide any classification here — they apply it. Every candidate name below
> is classified so a downstream session knows, without re-investigating, whether
> a change is a free display-string swap or a structural identifier that requires
> the full protocol.

Assembled from four specialist traces (all read-only, all file:line-verified
against the live tree on 2026-07-19): **T1** code-layer/structural
(backend-engineer), **T2** auth/role-strings (appsec-reviewer), **T3** menu/nav
alignment (market-analyst), **T4** customer-surface display inventory
(content-strategist).

---

## 0. The governing rule (lexicon §0 / plan Wave-1 header)

**Default: rename the human-visible string, keep the identifier.** A **structural**
rename (an identifier a contract depends on) proceeds ONLY with: (a) the occurrence
trace below, (b) a migration, and (c) a `qa-verifier` proof it still
**dispatches / authorizes / groups / returns**. One PR per coherent rename.

### Classification legend

| Class | Meaning | How to touch it |
|---|---|---|
| **STRUCTURAL (keep)** | A contract depends on the literal; a rename orphans history / breaks dispatch / cascades. | **Do not rename.** The only safe change is a display string *elsewhere*. |
| **STRUCTURAL (protocol)** | An identifier, but a migration + qa gate can move it safely (precedent: `0081_pathfinder_rename.sql`). | Full protocol, own PR + additive migration. **None recommended for Wave 1.** |
| **DISPLAY-SAFE** | Label / copy / metadata. | Rename freely; one coherent PR. |
| **DELETE** | A display reference to a thing that does not exist. | Remove. |

---

## 1. What an `agent_id` rename actually costs (the precedent)

`migrations/0081_pathfinder_rename.sql` (prospector→pathfinder) is the authoritative
template and proves the blast radius of **any** `agent_id` rename. A rename must
UPDATE **every** row-store keyed on the literal or telemetry/history silently orphans:

- `agent_runs.agent_id`, `agent_outputs.agent_id`, `agent_activity_log.agent_id`,
  `budget_ledger.agent_id` (UPDATE)
- `agent_configs.agent_id` — **PRIMARY KEY** → DELETE-old + INSERT-new (resets the
  circuit breaker)
- `agent_approvals.agent_id` — **PRIMARY KEY**, live deployment gate. **This is the
  exact trap S0.1 hit**: `ct_monitor` was registered with no `agent_approvals` row,
  so `executeAgent` blocked every run (`migrations/0238_ct_monitor_approval.sql`).
  A rename that misses this table silently kills the renamed agent.
- `agent_events.source_agent` / `target_agent` string literals (see §4)
- provenance columns (e.g. `sales_leads.identified_by='pathfinder_agent'`) and KV
  throttle keys (e.g. `pathfinder:last_run`)

**Proof-of-no-breakage test for any `agent_id` rename:** after the migration the
agent (a) writes an `agent_runs` row on its next cron fire, (b) has `agent_configs`
`enabled=1` + `agent_approvals` `state='approved'` PK rows under the new id, (c)
appears in `platform-diagnostics` `agent_mesh.per_agent[]` with continuous history,
(d) leaves no orphaned old-id rows. Because diagnostics does a bare `GROUP BY
agent_id` with no allowlist, a half-done rename shows as **two** rows (old + new) —
that split is the failure signal.

**Conclusion: no `agent_id` is renamed in Wave 1.** All are STRUCTURAL (keep). The
customer-facing change is always a display label elsewhere.

---

## 2. Per-name occurrence map

For each name: the structural sites that pin the identifier (keep), and the
display sites to change. File:line verified by the cited trace.

### Agent code names → functional labels (identifier kept; display swapped)

Registry keys are the runtime dispatch identifiers
(`agents/index.ts`; `agentModules[event.target_agent]` at `orchestrator.ts:715`) —
**all STRUCTURAL (keep)**. Display column = the label S1.1/S1.2 apply.

| Code name | `agent_id` (STRUCTURAL keep) | Functional label (DISPLAY) | Display-leak count (T4) | Notes |
|---|---|---|---|---|
| Sentinel | `sentinel` (index.ts:66) | **Threat Detection** | 15 (marketing) | Exclude third-party "Microsoft Sentinel" (partners/mssp/getting-started) — **do not touch**. |
| ASTRA / Analyst | `analyst` (index.ts:67) | **Scoring & Triage** | 10 | Incl. **public-changelog leak** `changelog-entries.ts:75` (violates §9b). ops `agent-metadata.ts:131` `codename:'ASTRA'` is the only genuine alias. |
| Observer | `observer` (index.ts:70) | **Strategic Intel** | 19 | Heaviest real-feature use — pricing table (`pricing.astro:122,207`), solutions, blog. Highest S1.1 priority. |
| Navigator | `navigator` (index.ts:87) | **DNS Resolution** | 6 — **all WRONG** | Marketing labels it "Geo Mapping"/"PLOTTING" and describes geo (`ai-agents.astro:33,36`). Navigator = DNS resolution + cube refresh. **Geo is Cartographer's** — S1.2 fix. ops metadata already correct (`agent-metadata.ts:83`). |
| Cartographer | `cartographer` (index.ts:68) | **Geo & Provider Mapping** | **0** | No customer surface today. Should *receive* the geo card Navigator wrongly holds. |
| Narrator | `narrator` (index.ts:78) | **Timeline & Narrative** | 0 | Real owner of the "Blackbox"-described job (`agent-metadata.ts:25`). |
| NEXUS | `nexus` (index.ts:73) | **Campaign / Infrastructure Clustering** | 2 (tenant) — **new** | `ThreatActor.tsx:37,230` "NEXUS cluster fingerprints/matches" → "infrastructure-clustering". Not phantom; a real clustering agent. Found by T4, not in the original leak list. |
| Sparrow | `sparrow` (index.ts:72) | **Takedown** (capability, not named) | 1 (tenant) | Confirmed leak `TakedownDetail.tsx:146` "Sparrow auto-submits" → "Averrow auto-submits". |
| Pathfinder | `pathfinder` (index.ts:71) | **remove from customer surfaces** | 8 | Internal sales lead-gen tool. The customer-protection **mis-framing** is pinned to `ai-agents.astro:48`. Staff surface `ops /leads` (`Leads.tsx:890`) is correct to keep — averrow-ops is staff-only. |
| Strategist | `strategist` (index.ts:69) | (internal) | 0 | Clean. |

Internal-only display names in ops metadata ("Mockingbird"/"Herald"/"Recon"/
"Watchtower"/"Sifter" for social_monitor/trademark_monitor/auto_seeder/ct_monitor/
abuse_mailbox_classifier) are **staff-only** (averrow-ops) — permitted; the only risk
is a leak to customer copy (none found; S1.1 watch item).

**Not in the registry — will be missed by an `agents/index.ts` grep alone (both
STRUCTURAL keep):** `fast_tick` (historical `agent_runs.agent_id` for the navigator
cron, threaded through diagnostics `cron_health` + MCP allowlist) and `daily_briefing`
(handler-dispatched writer via `withBriefingRun`, `handlers/briefing.ts`).

### Blackbox → **DELETE** (phantom)

No `blackbox` `agent_id` / table / column / route / event exists anywhere (T1 + T4
confirmed). **11 display occurrences, all marketing, all DELETE:** `index.astro:202-204`,
`platform.astro:36,200,204`, `solutions/mid-market.astro:73`, `ai-agents.astro:39,42,73,272,276`,
`docs/index.astro:54`. The real owner of its "Timeline & Narrative" job is `narrator`.
**Exception:** `public/app.js` names Blackbox but is **frozen** (CLAUDE.md §3) — leave it.

### Aviation / military framing (DISPLAY-SAFE, marketing only)

- **"squadron"** — 9 sites, class names + CSS + the live agent-status panel (`platform.astro:26-37`
  with visible "SCANNING/SCORING/WATCHING/PLOTTING/RECORDING/SEEKING" state words). Rename
  selectors to `agent-mesh`/`agent-status`; neutralize the state words.
- **"radar" (sweep metaphor)** — 9 sites, decorative hero visuals (`index.astro:34,52`;
  `platform.astro:68-92`; `resources/index.astro:43` icon key). Ties to the legacy
  "Trust Radar" name (CLAUDE.md §13 rebrand). See the `/alerts` icon note in §4.
- **"cockpit"** — confirmed leak `Console.tsx:42` (live tenant subcopy) → "console". (+ `:1` comment.)
- **"in flight" / "in-flight"** — idiomatic, **acceptable per lexicon**, no action
  (`Console.tsx:49`, `Takedowns.tsx:84`, `Settings.tsx:294`, `takedown-msa.ts:40`). Note
  `BrandDomainFindings.tsx:319` renders it from the **enum value `in_flight`** — that's
  STRUCTURAL (keep the enum), display is fine.

### Role strings (auth) — **all STRUCTURAL (keep); zero Wave-1 renames** (T2)

Every global role (`super_admin, admin, analyst, sales, support, billing, auditor,
client`) and org role (`viewer, analyst, admin, owner`) is simultaneously a JWT claim
value and — for the four global values in the prod CHECK (`0002_auth_tables.sql:10,34`)
— a CHECK enum literal; org values are additionally live stored rows with no CHECK to
migrate against. A rename is an **invisible auth change**, not a `tsc` error.

- The lexicon §4 `staff_*` / `org_*` prefix ideas are **UNSAFE / deferred, owner-gated**:
  they require a CHECK relaxation + `users`/`invitations` table rebuild (D1 FK-cascade
  hazard, CLAUDE.md §7) + JWT re-issue. The §4 framing of org-prefix as "lowest-risk /
  type-layer" is **misleading** — org roles are persisted + in the JWT `org_role` claim,
  so a type-only rename compiles clean while desyncing every stored row/token.
- Wave-1-safe from §4: **documentation/glossary only** (the minted-only `auditor` note,
  the auditor-stored-as-`analyst` placeholder note). The `ORG_ROLE_HIERARCHY` dedup
  (`middleware/auth.ts:474` + `handlers/tenantTrademarkModule.ts:32`, byte-identical) is a
  values-preserved refactor for the normal build/QA gate — **not** this rename lane.

**Owner flags (not rename targets, surfaced by T2):** (1) `sales`/`support`/`billing`
are in `VALID_ROLES` (`invites.ts:14-16`) but **absent from the `users.role`/
`invitations.role` CHECK** — an invite would pass the app gate then fail at INSERT
(de-facto minted-only, undocumented). (2) the duplicated `ORG_ROLE_HIERARCHY` above.

### Core nouns — identifier vs display

| Concept | Identifier (STRUCTURAL keep) | Display decision | Sites to touch |
|---|---|---|---|
| **alert / signal** | `alerts` table, `alert_type`/`status`/`severity` cols, `/api/alerts*` + `/api/orgs/:orgId/alerts` routes, `data[]` JSON field names, MCP paths | Tenant + ops **already render "Signals"** consistently (see §3). Keep route/table/enum. | display already done; the open item is the **icon** (§3) + the platform-wide "Signals vs Alerts" voice decision (§3, content-strategist). |
| **campaign** (×3 senses) | `campaigns` table + `status` CHECK `('active','dormant','disrupted')` (`0001:48`), `campaign_id` FK, `infrastructure_clusters` table | Customer word "Campaign"; **stop "operation" in UI**. Disambiguate Threat Campaign / Seeding Run ("Spam Trap" — good) / Geopolitical Campaign. | ops `Campaigns.tsx:721,750,754` "Active/Threat Actor/NEXUS … Operations" → "Campaigns" (net-new S1.3 item, T3). |
| **cluster** | `infrastructure_clusters` table (kept) | "cluster" as a descriptive noun is fine; only the "NEXUS" prefix leaks (§ NEXUS above). | — |
| **investigation** | `investigations`/`investigation_items`/`investigation_notes` tables (free-text status) | Canonical "Investigation" — **stop mixing "case"**. | tenant `Investigations.tsx:37` "into a case" → "investigation" (T4). |
| **exposure score** | (no `exposure_score` DB column found; provider `reputation_score` is internal) | "Exposure Score" is already the dominant customer display — DISPLAY-SAFE. | none confirmed under the literal; S1.x broader grep if exact sites needed. |

**Critical `/alerts` rule for S1.3:** display = "Signals" (DISPLAY-SAFE); identifier =
`alerts` / `alert_type` / `/api/alerts` (STRUCTURAL keep). `alerts` has **no CHECK** on
`status`/`severity`/`alert_type`, so a value rename fails **silently** in the triage
switch (`lib/alert-triage.ts`), not loudly at the DB — treat the value set as a de-facto
enum and **do not rename it**.

---

## 3. The `/alerts` collision (T3)

Not a tenant-vs-ops disagreement — **both apps already render "Signals" everywhere**
(tenant `Sidebar.tsx:94` + `Alerts.tsx:81`; ops `Sidebar.tsx:152` + `Alerts.tsx:896`;
ops `MobileNav.tsx:29,53`). The mismatch is **within one concept across three layers**:
route/API/DB noun = "alert", human noun = "Signal", icon = `Radar` (a third, unrelated
metaphor). The `Alerts.tsx:1-7` comment calling this a tenant-only choice is **stale** —
ops adopted "Signals" independently.

| Layer | Value | Class |
|---|---|---|
| Route `/alerts`, table `alerts`, `/api/orgs/:orgId/alerts` | keep | **STRUCTURAL** |
| Nav label + in-page title "Signals" | display | **DISPLAY-SAFE** |
| Nav icon `Radar` | display | **DISPLAY-SAFE** |

**Recommendation (ranked):**
1. **Default (low-churn):** keep "Signals"; **swap the `Radar` icon → `Bell`/`AlertTriangle`**
   in both apps. "Signals" is already consistent in 5+ places; `Radar` maps to neither
   word and is the residual aviation/"Trust Radar" glyph the lexicon targets (§5). One
   near-free DISPLAY-SAFE change; bundle with the cockpit + NEXUS-Operations fixes as one
   S1.1/S1.2 PR.
2. **Alternative (content-strategist decision, own wave):** revert to "Alerts"
   platform-wide. Web-verified category convention favors "Alerts" (ZeroFox "Alerts",
   Recorded Future "Playbook Alerts", Bolster "Live Detections"; none use "Signals"). More
   buyer-recognizable and collapses the noun to one word, but touches 5+ DISPLAY-SAFE sites.
   A legitimate voice-vs-category call — **not pre-decided here.**

---

## 4. Menu / nav alignment table (T3)

**34 of 44 nav items are already aligned.** No nav **label** carries an agent code
name or aviation word (verified across both sidebars + ops `MobileNav`). Open items:

| Finding | Class | Owner / wave |
|---|---|---|
| `/alerts` icon `Radar` → `Bell`/`AlertTriangle` (both apps) | DISPLAY-SAFE | frontend-engineer, S1.1/S1.2 (bundle w/ cockpit + NEXUS-Operations) |
| "Signals" vs "Alerts" platform-wide relabel | DISPLAY-SAFE, wide blast radius | content-strategist, own wave — not bundled |
| `Console.tsx:42` "cockpit" subtitle → "console" | DISPLAY-SAFE | S1.1 |
| `Campaigns.tsx:721,750,754` "Operations" under a "Campaigns" nav item | DISPLAY-SAFE | fold into S1.3 (net-new) |
| Icon dups: `Crosshair` (Threats/Threat Actors), `Globe` (Overview/Domain/Observatory), `Target` (Leads/Attribution Backlog) | cosmetic, not naming | design-reviewer, low priority |
| Everything else (34/44) | aligned | none |

Full per-item detail: tenant `layout/Sidebar.tsx` (Workspace/Modules/Account), ops
`components/layout/Sidebar.tsx` (Intelligence/Response/Platform) + `layouts/MobileNav.tsx`.
"Observatory" (ops) is a strong, buyer-neutral label — keep. "Leads"/Pathfinder is
correct on the staff-only ops surface — keep.

---

## 5. Top-line summary for S1.1–S1.6

**DISPLAY-SAFE — the bulk of Wave 1 (rename freely, one coherent PR per surface):**
all marketing/tenant/ops **labels, copy, headings, changelog prose**, `displayName`/
`subtitle`/`codename` metadata. This is where every code-name→functional-label swap,
the Blackbox deletions, the Navigator geo-fix, the Sparrow/cockpit/NEXUS leak fixes,
and the noun canonicalization live.

**STRUCTURAL (keep) — never rename in Wave 1:** every `agent_id`; every role string;
DB tables/columns + CHECK enums (`campaigns.status`, `infrastructure_clusters`,
investigation/alert value sets); API route paths (`/alerts`) + JSON response field
names; event/notification `type` keys (`pivot_detected` is a 3-literal coupling —
`event_type` + `target_agent='observer'` + the `observer` module key — the single most
fragile rename on the platform); `averrow-mcp` schema fields/paths.

**DELETE:** the 11 Blackbox display references (except frozen `public/app.js`).

**Confirmed known leaks:** Sparrow `TakedownDetail.tsx:146`; cockpit `Console.tsx:42`;
Blackbox 11× marketing; `/alerts` icon/label. **New leaks found this trace:** ASTRA
public changelog `changelog-entries.ts:75`; NEXUS `ThreatActor.tsx:37,230`; ops
Campaigns "Operations" language; case/investigation mix `Investigations.tsx:37`.

**S1.1–S1.6 sequencing** (one PR per coherent change; structural renames — none
planned — carry their own migration + qa gate):

| Session | Scope | Depends on | Note |
|---|---|---|---|
| **S1.1** | Purge code names from customer surfaces; kill Blackbox; fix Sparrow/cockpit/NEXUS leaks | S1.0 | Coordinate w/ S1.2 on shared marketing files (`ai-agents.astro`, `platform.astro`). |
| **S1.2** | Fix 3 wrong descriptions: Navigator=DNS (not geo), Pathfinder off customer surfaces, Blackbox→Narrator | S1.0 | Overlaps S1.1 marketing files → run as one coordinated marketing lane. |
| **S1.3** | Canonicalize nouns (alert/signal, campaign, cluster, investigation); align `/alerts` **label** (keep route); Campaigns "Operations"→"Campaigns" | S1.0 | Display only. |
| **S1.4** | DRPS category label + SEO meta | S1.0 (T3 nomenclature) | Parallel-safe (metadata-only). |
| **S1.5** | Surface unmarketed capabilities | S1.0; **blocked on S2.1** for any takedown metric | Publish no takedown number until instrumented. |
| **S1.6** | Re-anchor differentiator (off "42 agents") | S1.0 | Parallel-safe w/ S1.4. |

**Overall Wave-1 verification (Phase-4 go/no-go):** grep all customer surfaces for
`Sentinel|ASTRA|Observer|Navigator|Blackbox|Pathfinder|Sparrow|squadron|cockpit` →
**zero primary-label hits** (excluding "Microsoft Sentinel"); one canonical noun per
concept; `design-reviewer` confirms token + light/dark parity on changed surfaces;
**no `agent_id`/DB/route/role/`type`-key rename shipped without its protocol artifact.**
