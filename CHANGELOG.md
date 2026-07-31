# Changelog

All notable changes to the Averrow platform are documented here.

---

## [Unreleased] — 2026-07-31

AI-phishing-detection research follow-through (`docs/AI_PHISHING_DETECTION_RESEARCH_2026-07.md`,
a research-only assessment — no per-message "was this AI-written?" detector was
or will be built, per its §3.1 rejection). Two build waves off that doc's
recommendations, both on `claude/ai-phishing-detection-research-2f1blu`.
Internal/staff register only this cycle — see the scope note at the end for
why there's no public/tenant entry.

### Campaign-polymorphism measurement pipeline (Wave 1 / W1.11, PR #1705, merged)
- **Fixed three dead-read bugs** in `src/brand-threat-correlator.ts` that had
  silently zeroed the existing (pre-this-work) "AI-generated phishing" risk
  signal since it shipped (migrations 0022/0023): both queries were wrapped in
  `.catch(() => ({count/total: 0}))`, so the schema mismatches never surfaced
  as errors. `pps.ai_generated = 1` → `ai_generated_probability >=
  AI_GENERATION_PROBABILITY_THRESHOLD` (0.7, new shared constant in
  `src/lib/phishing-signals.ts`, also consumed by `src/agents/pathfinder.ts`);
  `classification = 'phishing'` → `category = 'phishing'` on
  `spam_trap_captures`; `COUNT(DISTINCT sender_email)` → `COUNT(DISTINCT
  from_address)`. Downstream consumers (`analyst.ts`'s "AI-Generated Threat
  Detected" insight, the ops `ScoreBreakdownCard.tsx` label) are now reachable
  by SQL — but see the caveat below, the count they read is still always 0.
- **Deterministic (zero-AI) campaign-polymorphism writer** — migration
  `0257_phishing_pattern_signals_phase1.sql`, pure core
  `src/lib/phishing-pattern-signals.ts`, D1 writer
  `src/lib/phishing-pattern-writer.ts`. Two admin endpoints: `POST
  /api/admin/phishing-signals/backfill` (populates per-message
  `phishing_pattern_signals` rows — `template_hash`, `sentence_structure_
  variance`, lexical stats, no AI call) and `POST
  /api/admin/phishing-signals/rollup` (`runPhishingCampaignRollup`, writes
  `campaign_pattern_stats`: `polymorphism_regime`, pairwise-Hamming stats,
  distinct-sender/domain/ASN counts per `campaign_key`). Both are
  endpoint-dispatched only — no cron, no `agent_runs`/`agent_events` row,
  matching the existing alert-triage-backfill precedent. Pure SQL + hashing;
  zero AI spend.
- **`ai_generated_probability` is still never written.** Phase 1 is
  measurement-only (lexical/structural variance, no semantic/embedding
  comparison, no Haiku judge). The dead-read fix above makes the pipe
  reachable; it does not make it non-zero. See
  `docs/PLATFORM_DATA_DEPENDENCIES.md` §9 and research-doc §6/§8 for the open
  semantic-similarity decision gating any future campaign-level AI-generation
  verdict — still explicitly deferred, not part of this wave.

### Phantom-squat watchlist (Wave 2, W2.0–W2.3, PR opening)
- **New `phantom_domains` table** (migration `0258_phantom_domains.sql`) — a
  per-brand watchlist of domains LLMs *hallucinate* for that brand (per Unit
  42's phantom-squatting research: models deterministically converge on the
  same fake names from shared linguistic priors; attackers register them
  18–51 days later). Dedicated table, not folded into `lookalike_domains`
  (unregistered predictions must stay out of the lookalike scanner's active
  DNS/HEAD probe set — a cost containment, not just a schema choice).
- **`phantom_enumerator` agent** (codename **Phantom**,
  `agents/phantomEnumerator.ts`) — one bounded Haiku enumeration pass per
  monitored brand, writing predicted domains at `status='predicted'`. No
  cron; manual/on-demand only via `POST
  /api/internal/agents/phantom_enumerator/run`. Enumeration alone never
  creates a threat or an alert — a phantom is a prediction, not a finding.
- **W2.3 matcher post-pass** (`lib/phantom-matcher.ts`) — idempotent,
  set-based join of `phantom_domains.domain` (`status='predicted'`) against
  the NRD feed, CT stream, and lookalike scanner already running. On a hit,
  flips `predicted`→`registered` (at most once) and raises at most one
  low-severity alert, reusing the **existing** `lookalike_domain_active` /
  `ct_certificate_issued` alert types — no new `alert_type`, no CHECK
  migration. Never inserts a `threats` row inline. Admin endpoint `POST
  /api/admin/phantom-domains/match`; internal-secret variant `POST
  /api/internal/phantom-domains/match?limit=500&source=all&full=0` for
  MCP/cron dispatch.

### Scope note — no version bump, no public/tenant changelog entry this cycle
Both waves are admin/internal surfaces: the phishing-signals backfill/rollup
endpoints are an internal measurement pipeline with no reads/UI yet
(`campaign_pattern_stats` has zero consumers as of phase 1); the phantom
enumerator trigger is internal-secret-gated and the matcher's admin endpoint
is super_admin-only. The only artifact a customer could ever see from either
wave is a `low`-severity alert from the Wave-2 matcher — and that alert reuses
alert types (`lookalike_domain_active`, `ct_certificate_issued`) that already
ship and already carry public/tenant-safe copy; the matcher is just an
additional detection source feeding a pathway that pre-dates this work, not a
new customer-facing feature or claim. No new endpoint, UI, or notification
copy is exposed to tenants. Per CLAUDE.md §9b (PATCH = `fix`/`perf`/
`refactor` that customers can observe), there's nothing here to attach a
PATCH to — same precedent as the two prior `[Unreleased]` internal-only
entries below (2026-07-11, 2026-04-01). No `/platform-version.json` bump, no
public (`packages/averrow-marketing/src/data/changelog-entries.ts`) or tenant
entry this cycle. If Wave 2's matcher volume becomes customer-visible enough
to warrant its own line in the public/tenant registers, that's a follow-up
call once real hit-rate data exists — not before.

## [v4.2.2] — 2026-07-22

Follow-on light-theme ("lite mode") polish pass for the staff ops app,
closing the gaps left after the 4.2.1 sweep. Internal/staff register
(detailed; the public register carries a generic, non-proprietary
summary).

### Remaining dark panels + contrast fixes (ops-only)
- Fixed remaining hardcoded-dark panels/cards that stayed unreadable under
  `[data-theme="light"]` after the 4.2.1 pass: Abuse Mailbox, Spam Trap,
  Admin Pipelines, Explorer's accelerating-provider cards, and the
  Overview "burst" banner. Root cause was inline literal background
  colors (dark-canvas `rgba(...)` values baked directly into component
  style props/classNames) that bypassed the token system entirely —
  migrated each to `var(--bg-card)` (plus `var(--card-critical-bg)` where
  the panel carries a critical/alert accent) so they inherit the
  theme-aware value instead of a hardcoded dark literal.
- Fixed titles/labels that were previously invisible or near-invisible in
  light theme (dark-on-dark text color left over from the pre-token era)
  across the same five surfaces.
- Sharpened the selected-state highlight on the sidebar nav and on filter
  pills/tabs so the active item is visibly distinguishable in light
  theme — added dedicated `--nav-active-bg` / `--nav-active-text` and
  `--pill-active-bg` / `--pill-active-text` tokens (light-theme values
  tuned for AA contrast against `--bg-card`) instead of reusing the
  dark-theme active-state values, which read as too low-contrast on a
  light canvas.
- Dark theme is unchanged end to end — every fix is either an additive
  `[data-theme="light"]` override or a swap onto a token whose dark-mode
  value is unchanged from the previous literal.
- Screenshot-verified across all five affected surfaces (Abuse Mailbox,
  Spam Trap, Admin Pipelines, Explorer, Overview) in both themes before
  merge.

PR #1684. Bump: `fix` — PATCH (`4.2.1` → `4.2.2`).

## [v4.2.1] — 2026-07-22

Light-theme ("lite mode") readability fix across all three surfaces —
staff ops, tenant, and marketing. Internal/staff register (detailed; the
public + tenant registers carry a generic, non-proprietary summary).

### Light-theme readability & contrast fix
- Legacy dark-hardcoded colors, `.glass-card` / `.glass-input` / `.glass-btn`
  utilities, `.badge-*` classes, and `text-white/NN` opacity utilities were
  tuned only for the dark canvas and read as low-contrast or illegible under
  `[data-theme="light"]`. Added `[data-theme="light"]` parity blocks —
  additive only, dark stays byte-identical everywhere an exact CSS-var
  equivalent doesn't already exist — in `packages/shared/src/theme/tokens.css`
  (the shared token file consumed by both `averrow-ops` and `averrow-tenant`)
  and `packages/averrow-ops/src/index.css` (`.glass-card`, `.glass-input`,
  `::selection`).
- Badge/severity text was migrated off "dot" hex values (`--sev-critical`,
  `--amber`, etc. — used directly as `color:`, flagged by
  `AVERROW_UI_STANDARD.md` as a contrast risk) onto the dedicated `-text`
  token family (`--sev-critical-text`, `--sev-high-text`, `--amber-text`,
  `--nexus-text`, etc.), each of which carries its own light-theme
  AA-contrast override. `.badge-low` / `.badge-nexus` (legacy gauge-gray /
  one-off nexus violet, no existing dot-var) got computed AA-safe light
  values instead.
- **Frozen-component-via-stylesheet technique**: components on the CLAUDE.md
  §4 frozen list (e.g. `PortfolioHealthCard.tsx`, a `.glass-card` consumer)
  are never edited directly. The fix lives entirely in the `[data-theme=
  "light"]` parity block on the class definition itself, so the frozen
  component renders correctly in light mode with zero changes to its source
  — the same pattern used platform-wide anywhere a frozen file consumes a
  legacy utility class.
- Marketing site (`packages/averrow-marketing/src/styles/tokens.css`) got
  the matching `[data-theme="light"]` treatment for its own token set (an
  aligned/ported copy of the platform tokens per that file's header, not
  literally shared code with `packages/shared`).
- Dark mode is unaffected end to end — every parity rule is additive and
  scoped under `[data-theme="light"]`.

PR #1682. Bump: `fix` — PATCH (`4.2.0` → `4.2.1`).

## [v4.2.0] — 2026-07-20

Executive social-impersonation monitoring (`EXEC_IMPERSONATION_2026-07`,
Stages 1-6, deterministic-first). Internal/staff register (detailed; the
public + tenant registers carry a generic, non-proprietary summary).

### Executive impersonation detection
- **`org_executives` registry** (migration 0244) — customers register named
  executives per brand: `full_name`, `title`, `official_handles` (JSON
  platform→handle, mirrors `brands.official_handles`), `watch_platforms`
  (subset of the social-monitor 6). `photo_ref` is declared but unused this
  stage — reserved for a future photo-match gate that depends on paid,
  ToS-restricted platform APIs (X/LinkedIn/Meta/TikTok) not yet configured
  on the platform; there is no timeline commitment on that phase.
- **Deterministic detector** (`scanners/executive-monitor.ts`,
  `runExecutiveMonitorForExec`) — pure, side-effect-free. Generates
  plausible impersonation handles from the exec's full name (canonical
  first+last forms, multi-token/hyphenated-surname forms, "official/real"
  dressing, initials — bounded to `MAX_CANDIDATES_PER_EXEC=12`), NFD-folds
  diacritics, requires >=2 name tokens as a false-positive gate (mononyms
  yield zero candidates), HEAD-checks each candidate across the six watched
  platforms via the same `lib/social-check.ts` checker the brand path uses,
  and scores name-similarity with the shared deterministic
  `scanners/impersonation-scorer.ts` (Levenshtein-based, no AI). Account
  age, follower count, verification badge, and bio-content signals are
  **not** computed for this path (HEAD-probe only) — the scorer's inputs
  for those fields are hardcoded `false`/unavailable, never real data.
- **`executive_monitor` agent** (`agents/executiveMonitor.ts`, delegating to
  `scanners/executive-monitor-batch.ts`) — dedicated cron `26 */6 * * *`.
  `EXEC_BATCH_LIMIT=10` execs/run with a KV rotation cursor
  (`exec_monitor:rotation_cursor`) so the full registry cycles across runs.
  Non-official over-threshold candidates raise `executive_impersonation`
  alerts (migration 0245 extends the `alerts.alert_type` CHECK); the exec's
  own registered handle is never alerted (`isOfficialHandle` short-circuit).
  Grandfathered into `agent_approvals` as `approved` (migration 0246) so the
  standard agent-approval gate doesn't silently skip its first ticks (the
  ct_monitor/0238 failure mode).
- **Org-scoped alert security** (migration 0247, `alerts.org_id`) — this
  PII-bearing alert family (an executive's real name + a fake profile URL)
  is stamped with the owning org's `org_id` at creation and the routing
  user is resolved strictly within that same org (`resolveAlertUser`,
  keyed by `org_id`, never falls back cross-org). Brands are many-to-many
  with orgs, so a brand-scoped lookup could otherwise leak an exec's name
  to a co-monitoring org; this closes that gap. Dedup window `-6h` (shared
  `ALERT_TYPES` registry) guards against re-observation flooding.
- **Triage** (`decideExecutiveImpersonationTriage`,
  `lib/alert-triage.ts`) — Tier 1.5, mirrors the social/app-store
  impersonation rules: dismiss when the handle matches the exec's own
  `official_handles` (rule B) or `details.score < 0.5` (rule A, tunable via
  `impersonationThreshold`).
- **Tenant UI** (`packages/averrow-tenant/src/features/executives/
  Executives.tsx`, route `/settings/executives`) — CRUD over
  `GET/POST/PATCH/DELETE /api/orgs/:orgId/executives(/:execId)`
  (`handlers/tenantExecutives.ts`). Reads: any org member. Mutations:
  org-admin+ (`requireOrgAdmin`), matching the existing member-management
  gate. `Social.tsx` now links to the new surface.

### Marketing / changelog truth-up
- Rewrote the exec-impersonation claims on
  `packages/averrow-marketing/src/pages/platform/social-monitoring.astro`
  (the "What We Detect" bullet + the "Confidence Scoring" section) to
  describe the shipped deterministic name/handle-matching capability and
  removed the previously-published (never-built) profile-photo,
  account-age, follower-count, verification-badge, and bio-content
  detection claims — those depend on paid platform APIs not configured on
  the platform. See public + tenant changelog entries below for the
  customer-facing summary.
- Same page's "Evidence Collection" section (`id="evidence"`) claimed
  automated "profile screenshot" capture ("no manual screenshotting
  required") for every flagged account. Verified against
  `lib/social-check.ts` (HEAD-probe only, no HTML/DOM fetch),
  `scanners/social-monitor.ts` (`social_profiles.avatar_url` /
  `bio` / `followers_count` / `verified` are never written), and
  `handlers/investigations.ts` `handleAddEvidence` (the only
  `evidence_captures` writer — an operator-supplied manual upload, not
  an automated capture pipeline; `takedown_requests.screenshot_url` is
  explicitly commented "R2 link to screenshot (future)" in migration
  0039 and has no writer anywhere in the codebase). No screenshot
  pipeline exists for brand-level OR executive findings — this was not
  an executive-specific gap, it was already inaccurate for the
  brand-level claim the section was scoped to. Softened the paragraph +
  both bullet/evidence-content lists to describe what IS captured
  automatically (handle, platform, profile URL, detection timestamp,
  confidence score + signals, threat cross-references, classification
  notes) and dropped the screenshot/"no manual screenshotting" claim.
  Flagging automated screenshot capture as a real product gap — not
  scheduled, would need a Browser Rendering binding (see the identical
  "vision/screenshot analysis... deferred to increment 2" note in
  migration 0243 for the lookalike-domain page-analysis path).
- `packages/averrow-marketing/src/pages/why-averrow.astro`'s illustrative
  sample card had the same false-signal pattern (follower count /
  verification badge aren't real detected signals): "1 unverified
  handle" → "1 flagged handle"; "@acmecorp_support — unverified handle,
  low follower count" → "@acmecorp_support — 91% name similarity, common
  impersonation suffix pattern" (matches the real deterministic signals
  used in the score-card fix above). Sample data, fictional brand,
  unaffected by the wording change.

## [Unreleased] — 2026-07-11

### Threat intelligence
- **Cluster-level threat-actor attribution inheritance** — new
  `lib/cluster-attribution-inherit.ts` (`inheritOtxActorsToClusters`),
  called from the Attributor agent's post-pass. When every OTX-sourced
  (`threat_attributions.source = 'otx'`) member of an infrastructure
  cluster names the SAME actor, that actor now propagates to the
  cluster's un-attributed sibling threats and, when the cluster has no
  `actor_id` yet, to `infrastructure_clusters.actor_id` itself. Pure SQL
  correlation — no AI tokens spent. Conservative by design: clusters
  with zero or ≥2 distinct OTX actors among members are skipped (no
  guess), and inherited rows are stamped `confidence: 'low'` (never
  higher than the source 'medium'), a stable `tat_otxinherit_` id
  prefix, and `metadata.inherited = true` for auditability. Idempotent
  and bounded (`MAX_MEMBER_WRITES_PER_RUN = 5000`) so re-runs and large
  first-run backlogs are cheap. Migrations 0135/0136 (`threat_attributions`,
  `cluster_actor_attribution`) already provided the schema; this ships
  the propagation logic. Net effect: more detected infrastructure
  resolves to a named threat actor instead of showing "unknown".

### Staff ops UI
- **Fixed "agents online" count divergence on Home** — `ModuleHub.tsx`
  was still using an older, stricter `healthy | running | active`
  filter while `StatGrid.tsx` and the Agents page used `status !==
  'error'` (per audit C4, 2026-05-06), so the Home page showed two
  different agent-online numbers for the same `agents` array
  (design-review finding, 2026-07-11). Added `lib/agent-status.ts` as
  the single canonical `isAgentOnline` / `countAgentsOnline`
  predicate; `Agents.tsx`, `StatGrid.tsx`, and `ModuleHub.tsx` now all
  import from it instead of re-deriving the filter inline. Internal
  staff back-office fix only — no customer-facing surface affected.

## [v4.0.0] — 2026-06-22

The v4 platform redesign + auth hardening line. Internal/staff register
(detailed; the public + tenant registers carry a generic, non-proprietary
summary of the same release).

### v4 redesign (coexisting; opt-in via the "Try v4" pill until cutover)
- **Shell coexistence gate** — `useShellVersion` + `ShellSwitch` render `ShellV4`
  (cinematic command-center chrome: dark canvas + vignette, glowing amber nav,
  3-workspace IA — SOC Console / Intelligence / Platform) or the classic Shell,
  both over the same route `<Outlet/>`. Classic untouched.
- **`@averrow/shared/ui`** — new shared design system (Radix + cva, token-native
  via brand CSS vars; responsive, ≥40px touch targets). Consumed by both apps.
- **Responsive `ShellV4`** — off-canvas drawer + hamburger ≤900px, single column.
- **SOC Console** (`/console`) — KPI hero + deep-linkable `?tab=` queues
  (Signals/Threats/Incidents/Takedowns) hosting existing pages.
- **Cinematic Incidents** interior + plain-language queue explainers.

### Auth & login hardening
- Fixed the Tailwind purge that broke the shared login/profile layout.
- Login brand-locked to the dark theme regardless of OS preference.
- Passkey sign-in host-hydration (LoginPage + enrollment gate) — fixes the
  spinner hang that required a manual refresh.
- Fixed the enrollment-gate → "SYSTEM ERROR" view crash (don't mount protected
  surface under an enrollment-scoped session).
- Real Averrow logo on the login + passkey gate; gate rebranded to brand colors.

### Versioning
- Real, auto-updating platform version (`v4.0.0 · <git sha>`) shown to every
  logged-in user in both apps; single source `/platform-version.json` injected
  at build. Public + staff changelogs brought current.

## [Unreleased] — 2026-04-01

### Visual Identity Overhaul (Sessions 1–4)

**Session 1 — Logo + Color Tokens:**
- **Deep Arrow Logo Gradient:** Logo updated from red-to-blue (#C83C3C → #78A0C8) to Deep Arrow gradient (#6B1010 → #C83C3C). Applied to favicon.svg, icon-192.svg, icon-512.svg, and AverrowLogo.tsx. PWA icons replaced from teal radar to delta wing A mark.
- **Afterburner Amber Primary Accent:** Replaced orbital-teal (#00d4ff) as the primary UI accent with Afterburner Amber (#E5A832). Orbital-teal is now reserved exclusively for Observatory map beams and logo glow.

**Session 2 — Glass System + Dual Themes:**
- **Glassmorphism Card System:** Added five glass utility classes — `.glass-card`, `.glass-sidebar`, `.glass-elevated`, `.glass-stat`, `.glass-input` — using new design tokens with backdrop-blur and afterburner-amber accents.
- **Dual Theme Tokens:** Added complete dark theme (deep-space, instrument-panel, instrument-white, gauge-gray) and light theme (cloud, warm-cream, ink, slate) token sets to tailwind.config.ts.

**Session 3 — Component Migration:**
- **Design System Documentation:** Full rewrite of AVERROW_DESIGN_SYSTEM_BRIEF.md color sections, logo specification, glass system docs, and dual theme rules. Updated CLAUDE.md and AVERROW_MASTER_PLAN.md color references.

**Session 4 — Polish, Animations, Micro-interactions:**
- **Glass card hover effects:** Subtle lift (-1px), amber border hint, and enhanced shadow on hover for all `.glass-card` elements.
- **Stat card amber glow:** `.glass-stat:hover` gains amber border emphasis and warm glow shadow.
- **Button press animations:** Primary (amber) buttons get hover lift + active press; takedown (red) buttons get hover darken.
- **Sidebar nav left-glow:** Active nav item now emits a subtle amber glow to the left (-4px 0 12px).
- **Critical badge pulse:** `.badge-critical` gains a slow 3s opacity pulse (1.0 → 0.8) for subtle urgency.
- **Severity badge refinement:** Medium badges now use Wing Blue, Low badges use Gauge Gray, High badges use Afterburner Amber — all with proper muted bg + border + text.
- **Mobile backdrop-blur fallback:** `@media (max-width: 768px)` reduces blur to 8px; `@supports not (backdrop-filter)` provides solid-bg fallback.
- **Email briefing template:** All `#00d4ff` teal accents replaced with `#E5A832` amber; background updated to `#080C14` (Deep Space).
- **Documentation sync:** CHANGELOG updated, stale teal references verified across all docs.

### Design Token Additions (tailwind.config.ts)

New tokens added (all existing tokens preserved for backwards compatibility):

| Category | Tokens |
|----------|--------|
| Backgrounds | `deep-space`, `instrument-panel`, `panel-highlight`, `instrument-edge` |
| Text | `instrument-white`, `gauge-gray` |
| Primary accent | `afterburner` (DEFAULT, hover, muted, border) |
| Secondary | `wing-blue` (DEFAULT, muted, border) |
| Alert | `signal-red` (DEFAULT, deep, muted, border) |
| Status | `clearance`, `caution` |
| Light theme | `cloud`, `warm-cream`, `warm-border`, `ink`, `slate`, `amber-deep`, `blue-deep`, `red-deep` |
