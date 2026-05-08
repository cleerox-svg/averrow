# Phase B follow-ups — items deferred to keep sprint cadence

Deliberate "save for later" items captured during Phase B sprints.
Each entry: what, why, where the work lives, who flagged it.

## UI — Light/Dark mode parity audit

**Flagged:** 2026-05-07 by operator, mid Phase B sprint 5.

**Problem.** Dark mode has been the design focus across averrow-ops
and the new averrow-tenant surface. Light mode has not received
the same attention and is inconsistent across pages — token
overrides, severity colors, hover states, and component
backgrounds drift between routes.

**Scope of audit.**
- Walk every route in averrow-ops (existing /v2 surface) and
  averrow-tenant (new /tenant/ surface) under
  `[data-theme='light']` and capture screenshots for diff.
- Verify the design-system token contract: every `--bg-*` and
  `--text-*` should override cleanly from
  `design-system/tokens.css`. Any component reading a hard-coded
  Tailwind color (`bg-white/`, `text-white/X`) instead of a CSS
  custom property is the failure mode.
- Severity colors (`--sev-critical`, `--sev-high`, …) currently
  carry across themes — confirm contrast ratios meet WCAG AA on
  the light background.
- Hover/active states on buttons, nav, links — many of these were
  tuned only against `--bg-page: #060A14`.
- Form inputs, modals, tooltips — typically the worst offenders
  when a token system is incomplete.

**Out of scope.** No redesign — the goal is to make light mode
visually correct and consistent with the existing dark-mode
intent, not to redo the design.

**Where it lands in the plan.** Phase D pre-launch hardening is
the natural spot — alongside QA, design-partner soak, and
averrow-ops rebadge. This is not blocking sprints B5-B8.

**Tracking.** Open this as a dedicated PR in Phase D rather than
folding into a sprint, so the diff is reviewable by design.
