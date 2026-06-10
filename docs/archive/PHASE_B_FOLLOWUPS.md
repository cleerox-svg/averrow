> Archived 2026-06-10: point-in-time Phase B deferred-items list (2026-05).

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

**Update 2026-05-08 (post-D2d).** Phase D D1 + D2d shipped the
finite opacity-class overrides for averrow-tenant + averrow-ops.
Operator note flagged this is still a "full-platform" audit gap:
the `/scan` landing (dark-only), worker-rendered pages, email
templates, observatory WebGL chrome, and any one-off marketing
surface haven't been swept yet. Treat the D1+D2d work as Wave 1
of the parity audit; Wave 2 covers everything outside the two
React SPA packages.

## Pricing — keep config in the DB, not hardcoded

**Flagged:** 2026-05-08 by operator, while scoping Stripe.

**Constraint.** When pricing wiring lands, the pricing config
itself must live in the DB so super_admins can edit baseline
tier prices, individual module prices, and per-customer
overrides without a code deploy. Stripe handles the billing
event (charge, invoice, retry) but the source of truth for what
each org's effective price IS lives in trust-radar.

**Design implication for the Stripe sprint(s).**
- New `pricing_plans` table (tier_id, name, monthly_price_cents,
  included_modules JSON, trial_days). Seeded with the three
  default tiers from CLAUDE.md (Professional $1,499 / Business
  $3,999 / Enterprise custom).
- New `module_prices` table (module_key, monthly_price_cents)
  for à-la-carte / per-module subscriptions.
- New `org_pricing_overrides` table — super_admin records a
  custom price per org with `override_type`
  (`tier_price` / `module_price` / `discount_percent`),
  `value`, `reason`, `set_by_user_id`, `effective_until`.
  Lets enterprise discounts and bespoke deals stay configurable
  without a code change.
- The Stripe subscription create flow reads our pricing config,
  applies any active override, and either uses the matching
  Stripe `price_id` (for standard tiers) OR a one-off
  custom-price subscription item (for overridden / enterprise
  customers).
- Super_admin "Customers" page (rename from "Organizations" per
  the same operator note) carries a Pricing sub-section that
  lists current plan, effective monthly total, applied
  overrides, and an edit form.
