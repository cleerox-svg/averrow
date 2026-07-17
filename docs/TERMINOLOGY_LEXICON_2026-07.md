# Averrow Terminology Lexicon — July 2026

**Source:** `docs/PLATFORM_ASSESSMENT_2026-07.md` §5. This is the concrete old→new naming
map + per-file remediation checklist to fix the terminology drift the assessment found.

**Guiding rules (from CLAUDE.md §9b/§13):**
- Internal agent code names are **internal** — they must not be the *primary* label on any
  customer-facing surface (marketing, tenant, public changelog).
- Customer copy is **global, straight threat-intelligence + brand-protection** — no
  aviation/military framing.
- Each core noun has **one canonical form**, applied consistently across ops/tenant/marketing.
- Menu/nav labels must **align to their actual signal/use/purpose** AND to DRP category +
  competitor nomenclature — so the product isn't "out of whack" with what buyers expect.

**How to read the tables:** "Keep" = unchanged. "→" = rename. A code name kept internally
still gets a single **customer-facing functional label** that *replaces* it on customer surfaces.

---

## 0. Rename-safety discipline — READ FIRST (non-negotiable)

Past terminology changes were done piecemeal, and the standing advice has been *"don't
rename backend names — it breaks things."* That advice is right about **structural
identifiers** and wrong as a blanket rule. Every candidate name below is classified by the
**layer it lives at**, because the safe move differs completely by layer:

| Class | What it is | Rename risk | Default action |
|---|---|---|---|
| **DISPLAY-SAFE** | UI label / menu / header / button text, marketing copy, `displayName`/`subtitle` metadata, doc/comment text | Low — no contract depends on it | **Rename freely** at the display layer |
| **STRUCTURAL** | DB table/column names, enum values in **CHECK constraints**, API **route paths**, JSON **response field names**, **`agent_id`** literals (thread through `agent_runs`/`agent_events`/`agent_configs`/cron dispatch/KV/diagnostics), **role strings** (JWT claims + CHECK constraints), KV/cache/notification/event **`type` keys** | **High** — silently orphans history, breaks contracts, or cascades FKs | **Keep the identifier; rename only the display** (alias). Touch it ONLY with a full occurrence trace + migration + a passing test that proves no breakage |
| **DELETE** | A display reference to something that doesn't exist (the Blackbox phantom) | Low | Remove the display references; no identifier exists |

**The rename protocol for anything not DISPLAY-SAFE:**
1. **Deep occurrence trace** — every site across all layers (DB, migrations, API, agent
   registry, KV keys, JWT, UI, marketing, tests, the averrow-mcp contract). This is
   produced in the companion **`docs/NAMING_RENAME_SAFETY_2026-07.md`** occurrence map.
2. **Prefer aliasing** — rename the human-visible string, keep the structural identifier.
   A structural rename is justified only when the identifier itself is customer-visible
   (e.g. a public API field) or actively misleading in code, and never for `agent_id` or
   role strings (historical `agent_runs` rows and CHECK/JWT coupling make those orphaning
   or FK-cascade hazards — see CLAUDE.md §7 on the `users` table rebuild).
3. **Migrate + test** — if a structural rename is truly required, it ships as its own
   migration with a `qa-verifier` gate: typecheck + `check:resource-drift` + the specific
   test that proves the renamed thing still dispatches / authorizes / groups / returns.
4. **One PR per coherent rename**, never scattered edits — so the change is reviewable and
   revertible as a unit.

The tables in §1–§6 below now carry a **rename-class** so each change is executed at the
right layer. The full per-name occurrence map lives in `NAMING_RENAME_SAFETY_2026-07.md`.

---

## 1. Agents — internal code name → single customer-facing functional label

Internal `agent_id`/code name stays in code, docs, and the ops mesh. On **customer**
surfaces, use **only** the functional label. The three factual errors are fixed here.

| Internal code name | Keep internally? | Customer-facing functional label | Notes / fix |
|---|---|---|---|
| Sentinel | Yes | **Threat Detection** | Certificate & domain surveillance |
| Analyst / **ASTRA** | Yes (`analyst`) | **Scoring & Triage** | Pick ONE customer label; today marketing uses "ASTRA," ops uses "Analyst." Use the functional label on customer surfaces; retire the raw code name there. |
| Observer | Yes | **Strategic Intel** | Daily briefings |
| Navigator | Yes | **DNS Resolution** (NOT "Geo Mapping") | **FIX:** marketing calls it geo-mapping; it only does DNS resolution + cube refresh. Geo/provider mapping is **Cartographer**. |
| Cartographer | Yes | **Geo & Provider Mapping** | This is the real geo agent — give it the geo label Navigator wrongly holds. |
| **Blackbox** | **No — delete** | *(none — phantom)* | **FIX:** no `blackbox` agent exists. Its described "Timeline & Narrative" job is done by **Narrator**/**Observer**. Also aviation framing (flight recorder). Remove from all customer surfaces; do not replace with a code name. |
| Narrator | Yes | **Timeline & Narrative** | The real owner of the "Blackbox" job. |
| Pathfinder | Yes (internal **sales**) | *(none — remove from customer surfaces)* | **FIX:** marketed as a customer-protection agent ("surfaces exposure before an incident"); it is actually an **internal sales lead-gen** tool aimed *at* prospects. Remove from the customer-facing agent roster entirely. |
| NEXUS | Yes | **Campaign / Infrastructure Clustering** | Surface this capability (unmarketed today). |
| Sparrow | Yes | **Takedown** (as a capability, not a named agent) | **FIX:** "Sparrow" leaks into the tenant takedown UI (`TakedownDetail.tsx:146`). Say "Averrow" or "our takedown system," not "Sparrow." |
| Strategist, Attributor, News Watcher, Flight Control, Curator, Watchdog, Mockingbird, Outrider, Marshal, Sounder, Herald, Recon, Sifter, Navigator-cron | Yes | *(not customer-exposed)* | Internal only; keep code names in ops/docs. Ensure none leak to customer copy. |

**"42 agents" claim:** retire as the *headline* differentiator (§6/C1). It may remain as a
supporting detail, but it is now category table-stakes messaging, not a moat.

---

## 2. Category label — pick one primary

The site oscillates across four framings; the industry term (**DRPS**) is absent.

| Old (in use) | New (canonical) |
|---|---|
| "AI-first threat intelligence" / "brand protection" / "brand threat intelligence" / "AI threat intelligence and brand protection" (varies by page) | **Primary:** "Digital Risk Protection" (DRPS) **+ brand protection.** **Sub-descriptor kept:** "AI threat intelligence." |

- Use "Digital Risk Protection" / "DRPS" in ≥1 prominent crawlable place + meta (C4/S1.4).
- Retain "AI threat intelligence & brand protection" as the human-readable tagline; add the
  category term for SEO/RFP discoverability.

---

## 3. Core nouns — one canonical form each

| Concept | Current variants (surface) | Canonical | Action |
|---|---|---|---|
| Alert object | `alerts` (DB/API/ops/marketing) vs **"Signals"** (tenant UI) vs `/alerts` (route) | **Pick one for the customer** — recommend **"Signals"** on the tenant (already chosen) but make it consistent: align the `/alerts` route label + marketing to the same word, OR revert tenant to "Alerts." Do not ship three names. | content-strategist + frontend-engineer |
| Brand score | exposure / trust / risk / reputation | **"Exposure Score"** (customer-facing, already dominant); keep `reputation_score` internal for providers only | content-strategist |
| Coordinated threat group | campaign / cluster / operation / infrastructure_cluster | **Customer-facing: "Campaign."** Internal: keep `infrastructure_clusters` table name; stop calling it "operation" in UI. | content-strategist |
| "Campaign" (overloaded ×3) | threat campaign / spam-trap seeding campaign / geopolitical_campaign | Disambiguate: **"Threat Campaign"**, **"Seeding Run"**, **"Geopolitical Campaign."** | backend-engineer + content-strategist |
| Case object | investigation / case | **"Investigation"** (customer-facing); stop mixing "case" in the UI. | frontend-engineer |
| Internal jargon | trust-radar / cockpit / cube / stuck_pile / Flight Control | Keep internal; **must not appear customer-facing.** Fix "cockpit" leak in `Console.tsx`. | frontend-engineer |

---

## 4. RBAC vocabulary — reduce the collisions

The model is sound; the vocabulary is a foot-gun (assessment S-area / RBAC lens).

| Collision | Problem | Recommended fix |
|---|---|---|
| `analyst` ×3 | global SOC role vs org investigator role vs agent display name | Brand the **global** staff roles `staff_*` at the type level (e.g. `staff_analyst`) **or** namespace the **org** roles `org_*` (`org_investigator`). Pick one plane to prefix. Lowest-risk: rename org roles at the type layer. |
| `admin` ×2 | global `admin` (level 4) vs org `admin` (level 3) | Same prefix fix as above resolves it. |
| `ORG_ROLE_HIERARCHY` defined twice | `middleware/auth.ts:438` + `handlers/tenantTrademarkModule.ts:32` drift risk | Export one shared constant; import both places. |
| "minted-only" | undocumented jargon spread across 3 comment blocks | One-line glossary entry: *"a valid `UserRole` no DB CHECK constraint will store; issued only via a mint endpoint."* |
| `auditor` stored as `analyst` | DB row misreads privilege | Document in the data (or remove the placeholder via the CHECK-relaxation maintenance window). Ties to security S2. |
| `retired` status | agents labeled retired are still callable | Rename the status concept or document per-agent that the CTA is intentionally live (assessment T6). |

---

## 5. Residual aviation/military framing to remove (customer surfaces)

| Term | Where | Action |
|---|---|---|
| "squadron" | `index.astro:140-142`; `platform.astro:26-37` (squadron-status/grid/row/name) | Rename to "agent mesh" / "detection agents." |
| "radar" sweep | `index.astro:34-52,520-537`; `platform.astro:68-92`; `resources/index.astro:43` | Replace the radar-sweep hero metaphor; keep only if reframed as neutral "live monitoring." |
| "Blackbox" | `index.astro:202`; `platform.astro:36,200-204`; `ai-agents.astro:39-42` | Delete (phantom + aviation) — see §1. |
| "cockpit" | tenant `Console.tsx:1,42` | Replace with "console" / "supervision view." |
| "in flight" / "in-flight" | `Console.tsx:49`; `Takedowns.tsx:84`; `Settings.tsx:294` | Acceptable (idiomatic English), note only. |

---

## 6. Leak-remediation checklist (marketing + tenant + changelog)

Concrete edit sites for Wave-1 sessions S1.1–S1.3. All paths under `packages/`.

**Marketing (`averrow-marketing/src/`):**
- `pages/index.astro:158-213` — homepage agent cards (Sentinel/ASTRA/Observer/Navigator/Blackbox/Pathfinder) → functional labels; drop Blackbox/Pathfinder.
- `pages/platform.astro:26-37,196-204` — "squadron" status grid + Blackbox narrative panel → rename squadron, drop Blackbox.
- `pages/platform/ai-agents.astro:13-73` — full agent profiles + `<meta description>` naming the six code names → functional labels; fix Navigator/Cartographer; remove Blackbox/Pathfinder.
- `pages/solutions/mid-market.astro:69-74,150-152` — agent rows + worked example → functional labels.
- `pages/docs/index.astro:54` — "42-agent mesh — Sentinel, ASTRA…" → de-emphasize count, use labels.
- `content/blog/ai-powered-threat-narratives.mdx:26-44` — "ASTRA agent", "Observer" → functional labels or generic.
- `data/changelog-entries.ts:75` — public changelog names "ASTRA agent" → remove code name (violates §9b).

**Tenant (`averrow-tenant/src/`):**
- `features/takedowns/TakedownDetail.tsx:146` — "Sparrow auto-submits" → "Averrow / our takedown system."
- `features/console/Console.tsx:1,42` — "cockpit" → "console."
- `layout/Sidebar.tsx:92-93` — "Radar" icon + "Signals" label → align with the chosen alert-noun; drop radar framing.

**Ops (`averrow-ops/src/`):**
- `lib/agent-metadata.ts` — reconcile `displayName`/`codename`/`subtitle` so the "codename" field is used consistently (today it holds a fancy alias for some, the raw id for others).

---

## 7. Ownership & sequencing

- Owners: **content-strategist** (copy + changelog), **web-copywriter** (page-length copy),
  **seo-strategist** (DRPS/meta), **frontend-engineer** (UI labels/routes),
  **backend-engineer** (noun disambiguation in data/agents), **docs-maintainer** (glossary).
- Sequenced in `docs/IMPROVEMENT_PLAN_2026-07.md` Wave 1 (S1.1–S1.6).
- **Verification:** after Wave 1, grep the customer surfaces for the internal code names
  (`Sentinel|ASTRA|Observer|Navigator|Blackbox|Pathfinder|Sparrow|squadron|cockpit`) and
  confirm zero primary-label hits; confirm one canonical noun per concept across surfaces.
