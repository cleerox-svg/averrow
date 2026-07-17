# Averrow Improvement Plan — July 2026

**Source:** `docs/PLATFORM_ASSESSMENT_2026-07.md` (2026-07-17, nine parallel code-level
lenses). Supersedes the open items of `docs/IMPROVEMENT_PLAN_2026-06.md`.

**Goal:** Close the gap between what the code does and what the platform says about
itself — fixing live operational/security sharp edges first, then re-anchoring positioning
and terminology, then closing the differentiator claim — while preserving the
minimal-cost operating model.

**Format:** Waves of PR-sized sessions. Each session = one branch + one draft PR, follows
CLAUDE.md standards (tsc clean, `check:resource-drift`, tests, `agent_runs`/`agent_events`,
prepared statements, cubes/pre-computed columns over raw scans) and the default build
pipeline (plan → build → test → verify → review → ship).

**Status legend:** ⬜ not started · 🟡 in progress · ✅ landed

## Working agreement — human-in-the-loop gates (unchanged from June)

No session is built without explicit scope approval. Anything that sends external traffic
(takedown dispatch, GSB/APWG submissions, customer digests) ships **dark behind a config
flag, default off** — the owner flips it. Always the owner's call: pricing/billing,
MSA/legal text, anything sent to a customer or third party, agent retirement/promotion,
external service signups. **Every gap ID below (C#, S#, D#, R#, T#, TK#) maps to the
identically-named row in the assessment's §3.**

---

## Wave 0 — Urgent / live / security-material (days, high certainty)

The assessment surfaced live-firing and security-material issues that are small, bounded,
and high-confidence. These go first.

### S0.1 — Kill the live agent starvation (R1 + R2) ⬜
**Owner:** backend-engineer → qa-verifier. CT monitor, lookalike scanner, and trademark
scan run inline at the tail of the hourly orchestrator tick and drop ~67% of runs.
- Give each a **dedicated cron** using the exact `event.cron`-match template already used
  by enricher/cartographer/greynoise/seclookup/strategist/sparrow/social/brand-scores
  (`cron/orchestrator.ts`, `wrangler.toml`). Audit minute-gates per the cron-audit rule.
- Wrap `runCTMonitor` in `executeAgent` so `ct_monitor` writes `agent_runs` and becomes
  visible to Flight Control's stall watchdog (`scanners/ct-monitor.ts`).
- **Verify:** re-run `./scripts/platform-diagnostics.sh 24` after a full day; lookalike +
  trademark should show 24/24, `ct_monitor` should have `agent_runs` rows.

### S0.2 — DNS-queue drift root-cause + fix (R3) ⬜
**Owner:** backend-engineer / platform-sre. Live delta 8,851 rows (18× the FC alert
threshold) with no visible `platform_dns_queue_drift` notification.
- Trigger `POST /api/internal/dns-queue/reap`, inspect the `ReaperResult`
  (`softCapHit`/`batchesFailed`/`staleRemoved`) for soft-cap truncation
  (`lib/dns-queue-reaper.ts`, `REAPER_SOFT_CAP_MS`).
- Confirm whether `platform_dns_queue_drift` is firing-but-deduped (`todayKey()` group
  key) or genuinely never firing despite the crossed threshold (`flightControl.ts:749-849`).

### S0.3 — Security P0: decouple the internal-secret escalation (S1 + S2) ⬜
**Owner:** backend-engineer → appsec-reviewer. Two convergent findings, one root area.
- **S1:** drop `admin` from `UI_PREVIEW_STAFF_ROLES` (`handlers/auth.ts:1047`; default is
  already read-only `auditor`), and/or gate the two mint endpoints behind a **separate,
  more tightly-held secret** than the diagnostics/agent-trigger `AVERROW_INTERNAL_SECRET`
  so a diagnostics token can't be upgraded to admin.
- **S2:** make `auditor` read-only a **mechanism, not a convention** — move every
  `requireStaff`-gated *mutation* behind a `StaffPermission` flag (`auditor` holds no
  edit/manage flags), or give `auditor` its own hierarchy tier below the staff quartet and
  convert `requireStaff` to a role-set membership test. Audit
  `routes/brands.ts`/`investigations.ts`/`email-security.ts`/`scan.ts`.

### S0.4 — D1 hot-path discipline (T1) ⬜
**Owner:** backend-engineer → qa-verifier. Swap the 9 page-load `GROUP BY`-over-threats
aggregates to the matching cube / pre-computed column (`providers.ts` already does it
right): `dashboard.ts:273/295`, `brands.ts:789/1125/1203`, `campaigns.ts:81/91`,
`trends.ts:116/257/280`. **Verify** row counts match the old queries before/after.

### S0.5 — Takedown status-flip integrity fix (TK1) ⬜
**Owner:** backend-engineer → appsec-reviewer. `handleAdminUpdateTakedown`
(`handlers/takedowns.ts:464-563`) can stamp *any* takedown — including orgless/unauthorized —
as `submitted` with no standing check. Gate the `draft→submitted` transition on an owning
org (`org_brands`) + an active per-org authorization, or forbid the manual `submitted`
status entirely unless it accompanies a real dispatch record. This makes the takedown
audit trail truthful.

---

## Wave 1 — Terminology & positioning re-anchor (1–2 wks, high commercial leverage, low code risk)

Executes `docs/TERMINOLOGY_LEXICON_2026-07.md` and the "re-anchor now" half of the
differentiator decision. Mostly copy/config; low blast radius; high commercial upside.

> **Rename-safety gate (applies to every session in this wave).** Per the founder
> directive and lexicon §0: **display-layer renames only, unless a structural rename passes
> the full protocol.** No `agent_id`, DB table/column, API route, role string, or
> notification/event `type` key is renamed without (a) the deep occurrence trace in
> `docs/NAMING_RENAME_SAFETY_2026-07.md`, (b) a migration, and (c) a `qa-verifier` gate
> proving the renamed thing still dispatches/authorizes/groups/returns. Default is
> **rename the human-visible string, keep the identifier.** One PR per coherent rename.

### S1.0 — Naming occurrence map & rename-safety review (prerequisite for S1.1–S1.3) ⬜
**Owner:** backend-engineer + appsec-reviewer + market-analyst → docs-maintainer.
Produce `docs/NAMING_RENAME_SAFETY_2026-07.md` — the per-name occurrence map across every
layer (DB, migrations, API, `agent_id`, KV/JWT/`type` keys, ops UI, tenant UI, marketing,
tests, averrow-mcp), each classified DISPLAY-SAFE / STRUCTURAL / DELETE, with the safe
execution path and the exact test that proves no breakage. Also produce the **menu/nav
alignment table** (each ops + tenant nav item → does the label match its signal/purpose →
recommended label aligned to DRP category + competitor nomenclature). S1.1–S1.3 execute
FROM this map; they do not re-decide it.

### S1.1 — Purge internal code names from customer surfaces (§5.1–5.2) ⬜
**Owner:** content-strategist + frontend-engineer. Remove Sentinel/ASTRA/Observer/
Navigator/**Blackbox**/Pathfinder as *primary* labels from the marketing site and the
public changelog; replace with the single functional labels from the lexicon. Kill the
**Blackbox phantom** entirely. Fix the tenant leaks ("Sparrow" `TakedownDetail.tsx:146`,
"cockpit" `Console.tsx`).

### S1.2 — Fix the three wrong agent descriptions (§5.3) ⬜
**Owner:** content-strategist. Navigator (DNS resolution, not geo — geo is Cartographer);
remove Pathfinder from *customer-protection* framing entirely (it is an internal sales
tool); reconcile Blackbox→Narrator/Observer.

### S1.3 — Canonicalize core nouns (§5.4) ⬜
**Owner:** content-strategist + frontend-engineer. Pick one term each (alert|signal,
exposure score, campaign, cluster, investigation) per the lexicon and apply across
ops/tenant/marketing; align the `/alerts` route label with its chosen noun.

### S1.4 — Adopt the DRPS category label + SEO (C4) ⬜
**Owner:** seo-strategist + content-strategist. Work "Digital Risk Protection / DRPS" into
meta descriptions and ≥1 prominent on-page mention without displacing brand voice.

### S1.5 — Surface real, unmarketed capabilities (C2, C3, C6) ⬜
**Owner:** content-strategist + web-copywriter. Name and explain: **standing-gated takedown
execution** (with a real metric once S2.x instruments it), infrastructure/campaign
clustering (a "Threat Graph" equivalent), executive-name monitoring, and a defined
`/platform/campaign-intelligence` page. **Do not publish any takedown speed/volume/success
number until engineering confirms it** (see S2.1).

### S1.6 — Re-anchor the differentiator trio (§6, C1) ⬜
**Owner:** content-strategist. Shift homepage/platform emphasis off "42 agents" onto the
free scan + transparency + edge-native price/cost story. Stop implying behavioral
actor-attribution.

---

## Wave 2 — Takedown surfaces + close the differentiator claim (invest half of "both")

### S2.1 — Takedown metrics instrumentation (C2 prerequisite) ⬜
**Owner:** backend-engineer. Compute submission→resolution time, monthly volume, and
success rate from `takedown_submissions`. Expose to ops; gate any *public* number behind
owner sign-off. Unblocks the S1.5 marketing claim with a real figure.

### S2.2 — Averrow-analyst hand-submit path (TK2) ⬜
**Owner:** backend-engineer → appsec-reviewer. Build one authenticated ops endpoint
(gated on `manage_takedowns`) that re-runs Phase G's per-row standing checks
(`requireAuthorizationForModule` + entitlement + provider resolve) then calls
`dispatchSubmission` — a single-takedown, human-triggered Phase G for the "auto is on but
this one needs a human" case. Ships dark behind the existing `TAKEDOWN_SEND_MODE` gate.

### S2.3 — Ops "Takedowns" → two surfaces (TK3) ⬜
**Owner:** frontend-engineer + backend-engineer. Split the Ops takedown feature by purpose:
1. **Authorized execution** — the current SOC tracking/queue view (opted-in customers).
2. **Prospect / pitch lane** — a per-brand "everything we'd action for you" view composing
   existing ingredients: the orgless Sparrow drafts already in `/api/admin/takedowns`
   (`takedowns.ts:419-429`), BrandDetail's Risk tab, and the exposure-scan/qualified-report
   engines. Mostly composition — no new detection. This is the sales-demonstration artifact.

### S2.4 — Detection depth, ROI order (D4 → D2/D3/D5 → D6 → C5/D7) ⬜
**Owner:** threat-intel-analyst + backend-engineer. Sequenced:
1. **D4 — "newly registered domain" signal** from the VirusTotal `creation_date` already
   on the wire (`feeds/virustotal.ts:58`). Cheapest, highest-ROI.
2. **D2/D3/D5** — favicon-hash + JA3/JARM NEXUS lanes; convert clustering to
   connected-components; make `pivot_detected` fire on real infrastructure movement.
3. **D6** — page-content/visual phishing analysis.
4. **C5/D7** — breadth: Google Play parity, IDN/punycode homoglyphs, WHOIS registrant/NS,
   forum/Telegram dark-web.

---

## Wave 3 — Debt & hardening (P2/P3)

- **S3.1 (S3+S4)** — extract one shared `verifyOrgAccess` into `middleware/auth.ts`;
  reconcile the outer/inner org-net exemption sets (single "who is global-read" predicate).
- **S3.2 (S5, S6)** — blanket auth guard for `POST /api/internal/*`; declare `LRX_API_KEY`
  in the wrangler manifest; add `lrxradar.com` to CORS; fix the MCP TTL comment.
- **S3.3 (T2)** — stand up vitest for `averrow-tenant`; smoke-test billing + signals first.
- **S3.4 (T3, T4)** — split `handlers/admin.ts` by domain; unit-test the orchestrator
  hour-gate dispatch table.
- **S3.5 (T5, T6)** — finish R4/R7/R9 cleanup (ship-or-drop Modal; delete Dropdown/
  BottomSheet/`components/mobile`; migrate the 2 token stragglers); decide `observatory`
  vs `observatory-v3` before R10; either remove the retired-agent dispatch handlers or
  document each live CTA; scope an ESLint `no-explicit-any` gate to non-frozen dirs.
- **S3.6 (R4, R5)** — track the D1 read-budget trend; fix the wrangler CPU-limit and
  ct-monitor docblock drift.

---

## Sequencing notes

- **Wave 0 is independent and parallelizable** — five disjoint-file sessions, fan out.
- **Wave 1** is copy/config heavy and can run alongside Wave 0 (different owners).
- **S2.1 blocks the public takedown metric in S1.5** — instrument before you market.
- **S2.2/S2.3 depend on the standing model staying intact** — do TK1 (S0.5) first so the
  audit trail is truthful before new submit paths are added.
- External/owner-gated (carried from June): APWG membership, Google Web Risk quota, Stripe
  products, MSA legal review.
