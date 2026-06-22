# Changelog

All notable changes to the Averrow platform are documented here.

---

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
