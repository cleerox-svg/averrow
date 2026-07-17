# Averrow Platform — Capabilities & Gaps Assessment — July 2026

**Scope:** Full code-level assessment of the Averrow platform (trust-radar Worker,
averrow-ops, averrow-tenant, averrow-marketing, averrow-mcp, shared) across four gap
dimensions — competitive/capability, technical/architecture, security/RBAC,
reliability/ops — plus a dedicated **terminology** audit and a **takedown standing-model**
verification. Commissioned to stress-test where the platform genuinely leads, where the
code falls short of the marketing, and where the vocabulary has drifted.

**Method:** Nine parallel read-only specialist lenses, every finding traced to a
file:line the reader can open:

1. Capability inventory & agent mesh
2. Terminology audit (internal↔customer naming)
3. Competitive landscape & positioning (live web research on 10 DRP peers)
4. Technical architecture & tech debt
5. Security posture (cross-checked vs live Cloudflare D1 state)
6. RBAC / auth model
7. Detection quality & threat-intel depth
8. Reliability / ops (ran the live `/api/internal/platform-diagnostics` 24h endpoint)
9. Takedown standing / authorization / prospect-surface verification

**Relationship to prior docs:** This assessment **supersedes**
`docs/PLATFORM_ASSESSMENT_2026-06.md`. It confirms most June findings, **corrects two**
(takedown maturity; restructure completion), and adds net-new findings (a live
agent-starvation gap, an RBAC read-only bypass, an internal-secret escalation path, the
full terminology audit, and the verified takedown standing model). Companion roadmap:
`docs/IMPROVEMENT_PLAN_2026-07.md`. Naming map: `docs/TERMINOLOGY_LEXICON_2026-07.md`.

---

## 1. Executive Verdict

**The platform is a broad, genuinely strong, remarkably low-cost Digital Risk Protection
engine whose weakest link is no longer its capability — it's the gap between what the
code does and what the platform says about itself.** Detection breadth, takedown
execution (correctly standing-gated), cost discipline, and the agent mesh are real and
largely production-grade. Three things hold it back: (1) a positioning/terminology layer
that misnames its own capabilities and leaks internal code names to customers; (2) a
headline differentiator ("identify WHO conducts attacks") the code does not yet deliver;
and (3) a small set of live operational and security sharp edges that are cheap to fix.

| Domain | Maturity | One-line verdict | Δ vs June |
|---|---|---|---|
| Feed ingestion | ★★★★☆ | ~45 feeds, live CertStream CT subscription, disciplined circuit breakers | = |
| Agent mesh / enrichment | ★★★★☆ | 7 production-grade agents; strong triage + Haiku-judge stack | = |
| Brand-protection detection | ★★★★☆ | Lookalike/CT/social/app-store/dark-web live; depth uneven | = |
| **Takedown execution + standing** | **★★★★☆** | **Live submitters + policy engine + signed per-org MSA; the sole dispatcher is correctly gated so no takedown can fire for a non-customer. Gaps are 1 integrity hole + 2 net-new surfaces (analyst hand-submit; Ops prospect view).** | **▲ up from ★★ — June was stale** |
| Threat-actor attribution | ★★☆☆☆ | External-label passthrough + <1% AI resolution; **the "WHO" claim is aspirational** | ▼ named for the first time |
| Email intel (spam trap / abuse mailbox / DMARC) | ★★★★☆ | Uncommon at this price point; a genuine differentiator | = |
| Multi-tenancy / tenant app | ★★★★☆ | Isolation solid; **but the customer SPA has zero tests** | = / ▼ |
| Cost architecture | ★★★★★ | Thesis proven (~85–90% margin); OLAP cubes + KV caches | = |
| Security / RBAC | ★★★☆☆ | Clean secrets & deps; **one internal-secret→admin escalation, one auditor read-only bypass** | ▼ new findings |
| Reliability / ops | ★★★☆☆ | Cron & breaker discipline sound; **a live starvation gap dropping ~67% of 3 scanners' runs** | ▼ new finding |
| Terminology / positioning | ★★☆☆☆ | Code names on the public site, a phantom agent, 3 wrong descriptions, no canonical category | ▼ first full audit |
| Documentation | ★★★☆☆ | Improving (S11 truth-up landed) but the June assessment itself went stale in 5 weeks | = |

**The cost thesis remains proven.** A single Professional customer at $1,499/mo covers
the entire estimated operating cost. The cost engineering (OLAP cubes, KV counter caches,
side-DB isolation, cursor-paginated reconcilers) is the platform's quiet superpower and
should be a *marketed* differentiator, not just an internal discipline.

---

## 2. Capability Inventory (deltas from the June inventory)

- **6 packages** (imprsn8 decommissioned 2026-07-12). Backend: 17 route modules, ~94
  handlers, ~45 feeds, ~43 agents. Staff SPA: ~30 feature areas. Customer SPA: 7
  entitlement modules (domain, social, app_store, dark_web, abuse_mailbox, trademark,
  threat_actor).
- **Detection surfaces confirmed live:** phishing/malicious-URL, lookalike/typosquat (8
  permutation classes + BIMI-on-lookalike escalation), CT monitoring (real-time
  CertStream Durable Object + homoglyph + 70-point phishing scoring), social
  impersonation (6 platforms), app-store impersonation (**iOS only**), dark web
  (Pastebin + ransomware DLS), trademark, email posture, spam trap, abuse mailbox, DMARC RUA.
- **Takedown is materially more built than June recorded, and correctly standing-gated** — see §3.6 and §7.
- **Passive DNS and cert-SAN identity are wired:** `feeds/circlPassiveDns.ts`, `lib/ssl-cert-identity.ts`.
- **AI usage is disciplined:** deterministic scoring (`lib/threatScoring.ts`), SQL
  corroboration (`lib/enrichment.ts:369-377`), AI confined to narrative + a cost-bounded
  triage judge (`lib/alert-ai-judge.ts`, ~$0.001/alert, auto-dismiss only at confidence ≥90).

---

## 3. Gap Register (four dimensions + takedown model)

Severity: **P0** = urgent/live or security-material · **P1** = high commercial or
correctness leverage · **P2** = important, not urgent · **P3** = hygiene. Owners map to
the sub-agent roster. Each row is actionable in `docs/IMPROVEMENT_PLAN_2026-07.md`.

### 3.1 Competitive / capability

| ID | Finding | Sev | Evidence | Owner |
|---|---|---|---|---|
| C1 | "Agent mesh" is no longer a differentiator — Group-IB markets "12 Specialist Agents orchestrated by Prevyn AI Command." | P1 | competitive research | content-strategist |
| C2 | No published takedown speed/volume/success metric, though execution is real and gated. Peers lead with 33-min median / 40K-mo / 98%. | P1 | `lib/takedown-submitters/*`; peer sites | content-strategist |
| C3 | Real capabilities unmarketed: infrastructure/campaign clustering (Doppel "Threat Graph" equivalent), executive-name monitoring, app-store monitoring. | P1 | `agents/nexus.ts`; marketing tree | content-strategist |
| C4 | Category term **DRPS / Digital Risk Protection appears nowhere on-site** — SEO + analyst-relations + RFP-keyword gap. | P1 | marketing grep | seo-strategist |
| C5 | Detection breadth gaps vs category: Google Play, IDN/punycode homoglyphs, WHOIS registrant/NS, forum/Telegram dark-web, page-render/visual phishing. | P2 | see §3.3 | threat-intel-analyst |
| C6 | "Campaign intelligence" is a paid-tier bullet with no definition/page anywhere on-site. | P2 | `pricing.astro:215` | content-strategist |

### 3.2 Security / RBAC

| ID | Finding | Sev | Evidence | Owner |
|---|---|---|---|---|
| S1 | **`mint-ui-preview-jwt` + a single shared `AVERROW_INTERNAL_SECRET` can mint an `admin`-mutation JWT** (≤4h) reaching ~58 `requireAdmin` endpoints. | P0 | `handlers/auth.ts:1047`; `index.ts:679-687`; `middleware/auth.ts:135` | backend-engineer → appsec-reviewer |
| S2 | **`auditor` read-only is a convention, not a mechanism** — level-3 hierarchy means bare `requireStaff`-gated *mutations* accept an `auditor` token. | P0 | `middleware/auth.ts:221-225`; `routes/brands.ts`, `routes/investigations.ts:23-35`, `routes/email-security.ts:42`, `routes/scan.ts:56` | backend-engineer → appsec-reviewer |
| S3 | `auditor`'s documented "sees ALL tenant data" is false — 9 `verifyOrgAccess` inner nets exempt only `super_admin` and 403 the auditor. | P1 | `handlers/tenantData.ts:17-21` (+8) | backend-engineer |
| S4 | `verifyOrgAccess` duplicated verbatim in ~9 handlers — cross-org-leak drift class. | P1 | 9 tenant\*Module handlers | backend-engineer |
| S5 | No blanket auth gate on `POST /api/internal/*` — 31 inline checks; a future forgotten one is exposed. | P2 | `index.ts:585-590` (GET only) | backend-engineer |
| S6 | Drift/hygiene: `LRX_API_KEY` undeclared in wrangler manifest; CORS omits live `lrxradar.com`; MCP TTL comment 90d vs 30d code. | P3 | `wrangler.toml:307-346`; `lib/cors.ts:10-17`; `averrow-mcp/src/index.ts:14-15` | docs-maintainer |

**Verified clean:** secret hygiene, dependency pinning, staging/dev D1 isolation (confirmed live). No remote-exploitable hole surfaced.

### 3.3 Detection depth

| ID | Finding | Sev | Evidence | Owner |
|---|---|---|---|---|
| D1 | **Threat-actor attribution is external-label passthrough, not fingerprinting.** OTX tags via ~50-entry alias map; AI attributor resolves <1%. | P1 (positioning-critical) | `lib/otx-attribution.ts:38-126`; `agents/attributor.ts:60-70` | threat-intel-analyst |
| D2 | NEXUS is single-attribute first-lane-wins `GROUP BY` — no connected-components, no transitive pivot chaining. | P2 | `agents/nexus.ts:426-429` | threat-intel-analyst |
| D3 | "pivot_detected" fires on a **volume-decay** heuristic, not infrastructure movement — mislabeled vs the marketing claim. | P2 | `nexus.ts:1070-1082` | threat-intel-analyst |
| D4 | **Cheap high-ROI win:** VirusTotal already returns `creation_date` and it's **discarded** — no "newly registered domain" signal, a category staple. | P1 | `feeds/virustotal.ts:58` | threat-intel-analyst |
| D5 | Absent category-standard fingerprinting: JA3/JARM, favicon hash, GA-ID pivot, DOM/phish-kit hashing. | P2 | `nexus.ts` lanes | threat-intel-analyst |
| D6 | No content-aware phishing analysis — no page fetch/screenshot/visual diff; classification is URL-path regex. | P2 | `threatScoring.ts:66,82` | threat-intel-analyst |
| D7 | Social = handle-squat detection not profile-content; app-store iOS-only; dark web narrow; IDN homoglyphs not generated (ASCII-only). | P2 | scanners/\*; `dnstwist.ts:122` | threat-intel-analyst |

**Genuinely strong (protect & market):** ~45 feeds incl. live CertStream; deterministic
scoring; the alert-triage + Haiku-judge stack; thoughtful lookalike detection.

### 3.4 Reliability / ops (live diagnostics, 24h)

| ID | Finding | Sev | Evidence | Owner |
|---|---|---|---|---|
| R1 | **LIVE starvation:** CT monitor / lookalike / trademark scan run inline at the tail of the hourly tick after a 153s Analyst await and **drop ~67% of runs** (8/24). | P0 | `orchestrator.ts:598-615`; live `agent_mesh` | backend-engineer |
| R2 | **`ct_monitor` has zero `agent_runs` telemetry** — FC's stall watchdog structurally can't see it fail. | P0 | `scanners/ct-monitor.ts` | backend-engineer |
| R3 | DNS-queue drift: live delta 8,851 rows (18× the 500 alert threshold) with no visible `platform_dns_queue_drift` notification. | P1 | `lib/dns-queue-reaper.ts`; `flightControl.ts:749-849` | backend-engineer / platform-sre |
| R4 | D1 read budget at 92.9% of daily plan. Watch. | P2 | live `d1_budget_state` | platform-sre |
| R5 | Doc/config drift: wrangler "15min CPU" vs `cpu_ms=300_000`; `ct-monitor.ts` "every 5 minutes" (actually hourly). | P3 | `wrangler.toml:290`; `ct-monitor.ts:6` | docs-maintainer |

**Verified sound:** cron-minute-gate discipline, feed breaker + reap-penalty + auto-pause, DNS-queue cursor/reconciler.

### 3.5 Technical / architecture

| ID | Finding | Sev | Evidence | Owner |
|---|---|---|---|---|
| T1 | **D1 discipline leaks on hot paths** — page-load handlers `GROUP BY` over the raw 113K-row `threats` table (the platform's own #1 red-flag rule). | P1 | `dashboard.ts:273/295`, `brands.ts:789/1125/1203`, `campaigns.ts:81/91`, `trends.ts:116/257/280` | backend-engineer |
| T2 | `averrow-tenant` (customer SPA) has **zero tests, no vitest config**. | P1 | package tree | test-engineer |
| T3 | `handlers/admin.ts` is **4,461 lines** — god-handler. | P2 | file | backend-engineer |
| T4 | Orchestrator cron-dispatch wiring (the 22h-outage path) has no direct test. | P2 | no test targets gates | test-engineer |
| T5 | Restructure R4/R7/R9 ~90% done with dead artifacts; R10 unstarted; `observatory` vs `observatory-v3` duplication. | P3 | `design-system/components/index.ts`; `components/mobile/*` | frontend-engineer |
| T6 | "Retired" agents mislead — 8 of 11 still wired to live handlers. `any` unenforced (193). | P3 | agent routes; ops SPA | backend-engineer |

**Verified clean:** migrations hygiene (237 sequential, additive), `@ts-ignore` = 0, backend test breadth strong (118 files).

### 3.6 Takedown standing & Ops-surface model (founder decision — verified against code)

**The governing principle (founder):** Averrow has **no legal standing** to submit a
takedown for a brand until that brand is a **customer with an assigned tenant/org that has
authorized** takedowns (auto or manual). Detecting signal ≠ authority to act. Ops
"Takedowns" is therefore **two surfaces**: (1) authorized execution for opted-in
customers, and (2) a **prospect/pitch surface** showing every signal that *would* qualify
for a brand, for sales demonstration.

**Verified current state — the principle is ~90% enforced already:**
- `org_brands` (join table, `migrations/0027_organizations_scim.sql:52-62`) is the clean
  customer-vs-prospect marker; `brands` is a global catalog with no ownership column.
- The **sole outbound dispatcher** is Sparrow Phase G (`agents/sparrow.ts:1097-1309`). It
  hard-excludes orgless brands (`org_id IS NOT NULL`, `:1108`) and requires: entitlement
  (`isModuleEnabled`), a **per-org signed MSA authorization** (`isModuleAuthorized`,
  `lib/takedown-authorizations.ts`), provider opt-in (`auto_submit_enabled`), and an
  `auto` policy decision (`evaluateTakedownPolicy`, `lib/takedown-policy.ts:132-147`).
  **No code path can dispatch a takedown for a non-customer.**
- Auto/semi-auto/off posture and the auto-vs-manual choice are stored **per tenant** on
  the signed scope (`scope_json.mode`) — exactly the founder's intent.

| ID | Finding | Sev | Evidence | Owner |
|---|---|---|---|---|
| TK1 | **Status-flip integrity hole** — `handleAdminUpdateTakedown` can stamp *any* takedown (incl. orgless/unauthorized) as `submitted` with **no standing check**; it misrepresents an unsent/unauthorized takedown as sent (no actual dispatch occurs). | P1 | `handlers/takedowns.ts:464-563` (esp. `:472-474,:494-498`) | backend-engineer → appsec-reviewer |
| TK2 | **No Averrow-analyst hand-submit path** for the "auto is on but this one needs a human" case. Primitives exist unused (`requireAuthorizationForModule` `takedown-authorizations.ts:286-297` + `dispatchSubmission` `takedown-submitters/index.ts:79`). | P1 (net-new) | absent | backend-engineer |
| TK3 | **Ops "Takedowns" is execution/tracking only — the prospect/pitch surface is net-new.** All ingredients exist (public exposure scan `brandScan.ts`/`scanReport.ts`; qualified-report agents; BrandDetail Risk tab; **orgless Sparrow drafts already in the admin queue** via `LEFT JOIN organizations`, `takedowns.ts:419-429`). Compose them into a per-brand "everything we'd action for you" lane. | P1 (net-new, mostly composition) | `features/takedowns/Takedowns.tsx`; `features/brands/BrandDetail.tsx` | frontend-engineer + backend-engineer |

**Framing correction this produces:** the takedown gap is **not** "execution isn't built"
(June) nor "just marketing" (draft July). It is: execution is built and correctly
standing-gated; the remaining work is **one integrity fix (TK1)** + **two mostly-compositional
surfaces (TK2 analyst hand-submit, TK3 prospect-pitch view).**

---

## 4. Competitive Matrix & Positioning

**Category:** Averrow is functionally a **Digital Risk Protection Services (DRPS)** vendor
(Gartner's term), between "brand protection" and "threat intelligence," targeting the
mid-market gap enterprise-priced incumbents leave open.

| Vendor | Self-category | Headline / differentiator | AI framing |
|---|---|---|---|
| Recorded Future | Threat intelligence | Breadth; analyst pedigree (Insikt) | AI = enrichment |
| ZeroFox | External cybersecurity / DRP | 180+ platforms; Discover→Validate→Disrupt; deepfake detection | AI + human validation |
| Bolster (CheckPhish) | AI brand protection | Free high-volume URL scanner (closest analog to Averrow's free scan) | AI = detection engine |
| Doppel | "Social Engineering Defense" | **Threat Graph**; one-click threat→training sim | Most AI-native |
| Netcraft | DRP | **33-min median takedown**; "Left of Live" | Speed = proof |
| BrandShield | Online brand protection | **98% takedown success**; logo/OCR/NLP | AI detects, humans verify |
| Corsearch | Trademark + brand protection | Legal/IP pedigree | Least AI-native |
| PhishLabs/Fortra | DRP Services (managed) | **40K+ takedowns/month**; 80+ partnerships | Analyst-curated |
| Group-IB | DRP + TI platform | **"12 Specialist Agents orchestrated by Prevyn AI Command"** | Multi-agent = headline |
| Memcyco | Real-time impersonation | User-level real-time clone detection; decoy credentials | Real-time signal eng. |

**What the market tells us:**
1. **Takedown metrics are the category's universal proof point** — Averrow *can* execute
   takedowns (standing-gated) but publishes none. Highest-leverage messaging gap.
2. **"We use an AI agent mesh" is now table-stakes**, not a moat (Group-IB).
3. **Human-in-the-loop validation** is the near-universal trust claim.

**Recommended positioning (feeds the lexicon & Wave 1):**
- Lead with the **DRPS** term (SEO/RFP) + "brand protection."
- Anchor the differentiator trio on what's defensible in code today: (a) the free,
  no-signup outside-in scan; (b) transparent **"SQL correlates, AI narrates"**; (c)
  **edge-native economics** (85–90% margin / mid-market price gap). Retire "42 agents" as
  the headline.
- **Surface, don't hide, real strengths:** standing-gated takedown execution (with a real
  metric once instrumented — C2), infrastructure/campaign clustering (C3), exec monitoring.

---

## 5. Terminology Audit (summary)

Full old→new map and per-file remediation checklist in
`docs/TERMINOLOGY_LEXICON_2026-07.md`. Headlines:

1. **Internal code names are the *primary* labels on the public marketing site** and in the
   public changelog — contradicting CLAUDE.md §13/§9b. They leak into tenant ("Sparrow"
   `TakedownDetail.tsx:146`; "cockpit" `Console.tsx`).
2. **"Blackbox" is a phantom agent** — no such agent exists; its job is done by
   Narrator/Observer. It is *also* aviation framing (flight recorder).
3. **Three customer-facing agent descriptions are factually wrong:** Navigator (marketed
   geo-mapping; actually DNS-only — geo is Cartographer); Pathfinder (marketed
   customer-protection; actually a **sales lead-gen** tool aimed *at* prospects);
   Blackbox↔Narrator.
4. **No canonical core nouns:** alert vs "Signals" (route still `/alerts`);
   exposure/trust/risk/reputation; "campaign" ×3; cluster/operation/campaign; investigation vs case.
5. **No settled category label** — four framings; DRPS absent.
6. **Residual aviation/military framing:** squadron, radar sweep, cockpit, Blackbox.
7. **RBAC vocabulary collisions:** `analyst` means three things; `admin` overloaded across
   two namespaces; "minted-only" undocumented; `ORG_ROLE_HIERARCHY` defined twice.

---

## 6. The Differentiator Decision (locked)

The "identify **WHO** conducts attacks" claim (CLAUDE.md §13) is **largely aspirational at
the code level** (D1–D3) — a positioning risk, not just a build backlog.

**Decision (confirmed with the founder): "re-anchor now, invest next."**
- **Now (Wave 1):** shift copy to the defensible differentiators; stop implying behavioral
  actor attribution the code doesn't do.
- **Next (Wave 2):** close the claim in ROI order — D4 (WHOIS creation-date, already on the
  wire) → favicon/JA3/JARM lanes + connected-components + real infra-movement pivots
  (D2/D3/D5) → page-content/visual phishing (D6) → breadth (C5/D7).

---

## 7. Corrections to the June 2026 Assessment

1. **Takedown maturity: ★★ → ★★★★, and the framing is now precise.** June called
   takedowns "~20% implemented — email drafts queued for manual send… the #1 competitive
   gap." Verified reality: live provider submitters (Google Web Risk, NetBeacon, GoDaddy),
   a per-org signed-MSA policy engine, and a **correctly standing-gated** sole dispatcher
   (Sparrow Phase G) that cannot fire for a non-customer. The residual work is TK1 (integrity
   fix), TK2 (analyst hand-submit, net-new), and TK3 (Ops prospect-pitch surface, net-new).
2. **Restructure completion overstated** — R4's Modal never shipped, R4/R7 deletions never
   happened, R9 has stragglers, and the tracker mis-implies `averrow-tenant` was in scope
   (it was not — the target was `averrow-ops`).
3. **New findings June did not surface:** live agent-starvation (R1/R2), the RBAC
   read-only bypass (S2), the internal-secret→admin escalation (S1), the full terminology
   audit (§5), and the verified takedown standing model (§3.6).

---

*Assessment produced 2026-07-17 via 9 parallel read-only specialist lenses. Every finding
carries a file:line for verification. Roadmap: `IMPROVEMENT_PLAN_2026-07.md`. Naming map:
`TERMINOLOGY_LEXICON_2026-07.md`.*
