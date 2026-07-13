# Claude Code Sub-Agents — Roster & Operating Model

**What this is:** the definitions and guardrails for the **Claude Code
sub-agents** we use to *build and maintain* the Averrow platform. These are
development agents (specialist Claude Code personas), **not** the platform's
internal AI agents (Sentinel / Nexus / Observer / Cartographer / Navigator /
Pathfinder…). To avoid confusion these are named by *function*, never by a
platform codename.

- **Runnable definitions:** `.claude/agents/*.md` — one file per agent, with
  frontmatter (`name`, `description`, `tools`, `model`) and a system prompt that
  bakes in the relevant `CLAUDE.md` guardrails.
- **This doc:** the human-readable overview — who does what, who owns which
  guardrails, and how the orchestrator delegates.

The main Claude Code session is the **orchestrator**. It delegates scoped work to
the sub-agent whose charter fits, then keeps the conclusion. Sub-agents run with
their own context and only the tools their charter grants.

---

## Roster at a glance

| Agent | Category | Owns | Model | Writes code? |
|---|---|---|---|---|
| `backend-engineer` | Software dev | Workers, D1, internal agents, feeds, cron (`trust-radar`, `averrow-mcp`) | opus | ✅ |
| `frontend-engineer` | Software dev | React SPAs (`averrow-ops`, `averrow-tenant`, `shared`, marketing islands) | sonnet | ✅ |
| `test-engineer` | Testing | Writes/maintains vitest unit + integration tests (backend + React) | sonnet | Tests only |
| `qa-verifier` | Testing | Runs the gate + drives changes end-to-end to catch runtime bugs | sonnet | Verify only |
| `code-reviewer` | Review | General correctness bugs + reuse/simplification/efficiency | opus | Review only |
| `design-reviewer` | UI/UX | Visual/UX/a11y review vs the design system | sonnet | Review + small fixes |
| `threat-intel-analyst` | Threat intel | Detection, enrichment, correlation, triage/AI-judge logic | opus | Logic design |
| `appsec-reviewer` | Cyber (internal) | Per-diff: RBAC, auth, secrets, injection, security review | opus | Review only |
| `platform-security` | Cyber (internal) | Standing posture: deps/supply-chain, infra/bindings, secret hygiene, exposed surface | opus | Diagnose only |
| `platform-sre` | Reliability | Live health, feed breakers, cron, D1 spend | sonnet | Diagnose only |
| `content-strategist` | Content | Marketing copy, changelogs, positioning, version bumps; **editor-in-chief for the content roster** | sonnet | Copy/data |
| `web-copywriter` | Content | Long-form marketing & company page copy, blog/thought-leadership (fan-out workhorse) | sonnet | Copy/MDX |
| `market-analyst` | Content | Competitive/market intelligence, peer teardowns, positioning briefs | sonnet | Report only |
| `seo-strategist` | Content | Meta/OG/Twitter/JSON-LD, sitemap/robots, keyword map, internal linking | sonnet | Metadata/config |
| `legal-content-drafter` | Content | Draft Privacy/Terms/DPA/trust-center copy (always flagged for legal review) | sonnet | Drafts only |
| `docs-maintainer` | Context | Keeps CLAUDE.md / API_REFERENCE / specs true | sonnet | Docs only |
| `delivery-lead` | Project mgmt | Decomposition, sequencing, owner assignment | opus | Plans only |

---

## Charters (summary — full guardrails live in each `.claude/agents/*.md`)

### `backend-engineer` — Cloudflare Worker / D1 / agents
Backend routes, handlers, feed modules, enrichment, internal AI agents, cron
wiring, migrations. **Key guardrails:** `agent_runs` + `agent_events` contract;
prepared statements only; cubes / `cachedCount` / pre-computed columns instead of
raw aggregates; never `DROP`/`ALTER` columns; **cron-audit rule** on any
`wrangler.toml` change; secrets via `env`; new endpoints → `API_REFERENCE.md`;
`tsc --noEmit` clean.

### `frontend-engineer` — React SPAs
Features, hooks, layouts, design-system primitives across ops/tenant/shared and
marketing islands. **Key guardrails:** import from `@/design-system/components`;
CSS custom properties, never old tokens; never refactor frozen components; never
touch `public/` / `app.js` / `styles.css`; user avatars = initials only; light +
dark theme; login/profile parity spec; `tsc --noEmit` clean.

### `test-engineer` — automated test coverage
Writes and maintains vitest tests: backend logic in `packages/trust-radar/test/`
and React components/hooks in `averrow-ops` / `averrow-tenant` (`src/test/`
scaffolding). **Key guardrails:** test behavior not implementation; pure decision
functions get table-driven coverage (the `decide…Triage` model); cover the
runtime failure classes `tsc` misses (SQL arity, stamp/SELECT parity, threshold
boundaries); authors tests only — a test that reveals a product bug is handed to
the owning engineer, never papered over by changing source. Runs the suite and
pastes real results.

### `qa-verifier` — runtime verification
The last gate before a change ships. Reproduces CI locally (`pnpm typecheck`,
`pnpm build:manifest && pnpm check:resource-drift`, `pnpm test`) **and drives the
actual change end-to-end** — the `verify`/`run` skills, `wrangler dev` + local D1
for worker changes, Playwright/chrome-devtools for UI. **Key guardrails:**
report-with-evidence, never claim a check passed without running it; report-don't-fix
(hands failures to the owning engineer); explicitly names what it could NOT verify.
Specifically probes the failure class this platform's typecheck waves through:
D1 column/placeholder/bind arity, stamp/SELECT divergence, SQL errors, migration
typos.

### `code-reviewer` — general correctness & code quality
The non-security, non-UI review lane. Reviews a diff for logic bugs, edge cases,
and reuse/simplification/efficiency cleanups, ranked correctness-first with a
concrete failure scenario per finding. **Doctrine:** also runs a static pass at
the runtime failure class this platform waves through (D1 bind arity,
stamp/SELECT divergence, dead indexes, broken route wiring) and the §8 cost red
flags (raw `GROUP BY` / `COUNT(*)` where a cube / pre-computed column /
`cachedCount` exists). Drives the `/code-review` skill as its mechanical layer.
Read-only; hands confirmed bugs to the owning engineer. Distinct from
`appsec-reviewer` (auth/RBAC/secrets) and `design-reviewer` (UI/UX).

### `design-reviewer` — UI/UX & accessibility
Reviews rendered UI vs `AVERROW_UI_STANDARD.md`: token adherence, light/dark
parity, responsive, a11y, states, consistency. Read-only by default; runs
Lighthouse/screenshots; proposes diffs and hands build work to
`frontend-engineer`.

### `threat-intel-analyst` — external threat domain
Feeds, enrichment scoring, threat-actor correlation, NEXUS clustering, alert
triage + AI-judge rules. **Doctrine:** *SQL does correlation, AI does narrative* —
Haiku for classification, Sonnet sparingly for narrative; triage logic stays in
one place, pure and unit-tested.

### `appsec-reviewer` — internal application security
Reviews diffs/flows for RBAC correctness, auth/session/passkey safety, secrets,
injection, over-broad org scope. Read-only; produces a ranked, file:line-anchored
findings list with concrete failure scenarios. Distinct from `threat-intel-analyst`
(external threats).

### `platform-security` — standing security posture
Owns the platform's overall security beyond a single diff: dependency /
supply-chain vulnerabilities (`pnpm audit`, lockfile CVEs), `wrangler.toml`
infra/binding config (over-broad D1/KV/R2 bindings, secret declarations, internal
routes exposed without their gate), repo-wide secret hygiene sweeps, the
exposed `/api/internal/*` + admin surface, and the RBAC model as a whole. **Diagnose
and report first** — never edits source, rotates secrets, or runs production
mutations; inspects deployed config read-only via the Cloudflare tools (no
data-query/write tools by design). Hands a diff-level vuln to `appsec-reviewer`,
a fix to the owning engineer, a reliability angle to `platform-sre`. Distinct
from `appsec-reviewer` (reviews one change) and `threat-intel-analyst` (external
threats).

### `platform-sre` — reliability & cost
Runs `platform-diagnostics.sh` / the averrow MCP; reports feed breaker health,
cron health, stalled agents, D1 read-spend, backlog trends. **Diagnose and report
first** — never flips kill-switches or runs production mutations without explicit
confirmation.

### `content-strategist` — copy, marketing, changelogs
Marketing content, customer copy, the three changelog registers, version bumps.
Also the **editor-in-chief** for the content roster below: writes the per-page
briefs (voice + facts + structure) and is the brand-voice gate on their output.
**Guardrails:** global (not Canada-first) positioning; no aviation/military
framing; the proprietary-detail firewall between staff and public/tenant
registers; semver + `platform-version.json`.

### `web-copywriter` — long-form page & blog copy
Writes the actual copy for new marketing-site pages (product deep-dives,
solutions-by-persona, customers/case studies, resources, partners, the Company
surface) plus blog/thought-leadership. **The fan-out workhorse** — run several
instances in parallel, one page each. **Guardrails:** works from a
`content-strategist` brief; global/no-aviation positioning + BRAND.md voice;
never invents metrics or placeholder proof (see the accuracy discipline in its
charter — the site has shipped self-contradicting numbers before); writes
copy/MDX only and hands layout/components to `frontend-engineer`; never touches
`public/` / `app.js` / `styles.css` / frozen components.

### `market-analyst` — competitive & market intelligence
Peer/competitor teardowns (IA, messaging, proof, pricing, CTA, SEO footprint),
category conventions, and positioning briefs for the content roster. **Report
only** — no `Edit`/`Write`. **Guardrails:** honest sourcing (many security-vendor
sites 403 automated fetch — say so rather than guess); stays on CLAUDE.md §13
positioning; never recommends claiming a capability the product doesn't ship.
Distinct from `threat-intel-analyst` (external cyber threats, not market analysis).

### `seo-strategist` — technical + content SEO
Owns discoverability/shareability: OG/Twitter/JSON-LD, sitemap/robots coverage,
canonical/hreflang, keyword map, internal linking, per-page metadata. Edits
marketing metadata/config (chiefly `Layout.astro`); hands page-layout work to
`frontend-engineer`. **Guardrails:** truthful metadata/structured data only (no
keyword-stuffing, no fake review/rating schema); global/no-aviation positioning;
verifies with a build before claiming sitemap/metadata correctness. The OG image
asset already exists at `/brand/averrow-og.png` — wire it, don't recreate it.

### `legal-content-drafter` — corporate/legal-adjacent drafts
Drafts Privacy/Terms/DPA/sub-processor/trust-center copy in plain language.
**Draft-only:** every output carries a visible "DRAFT — requires human and legal
review. Not legal advice." marker, never removed; refuses to "finalize" legal
copy. **Guardrails:** claims must match `/security` + actual infra (no invented
certifications — SOC 2 is *scheduled*, not held); flags unknowns with
`[NEEDS HUMAN INPUT: …]`; global positioning; drafts copy only, hands the page to
`frontend-engineer`.

### `docs-maintainer` — knowledge base
Keeps `CLAUDE.md`, `API_REFERENCE.md`, specs, and runbooks in sync with code.
Verifies every documented file/path/function/cron actually exists before writing
it down. Docs describe reality, never aspiration.

### `delivery-lead` — planning & sequencing
Decomposes a request into ordered, owner-assigned tasks; surfaces dependencies
and risks (restructure ordering, cron audit, D1 spend, RBAC, parity spec, frozen
files). Plans only — never edits source.

---

## How the orchestrator delegates

**This is the default operating mode for every non-trivial build, not an
optional recipe** — see CLAUDE.md §1A. The main session orchestrates;
specialists do the scoped work. Only trivial mechanical edits and
read-only questions bypass it.

1. **Ambiguous or multi-step request** → `delivery-lead` first for a plan.
2. **Build task** → the matching engineer (`backend-` / `frontend-engineer`),
   with domain input from `threat-intel-analyst` where detection logic is
   involved.
3. **On every non-trivial code change** → `test-engineer` adds/updates coverage
   for the new logic, and `qa-verifier` runs the gate (`typecheck` +
   `check:resource-drift` + `test`) and drives the change end-to-end. This is
   the standing test gate — invoke it whenever code changes, not just when asked.
   `qa-verifier` catches the runtime failure class `tsc` misses (SQL arity,
   stamp/SELECT parity) that has bitten this platform before.
4. **Before merge** → `code-reviewer` on any non-trivial diff for correctness +
   quality, plus `appsec-reviewer` (if the diff touches auth/RBAC/data
   exposure) and/or `design-reviewer` (if UI). These three lanes are
   independent and fan out concurrently. Use the `/code-review` and
   `/security-review` skills as the mechanical layer beneath them.
5. **After ship** → `content-strategist` for user-facing releases (changelog +
   version), `docs-maintainer` for any doc drift, `platform-sre` to confirm
   health.
6. **On demand / periodically (not per-diff)** → `platform-security` for a
   standing security-posture audit (dependency/supply-chain, infra & binding
   config, repo-wide secret hygiene, exposed internal surface). This is a
   holistic sweep, separate from step 4's `appsec-reviewer` diff review — reach
   for it when the concern is the platform's overall posture, not one change.

## Marketing content production (the content roster fan-out)
For a marketing/company-site content build (e.g. the restructure in
`docs/MARKETING_SITE_ASSESSMENT_2026-07.md`), the content roster runs as a
fan-out, since page-writing is the slow, parallelizable part:

1. `content-strategist` (editor-in-chief) writes a **per-page brief** — voice,
   verified facts, structure — for each page, drawing competitive framing from
   `market-analyst`.
2. **Fan out `web-copywriter` × N in parallel**, one page each (launch multiple in
   a single message, or a Workflow with explicit user opt-in given token cost).
   Every writer gets the same brand-voice brief + the assessment's defect list so
   no one re-introduces Canada-first framing or contradictory numbers.
3. Per page: `seo-strategist` (metadata/OG/JSON-LD/keywords) and `design-reviewer`
   (layout/token/a11y) review; `legal-content-drafter` handles any legal-adjacent
   page (draft-only).
4. `frontend-engineer` builds each Astro page from the approved copy;
   `qa-verifier` runs the gate.

## Boundaries (who does NOT do what)
- Reviewers (`code-reviewer`, `design-reviewer`, `appsec-reviewer`),
  `platform-security`, and `platform-sre` don't ship feature code — they report
  and hand off.
- Security has two distinct lanes: `appsec-reviewer` reviews a single **diff/flow**
  for vulns (per-change, part of the pre-merge review); `platform-security` audits
  the **standing posture** (deps/supply-chain, infra/bindings, secret hygiene,
  exposed surface — on demand, not per-diff). A diff-level vuln surfaced by
  platform-security goes to appsec-reviewer; a fix goes to the owning engineer.
- The three review lanes are distinct: `code-reviewer` owns general correctness
  + quality, `appsec-reviewer` owns auth/RBAC/secrets/injection,
  `design-reviewer` owns UI/UX/a11y. Each hands cross-lane findings to the
  right owner rather than adjudicating them.
- `docs-maintainer` never edits product source; `content-strategist` never edits
  component logic; `delivery-lead` never edits anything.
- The content roster splits by artifact: `content-strategist` owns short copy +
  changelogs + the briefs; `web-copywriter` owns long-form page/blog copy;
  `market-analyst` researches and reports only (no edits); `seo-strategist` owns
  metadata/config (not body copy or components); `legal-content-drafter` owns
  legal-adjacent drafts only (always flagged, never finalized). None of them
  build components or restructure layout — that's `frontend-engineer`.
- Detection *logic* is `threat-intel-analyst`; Worker *plumbing* is
  `backend-engineer`.
- `test-engineer` edits only test files; `qa-verifier` edits nothing (runs +
  reports). A failing test/verification is handed back to the owning engineer —
  neither agent changes product source to make a check pass.

## Extending the roster
Add a new `.claude/agents/<name>.md` with `name`, `description`, `tools` (omit to
inherit all; restrict for reviewers), `model`, and a system prompt that cites the
specific `CLAUDE.md` sections it must enforce. Then add a row here and to the
delegation notes above. Keep names function-based to stay distinct from the
platform's internal agent codenames.
