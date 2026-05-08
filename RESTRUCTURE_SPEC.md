# Averrow — Full Platform Restructure
# The definitive specification. One platform. Desktop/Mobile. Dark/Light.
# Written April 2026 after full codebase audit.

---

## WHAT THIS DOCUMENT IS

This is the complete specification for restructuring the Averrow React
platform from its current fragmented state into a single coherent system.

Every Claude Code session that runs restructure work reads this document
first and follows it exactly. Nothing is invented. Nothing deviates.

---

## CURRENT STATE — HONEST ASSESSMENT

### The Numbers
- 71 files using old design tokens (glass-card, bg-cockpit, text-parchment etc.)
- 1,095 individual token usages to migrate
- 2 StatCard components with different APIs
- 2 Button components (Button.tsx + DimensionalButton.tsx)
- 2 Card components (Card.tsx + DeepCard.tsx)
- 2 Badge components (Badge.tsx + SeverityChip.tsx)
- 27 hooks in a flat directory with no organization
- 15,357 lines across page files alone
- 0 CSS custom properties for theming (only z-index vars exist)
- 0 shared layout components (every page builds its own header/stat grid)

### What's Actually Good (Keep It)
- `lib/api.ts` — ApiClient is solid. Keep it.
- `lib/auth.tsx` — AuthProvider + useAuth is solid. Keep it.
- `lib/time.ts` — time utilities. Keep.
- `lib/cn.ts` — Keep.
- TanStack Query setup in main.tsx — solid. Keep.
- All hooks/ — the data layer works. Reorganize, don't rewrite.
- All backend routes/handlers — untouched throughout restructure.
- Observatory WebGL map (ThreatMap.tsx) — untouched.
- ExposureGauge.tsx — untouched.
- PortfolioHealthCard.tsx (SVG donut) — untouched.
- Sparkline.tsx, ActivitySparkline.tsx — untouched.
- EventTicker.tsx — untouched.

---

## TARGET ARCHITECTURE

```
packages/averrow-ops/src/
│
├── design-system/                    ← SINGLE source of truth for all visuals
│   ├── tokens.css                    ← CSS custom properties. Dark/light/themes here.
│   ├── components/                   ← ~15 primitives. Nothing else.
│   │   ├── Button.tsx                ← ONE button. 4 variants.
│   │   ├── Card.tsx                  ← ONE card. 4 variants. (replaces Card+DeepCard)
│   │   ├── Badge.tsx                 ← ONE badge. severity+status. (replaces Badge+SeverityChip)
│   │   ├── Avatar.tsx                ← ONE avatar. (replaces DimensionalAvatar)
│   │   ├── StatCard.tsx              ← ONE stat card. (replaces both StatCards)
│   │   ├── Input.tsx                 ← form input
│   │   ├── Select.tsx                ← form select
│   │   ├── Tabs.tsx                  ← tab bar
│   │   ├── DataRow.tsx               ← clickable table/list row
│   │   ├── FilterBar.tsx             ← search + filter pills
│   │   ├── PageHeader.tsx            ← page title + subtitle + actions
│   │   ├── StatGrid.tsx              ← responsive 4-card grid
│   │   ├── EmptyState.tsx            ← empty state (already exists, keep)
│   │   ├── Modal.tsx                 ← modal/sheet (replaces Dropdown+BottomSheet)
│   │   └── index.ts                  ← single import for everything
│   └── hooks/
│       ├── useTheme.ts               ← dark/light/custom theme switching
│       └── useBreakpoint.ts          ← responsive breakpoint hook
│
├── features/                         ← domain-driven. self-contained.
│   ├── brands/
│   │   ├── api.ts                    ← all brands API calls
│   │   ├── hooks.ts                  ← re-exports from hooks/useBrands.ts
│   │   ├── BrandsPage.tsx
│   │   ├── BrandDetailPage.tsx
│   │   └── components/
│   │       ├── BrandRow.tsx          ← shared brand list row
│   │       ├── ExposureGauge.tsx     ← KEEP AS-IS (unique SVG)
│   │       ├── EmailPosture.tsx      ← BIMIStatusRow + grade display
│   │       └── PortfolioHealth.tsx   ← KEEP AS-IS (unique SVG donut)
│   ├── threats/
│   │   ├── hooks.ts
│   │   ├── ThreatsPage.tsx
│   │   └── components/
│   │       └── ThreatRow.tsx
│   ├── alerts/
│   │   ├── hooks.ts
│   │   ├── AlertsPage.tsx
│   │   └── components/
│   │       └── AlertRow.tsx
│   ├── observatory/
│   │   ├── hooks.ts
│   │   ├── ObservatoryPage.tsx
│   │   └── components/
│   │       ├── ThreatMap.tsx         ← KEEP AS-IS (WebGL — untouchable)
│   │       ├── EventTicker.tsx       ← KEEP AS-IS
│   │       └── ObservatoryChrome.tsx ← mode tabs, stat bar, bottom panel
│   ├── campaigns/
│   ├── agents/
│   ├── feeds/
│   ├── takedowns/
│   ├── spam-trap/
│   ├── providers/
│   ├── threat-actors/
│   ├── trends/
│   ├── leads/
│   └── admin/                        ← admin IS a feature, not a sub-platform
│       ├── hooks.ts
│       ├── AdminDashboard.tsx
│       ├── Organizations.tsx
│       ├── AuditLog.tsx
│       └── components/
│           ├── OrgSheet.tsx
│           ├── MemberInvite.tsx
│           └── ApiKeySheet.tsx
│
├── layouts/                          ← ONE shell, adapts to everything
│   ├── Shell.tsx                     ← responsive, role-aware
│   ├── Sidebar.tsx                   ← desktop nav
│   ├── TopBar.tsx                    ← header with theme toggle
│   └── MobileNav.tsx                 ← bottom nav (replaces mobile/MobileNav)
│
├── mobile/                           ← mobile-specific views only
│   ├── CommandCenter.tsx             ← home screen on mobile
│   └── components/
│       └── [mobile-specific only]
│
├── lib/
│   ├── api.ts                        ← KEEP AS-IS
│   ├── auth.tsx                      ← KEEP AS-IS
│   ├── query-client.ts               ← move QueryClient config here
│   ├── time.ts                       ← KEEP AS-IS
│   └── cn.ts                         ← KEEP AS-IS
│
├── App.tsx                           ← routing only, no logic
├── main.tsx                          ← entry point, providers
└── index.css                         ← imports tokens.css + global resets only
```

---

## THE DESIGN SYSTEM

### tokens.css — Complete Specification

```css
/* ============================================================
   Averrow Design System — CSS Custom Properties
   All visual decisions live here. Change here = changes everywhere.
   ============================================================ */

:root {
  /* ── Page backgrounds ── */
  --bg-page:      #060A14;
  --bg-card:      rgba(22, 30, 48, 0.85);
  --bg-card-deep: rgba(12, 18, 32, 0.95);
  --bg-elevated:  rgba(18, 26, 44, 0.92);
  --bg-sidebar:   rgba(10, 16, 30, 0.96);
  --bg-input:     rgba(15, 22, 38, 0.80);

  /* ── Primary accents ── */
  --amber:        #E5A832;
  --amber-dim:    #B8821F;
  --amber-glow:   rgba(229, 168, 50, 0.20);
  --amber-border: rgba(229, 168, 50, 0.25);

  --red:          #C83C3C;
  --red-dim:      #8B1A1A;
  --red-glow:     rgba(200, 60, 60, 0.20);
  --red-border:   rgba(200, 60, 60, 0.30);

  --blue:         #0A8AB5;
  --blue-dim:     #065A78;
  --blue-glow:    rgba(10, 138, 181, 0.20);
  --blue-border:  rgba(10, 138, 181, 0.25);

  --green:        #3CB878;
  --green-dim:    #1A6B3C;
  --green-glow:   rgba(60, 184, 120, 0.20);
  --green-border: rgba(60, 184, 120, 0.25);

  /* ── Severity ── */
  --sev-critical:        #f87171;
  --sev-critical-bg:     rgba(239, 68, 68, 0.10);
  --sev-critical-border: rgba(239, 68, 68, 0.30);

  --sev-high:        #fb923c;
  --sev-high-bg:     rgba(249, 115, 22, 0.08);
  --sev-high-border: rgba(249, 115, 22, 0.25);

  --sev-medium:        #fbbf24;
  --sev-medium-bg:     rgba(229, 168, 50, 0.08);
  --sev-medium-border: rgba(229, 168, 50, 0.22);

  --sev-low:        #60a5fa;
  --sev-low-bg:     rgba(59, 130, 246, 0.07);
  --sev-low-border: rgba(59, 130, 246, 0.20);

  --sev-info:        #4ade80;
  --sev-info-bg:     rgba(74, 222, 128, 0.07);
  --sev-info-border: rgba(74, 222, 128, 0.15);

  /* ── Text ── */
  --text-primary:   rgba(255, 255, 255, 0.92);
  --text-secondary: rgba(255, 255, 255, 0.60);
  --text-tertiary:  rgba(255, 255, 255, 0.40);
  --text-muted:     rgba(255, 255, 255, 0.25);
  --text-accent:    var(--amber);

  /* ── Borders ── */
  --border-base:     rgba(255, 255, 255, 0.09);
  --border-strong:   rgba(255, 255, 255, 0.14);
  --border-sidebar:  rgba(255, 255, 255, 0.07);

  /* ── Card depth (5 rules applied as vars) ── */
  --card-bg:      linear-gradient(160deg, var(--bg-card) 0%, var(--bg-card-deep) 100%);
  --card-rim:     inset 0 1px 0 var(--border-strong), inset 0 -1px 0 rgba(0,0,0,0.40);
  --card-shadow:  0 8px 32px rgba(0, 0, 0, 0.60);
  --card-radius:  16px;

  /* ── Typography ── */
  --font-sans:  system-ui, -apple-system, sans-serif;
  --font-mono:  'IBM Plex Mono', 'Fira Code', monospace;

  /* ── Z-index ── */
  --z-base:            0;
  --z-dropdown:      100;
  --z-sidebar-overlay: 200;
  --z-sidebar:       300;
  --z-modal:         400;
  --z-toast:         500;
}

/* ── Light theme override ── */
[data-theme="light"] {
  --bg-page:      #F2F4F8;
  --bg-card:      rgba(255, 255, 255, 0.90);
  --bg-card-deep: rgba(245, 247, 252, 0.95);
  --bg-elevated:  rgba(255, 255, 255, 0.95);
  --bg-sidebar:   rgba(255, 255, 255, 0.97);
  --bg-input:     rgba(255, 255, 255, 0.80);

  --text-primary:   rgba(15, 20, 35, 0.92);
  --text-secondary: rgba(15, 20, 35, 0.60);
  --text-tertiary:  rgba(15, 20, 35, 0.40);
  --text-muted:     rgba(15, 20, 35, 0.25);

  --border-base:    rgba(0, 0, 0, 0.08);
  --border-strong:  rgba(0, 0, 0, 0.14);
  --border-sidebar: rgba(0, 0, 0, 0.08);

  --card-bg:     linear-gradient(160deg, rgba(255,255,255,0.90), rgba(245,247,252,0.95));
  --card-rim:    inset 0 1px 0 rgba(255,255,255,0.80), inset 0 -1px 0 rgba(0,0,0,0.06);
  --card-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);

  /* Accents stay the same in light mode */
  /* Severity stays the same in light mode */
}
```

### Component Specifications

#### Card.tsx (replaces Card.tsx + DeepCard.tsx)
```tsx
type CardVariant = 'base' | 'elevated' | 'active' | 'critical';

interface CardProps {
  children: React.ReactNode;
  variant?: CardVariant;
  accent?: string;       // custom accent color for 'active' variant
  padding?: string | number;
  radius?: number;
  style?: React.CSSProperties;
  className?: string;
  onClick?: () => void;
}
```
- Uses `var(--card-bg)`, `var(--card-rim)`, `var(--card-shadow)`, `var(--card-radius)`
- `active` variant adds amber glow + amber border
- `critical` variant adds red background + red glow
- `accent` prop overrides active variant colors
- Top rim + bottom rim pseudo-divs (the depth technique)
- Replaces ALL uses of: Card, glass-card, glass-elevated, glass-stat, DeepCard

#### Button.tsx (replaces Button.tsx + DimensionalButton.tsx)
```tsx
type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps {
  children: React.ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  loading?: boolean;
  disabled?: boolean;
  icon?: React.ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
}
```
- `primary` → amber gradient (linear-gradient(135deg, var(--amber), var(--amber-dim)))
- `secondary` → glass dark
- `danger` → red gradient
- `ghost` → transparent
- ALL use rim lighting (inset top + bottom shadows)
- Replaces ALL uses of: Button, DimensionalButton, glass-btn

#### Badge.tsx (replaces Badge.tsx + SeverityChip.tsx)
```tsx
// Severity badges
type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

// Status badges
type Status = 'active' | 'inactive' | 'pending' | 'draft' | 'success' |
              'failed' | 'running' | 'healthy' | 'degraded';

interface BadgeProps {
  severity?: Severity;   // for severity display
  status?: Status;       // for status display
  label?: string;        // override display text
  size?: 'xs' | 'sm' | 'md';
  pulse?: boolean;       // pulsing dot for live items
}
```
- Uses `var(--sev-critical)`, `var(--sev-critical-bg)` etc.
- Status badges use appropriate semantic colors
- Replaces ALL uses of: Badge, SeverityChip, badge-glass CSS classes

#### Avatar.tsx (replaces DimensionalAvatar.tsx)
```tsx
interface AvatarProps {
  name: string;
  color?: string;         // solid gradient color (auto from name hash if omitted)
  dimColor?: string;
  size?: number;
  radius?: number;
  faviconUrl?: string;
  severity?: Severity;
  style?: React.CSSProperties;
}
```
- Auto-generates color from name if not provided
- Solid gradient treatment (the depth treatment)
- favicon + severity dot support
- Replaces ALL uses of: DimensionalAvatar, UserAvatar initials

#### StatCard.tsx (replaces BOTH StatCard components)
```tsx
interface StatCardProps {
  label: string;
  value: number | string;
  sublabel?: string;
  accent?: string;        // color for number glow
  variant?: 'base' | 'active' | 'critical';
  animate?: boolean;      // CountUp on mount
  onClick?: () => void;
}
```
- Uses Card internally
- Uses GlowNumber internally
- Replaces: components/ui/StatCard AND components/brands/StatCard

#### DataRow.tsx (new — replaces all inline row implementations)
```tsx
interface DataRowProps {
  children: React.ReactNode;
  severity?: Severity;
  unread?: boolean;
  onClick?: () => void;
  style?: React.CSSProperties;
}
```
- Built-in hover: amber left border + subtle glow
- Severity-aware hover (red for critical rows)
- Unread state: brighter left border + glow
- Replaces: ALL inline div/tr row implementations across every page

#### FilterBar.tsx (new — replaces all inline filter implementations)
```tsx
interface FilterOption {
  value: string;
  label: string;
  count?: number;
}

interface FilterBarProps {
  filters: FilterOption[];
  active: string;
  onChange: (value: string) => void;
  search?: {
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
  };
  actions?: React.ReactNode;  // right-side buttons
}
```
- Card wrapper, search input, filter pills, right-side actions
- Replaces: all inline filter/search implementations

#### Tabs.tsx (rebuild existing)
```tsx
interface Tab {
  id: string;
  label: string;
  count?: number;
  badge?: string;
}

interface TabsProps {
  tabs: Tab[];
  active: string;
  onChange: (id: string) => void;
  variant?: 'bar' | 'pills' | 'underline';
  sticky?: boolean;
}
```
- `bar` → amber active pill (current Tabs.tsx style, rebuilt)
- `underline` → amber underline (current BrandDetail tab bar)
- `pills` → filter pill style
- `sticky` → position sticky with blur backdrop
- All variants use CSS vars
- Replaces: Tabs.tsx + all inline tab implementations

#### PageHeader.tsx (new)
```tsx
interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  back?: { label: string; onClick: () => void };
  badge?: React.ReactNode;
}
```
- Consistent page title treatment across all pages
- Replaces: all inline page title divs

#### StatGrid.tsx (new)
```tsx
interface StatGridProps {
  children: React.ReactNode;
  cols?: 2 | 3 | 4;       // responsive columns
}
```
- Responsive grid wrapper for stat cards
- Replaces: all inline grid/flex stat card containers

#### Modal.tsx (new — replaces Dropdown + BottomSheet)
```tsx
interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
  width?: number;
  // On mobile → slides up as sheet
  // On desktop → appears as dropdown or centered modal
}
```
- Single component, adapts to viewport
- Replaces: Dropdown.tsx + BottomSheet.tsx + mobile/BottomSheet.tsx

---

## THEME SYSTEM

### useTheme.ts
```typescript
type Theme = 'dark' | 'light';

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    return (localStorage.getItem('averrow-theme') as Theme) ?? 'dark';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('averrow-theme', theme);
  }, [theme]);

  const toggle = () => setTheme(t => t === 'dark' ? 'light' : 'dark');

  return { theme, setTheme, toggle, isDark: theme === 'dark' };
}
```

### Theme toggle location
TopBar → right side, before notifications bell.
Sun/moon icon. Persists in localStorage.
Applies `data-theme` to `<html>`. All CSS vars update instantly.

---

## RESPONSIVE STRATEGY

### One Shell, Not Two UIs
Shell.tsx detects mobile via `useBreakpoint()` and adapts:
- Mobile: no sidebar, show MobileNav (bottom bar), full-width content
- Desktop: sidebar visible, TopBar visible, content with left margin

### Mobile-Specific Views (only where truly different)
- `mobile/CommandCenter.tsx` — the home dashboard (genuinely different)
- All other pages: same component, responsive CSS, no isMobile branching

### The Rule
If a page is just a narrower version of desktop → NO separate mobile component.
If a page is fundamentally different on mobile → dedicated mobile view.

Currently only CommandCenter qualifies for a dedicated mobile view.
Observatory mobile chrome → handled by responsive CSS on ObservatoryChrome.tsx.
Everything else → one component, responsive.

---

## HOOKS REORGANIZATION

Keep all hook files. Just move them to live next to their feature:

```
features/brands/hooks.ts     → re-exports useBrands, useBrandStats etc.
features/threats/hooks.ts    → re-exports useThreatActors etc.
features/alerts/hooks.ts     → re-exports useAlerts
features/admin/hooks.ts      → re-exports useAdminOrgs, useAuditLog etc.
...
```

The original hook files in `hooks/` become the implementation files.
Feature hooks files are just re-exports.
This means pages import from their feature: `import { useBrands } from '../hooks'`
rather than `import { useBrands } from '@/hooks/useBrands'`.

No hook logic changes. No API changes. Pure file organization.

---

## MIGRATION SEQUENCE

Each session is a focused Claude Code task. Do not combine sessions.
Commit after each session. Keep master green throughout.

### Session completion tracker

Status reflects what's landed in `packages/averrow-ops/` on `master`. Use this as the source of truth for which session to start next — individual session sub-headings below stay immutable so their specs remain readable.

| Session | Status | Evidence / notes |
|---------|--------|------------------|
| R1 — Design system foundation | ✅ Landed | `design-system/tokens.css`, `design-system/hooks/useTheme.ts`, `design-system/hooks/useBreakpoint.ts` present |
| R2 — Rebuild Card + Button + Badge | ✅ Landed | `components/ui/Card.tsx`, `Button.tsx`, `Badge.tsx` rebuilt; re-exported via `design-system/components/index.ts` |
| R3 — Unify StatCard + Avatar + GlowNumber | ✅ Landed | `components/brands/StatCard.tsx` deleted; single `components/ui/StatCard.tsx` with `SimpleStatCard` / `DetailStatCard`; `DimensionalAvatar` is now an alias for `Avatar` |
| R4 — Tabs + DataRow + FilterBar + Modal | 🟡 Partial | Tabs, DataRow, FilterBar all present; Modal not yet exported from the barrel — confirm whether a new Modal shipped or the need was absorbed by Dropdown removal |
| R5 — PageHeader + StatGrid + barrel | ✅ Landed | `PageHeader`, `StatGrid`, `design-system/components/index.ts` all present |
| R6 — Feature folder structure | ✅ Landed | `src/features/` exists with `admin`, `agents`, `alerts`, `brands`, `campaigns`, `feeds`, `leads`, `observatory`, `observatory-v3`, `providers`, `settings`, `spam-trap`, `takedowns`, `threat-actors`, `threats`, `trends` |
| R7 — Shell responsive + MobileNav | ✅ Landed | `src/mobile/` folder removed; Shell handles responsive layout |
| R8 — Apply DataRow + FilterBar to all pages | ✅ Landed | Page migrations done across Alerts (#1083), Takedowns (#1084), Providers (#1085), Metrics PipelineAutomation (#1086), Incidents (#1087), Campaigns + Alerts banner (#1088). Threats / Brands / Feeds / Agents / Leads / Admin Dashboard already use design-system primitives correctly — no further consolidation required |
| R9 — Remove old tokens | 🟡 Effectively done | Zero R8 / feature pages reference the legacy classes. `index.css` definitions for `.glass-card`, `.glass-card-amber`, `.badge-glass` are kept because the FROZEN components (`ThreatMap.tsx`, `PortfolioHealthCard.tsx` — see "WHAT NEVER CHANGES" below) still use them. Full deletion of the class definitions is blocked until those frozen components are unfrozen (out of scope) |
| R10 — Observatory chrome + Mobile polish | ⏳ Not started | Observatory tab chrome + `MobileCommandCenter` refresh pending. Audit Rsp1-5 mobile polish targets are part of this session |
| R-Bundle-C-Primitives — 6 spec amendments from 2026-05-06 audit | ✅ Landed (session 1) | `StatCard` + `StatTile` zero-state rule (`resolveStatAccent` in `design-system/tokens.ts`); `Badge.context` + `Badge.verdict` types (NEXUS / PIVOT / ACCELERATING / QUIET / WORSENING / IMPROVING; CLEAR / DRAINING / STEADY / GROWING / STALE / UPDATED / STABLE); new `PriorityBar` and `StateMachineButtons` components; `EmptyState` semantic-alias variants (success / empty-list / data-unavailable / configure-me) |

When a session lands, update this table in the same commit — do not wait for a batch "docs update" pass.

### Bundle C amendments — 6 spec updates from 2026-05-06 audit

These primitives were promoted to the design system after the 2026-05-06 UI audit (`docs/UI_AUDIT_2026-05-06.md`) found them re-implemented inline on multiple surfaces. Each amendment was authorized by the operator under "if you need to change patterns because the concept is better and more best practice or visually stunning then let's do that across the platform and update the UI guidance plans."

1. **StatCard zero-state rule** — `resolveStatAccent(value, accent)` in `design-system/tokens.ts`. When `value === 0`, accent resolves to `M.NEUTRAL` (slate `#5a6a85`) regardless of caller. Wired in `StatCard.SimpleStatCard` and `StatTile`. Kills the red-on-zero anti-pattern (audit M2). String values are coerced — `"0"`, `"0,000"`, `"0%"` all neutralize; `"—"` / `"N/A"` keep the caller's accent (data-missing ≠ zero).
2. **`Badge.context`** — promotes the inline NEXUS / PIVOT / ACCELERATING / QUIET / WORSENING / IMPROVING tags from Provider cards. Reusable on Threat Actor cards, Campaign cards, infrastructure cluster rows.
3. **`Badge.verdict`** — promotes the pipeline verdict pills from Metrics: CLEAR / DRAINING / STEADY / GROWING / STALE / UPDATED / STABLE. Reusable on any monitor / health-probe surface.
4. **`PriorityBar`** — promotes the Takedown card's priority bar (0–100 with auto color derivation: green<30 / amber<60 / orange<80 / red≥80). Reusable on Alerts, Leads, scoring rows. `showLabel` toggles the inline `Priority N/M` caption.
5. **`StateMachineButtons<T>`** — promotes the Incident detail's INVESTIGATING / IDENTIFIED / MONITORING / RESOLVED row. Generic over the state type so the same primitive drives Takedown state, Alert state, or future workflow surfaces. `reachable?` prop disables transitions the caller deems invalid.
6. **`EmptyState` semantic-alias variants** — adds `success` / `empty-list` / `data-unavailable` / `configure-me` as semantic aliases for the existing `clean` / `error` / `locked` visual variants. Same render, more readable call sites.

Subsequent R8 page migrations (Alerts → Threats → Takedowns → Brands → Campaigns → Providers → Feeds → Agents → Admin → Leads) replace inline ad-hoc implementations with the unified primitives.



### Session R1 — Design System Foundation
**What:** Create `design-system/tokens.css` + `design-system/hooks/useTheme.ts`
**Files created:** tokens.css, useTheme.ts, useBreakpoint.ts (moved from hooks/)
**Files changed:** index.css (import tokens.css, remove old token definitions)
**Result:** Dark/light theme toggle works. No visual changes yet (tokens not wired to components).
**Time:** 1 session

### Session R2 — Rebuild Card + Button + Badge
**What:** Rebuild 3 base components using CSS vars. Drop-in replacements.
**Files changed:** Card.tsx, Button.tsx, Badge.tsx
**Same import paths.** Same APIs with new variants added.
**All 71 files get the depth treatment automatically on next render.**
**Time:** 1 session

### Session R3 — Unify StatCard + Avatar + GlowNumber
**What:** Rebuild StatCard (one component), rebuild Avatar from DimensionalAvatar
**Files changed:** components/ui/StatCard.tsx
**Files deleted:** components/brands/StatCard.tsx
**Files changed:** DimensionalAvatar.tsx → Avatar.tsx (with alias export)
**Update imports:** All pages using brands/StatCard → ui/StatCard
**Time:** 1 session

### Session R4 — Rebuild Tabs + DataRow + FilterBar + Modal
**What:** Rebuild Tabs, create DataRow, FilterBar, Modal
**Files changed:** Tabs.tsx
**Files created:** DataRow.tsx, FilterBar.tsx, Modal.tsx
**Files deleted:** Dropdown.tsx, BottomSheet.tsx, mobile/BottomSheet.tsx
**Time:** 1 session

### Session R5 — PageHeader + StatGrid + update design-system/index.ts
**What:** Create layout components, finalize barrel export
**Files created:** PageHeader.tsx, StatGrid.tsx, design-system/components/index.ts
**Time:** 1 session

### Session R6 — Feature folder structure
**What:** Create features/ directory. Move pages into feature folders.
**No rewrites.** Just moves + import path updates.
**Routing in App.tsx unchanged** — just import paths change.
**Time:** 1 session

### Session R7 — Shell responsive + MobileNav
**What:** Make Shell.tsx truly responsive. Extract MobileNav from MobileCommandCenter.
**Remove isMobile branching from page components.**
**Time:** 1 session

### Session R8 — Apply DataRow + FilterBar to all pages
**What:** Replace all inline row/filter implementations with shared components.
**This is where all pages become visually consistent.**
**Go page by page: Alerts, Threats, Takedowns, Brands, Campaigns, Providers, Feeds, Agents, Admin, Leads**
**Time:** 2-3 sessions (split by page group)

### Session R9 — Remove old tokens
**What:** Delete old CSS classes (glass-card, badge-glass etc.) from index.css.
**Verify:** Every page renders correctly. Fix any stragglers.
**Time:** 1 session

### Session R10 — Observatory chrome + Mobile polish
**What:** Upgrade Observatory mode tabs/stat bar/panel to new components.
**Polish MobileCommandCenter with new design system.**
**Time:** 1 session

---

## WHAT NEVER CHANGES DURING RESTRUCTURE

These files are frozen throughout all sessions:
- packages/trust-radar/src/** — backend untouched
- ThreatMap.tsx — WebGL canvas untouched
- ExposureGauge.tsx — custom SVG untouched
- PortfolioHealthCard.tsx — SVG donut untouched
- Sparkline.tsx, ActivitySparkline.tsx — untouched
- EventTicker.tsx — untouched
- All hook logic — only file locations change
- All API endpoints — untouched
- lib/api.ts, lib/auth.tsx — untouched

---

## RULES FOR ALL RESTRUCTURE SESSIONS

1. READ this document before writing any code
2. DIAGNOSE the current state of files before changing them
3. ONE concern per session — don't mix foundation work with page work
4. SAME API — components are drop-in replacements, not rewrites
5. TYPECHECK must pass after every session
6. COMMIT after every session with a clear message
7. NEVER combine sessions — if a session feels too big, split it
8. PRESERVE all existing functionality — restructure is not a feature sprint
9. KEEP master green — every commit is deployable

---

## SUCCESS CRITERIA

After all sessions complete:
- [ ] Dark/light toggle in TopBar works instantly platform-wide
- [ ] All 71 files use CSS vars, not hardcoded hex values
- [ ] One Card component. One Button. One Badge. One StatCard. One Avatar.
- [ ] All pages use DataRow for clickable rows (hover treatment consistent)
- [ ] All pages use FilterBar for search/filter (consistent UI)
- [ ] All pages use PageHeader (consistent page titles)
- [ ] All pages use StatGrid (consistent stat card layout)
- [ ] Mobile is Shell + MobileNav, not a separate app
- [ ] Feature folders — each domain is self-contained
- [ ] pnpm typecheck passes with zero errors
- [ ] Observatory WebGL still works
- [ ] All existing functionality preserved
- [ ] One platform. Desktop/Mobile. Dark/Light. Done.
