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
| `backend-engineer` | Software dev | Workers, D1, internal agents, feeds, cron (`trust-radar`, `imprsn8`, `averrow-mcp`) | opus | ✅ |
| `frontend-engineer` | Software dev | React SPAs (`averrow-ops`, `averrow-tenant`, `shared`, marketing islands) | sonnet | ✅ |
| `test-engineer` | Testing | Writes/maintains vitest unit + integration tests (backend + React) | sonnet | Tests only |
| `qa-verifier` | Testing | Runs the gate + drives changes end-to-end to catch runtime bugs | sonnet | Verify only |
| `design-reviewer` | UI/UX | Visual/UX/a11y review vs the design system | sonnet | Review + small fixes |
| `threat-intel-analyst` | Threat intel | Detection, enrichment, correlation, triage/AI-judge logic | opus | Logic design |
| `appsec-reviewer` | Cyber (internal) | RBAC, auth, secrets, injection, security review | opus | Review only |
| `platform-sre` | Reliability | Live health, feed breakers, cron, D1 spend | sonnet | Diagnose only |
| `content-strategist` | Content | Marketing copy, changelogs, positioning, version bumps | sonnet | Copy/data |
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

### `platform-sre` — reliability & cost
Runs `platform-diagnostics.sh` / the averrow MCP; reports feed breaker health,
cron health, stalled agents, D1 read-spend, backlog trends. **Diagnose and report
first** — never flips kill-switches or runs production mutations without explicit
confirmation.

### `content-strategist` — copy, marketing, changelogs
Marketing content, customer copy, the three changelog registers, version bumps.
**Guardrails:** global (not Canada-first) positioning; no aviation/military
framing; the proprietary-detail firewall between staff and public/tenant
registers; semver + `platform-version.json`.

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
4. **Before merge** → `appsec-reviewer` (if the diff touches auth/RBAC/data
   exposure) and/or `design-reviewer` (if UI). Use the `/code-review` and
   `/security-review` skills as the mechanical layer.
5. **After ship** → `content-strategist` for user-facing releases (changelog +
   version), `docs-maintainer` for any doc drift, `platform-sre` to confirm
   health.

## Boundaries (who does NOT do what)
- Reviewers (`design-reviewer`, `appsec-reviewer`) and `platform-sre` don't ship
  feature code — they report and hand off.
- `docs-maintainer` never edits product source; `content-strategist` never edits
  component logic; `delivery-lead` never edits anything.
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
