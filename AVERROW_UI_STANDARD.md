# Averrow UI Standard — v1.0
> **NOTE:** `RESTRUCTURE_SPEC.md` is the authoritative source for new development.
> This document remains as a component quick-reference for the depth treatment and color tokens.
> When in conflict, RESTRUCTURE_SPEC.md wins.
# April 2026 — Source of truth for all Claude Code sessions
# Every component, token, and pattern locked here first

---

## WHAT THIS IS

This document defines the Averrow visual language.
Every Claude Code session that touches UI must reference this first.
No inline styles, no one-off glass treatments, no flat colors.
Every surface uses this system or it gets rewritten.

---

## THE 5 DEPTH RULES

These 5 properties applied together create the dimensional look.
Every card, panel, button, and badge in the platform uses some combination.

```
1. GRADIENT FILL
   Not flat rgba. Always a gradient from lighter-dark to deeper-dark.
   light edge: rgba(22,30,48,0.85)
   deep edge:  rgba(12,18,32,0.95)
   direction:  160deg for cards, 145deg for buttons, 150deg for accented

2. TOP RIM HIGHLIGHT
   inset 0 1px 0 rgba(255,255,255,0.14)
   Simulates light hitting the top edge of glass.
   This is the single biggest contributor to perceived depth.
   Accent-colored surfaces use: inset 0 1px 0 [accent-color]30

3. BOTTOM RIM SHADOW
   inset 0 -1px 0 rgba(0,0,0,0.40)
   Pushes the bottom edge back. Creates the "physical object" feel.
   Without this, the top highlight looks like a sticker not glass.

4. OUTER DEPTH SHADOW
   0 8px 32px rgba(0,0,0,0.60)
   Lifts the element off the background layer.
   Elevated surfaces: 0 12px 48px rgba(0,0,0,0.75)

5. ACCENT GLOW (active/colored elements only)
   0 0 20px [accent]18
   Data drives the light — amber for live data, red for critical,
   blue for infrastructure, green for healthy/operational.
   Never apply glow to neutral/inactive elements.
```

---

## COLOR TOKENS

```typescript
// PRIMARY ACCENTS
AMBER     = '#E5A832'  // Afterburner — primary accent, live data, CTAs
AMBER_DIM = '#B8821F'  // Gradient pair for solid buttons/avatars

RED       = '#C83C3C'  // Signal Red — critical, threats, alerts, danger
RED_DIM   = '#8B1A1A'  // Gradient pair

BLUE      = '#0A8AB5'  // Wing Blue — infrastructure, agents, info
BLUE_DIM  = '#065A78'  // Gradient pair

GREEN     = '#3CB878'  // Operational — healthy, feeds active, pass
GREEN_DIM = '#1A6B3C'  // Gradient pair

// BACKGROUND LAYERS
BG_DEEP   = '#060A14'  // Page background — the void
BG_L1     = rgba(22,30,48,0.85)   // Card surface light edge
BG_L2     = rgba(12,18,32,0.95)   // Card surface deep edge
BG_SIDEBAR = rgba(10,16,30,0.92)  // Sidebar/elevated panels

// BORDERS
BORDER_BASE     = rgba(255,255,255,0.09)  // Standard card border
BORDER_ELEVATED = rgba(255,255,255,0.11)  // Panels, modals
BORDER_ACCENT   = [accent]30              // Colored card border
BORDER_CRITICAL = rgba(239,68,68,0.35)    // Critical state border

// TEXT
TEXT_PRIMARY   = rgba(255,255,255,0.92)  // Headings, names, key data
TEXT_SECONDARY = rgba(255,255,255,0.60)  // Descriptions, subtitles
TEXT_TERTIARY  = rgba(255,255,255,0.40)  // Labels, metadata, timestamps
TEXT_MUTED     = rgba(255,255,255,0.25)  // Disabled, placeholders only
TEXT_ACCENT    = [accent color]          // Live numbers, CTAs, active states
```

---

## SEVERITY SYSTEM

`text` is `var(--sev-*-text)` (tokens.css), not a literal hex — it
resolves to the same hex shown for `dot`'s sibling values in dark mode,
and to a darker, AA-contrast-checked hex in `[data-theme="light"]`.
Never hardcode the dark-mode hex directly; that's exactly the drift
this table used to have (S2.3 design review, 2026-07).

```typescript
const SEV = {
  critical: {
    dot:    '#f87171',
    bg:     'rgba(239,68,68,0.10)',
    border: 'rgba(239,68,68,0.30)',
    text:   'var(--sev-critical-text)',
    glow:   'rgba(239,68,68,0.50)',
    dim:    '#7f1d1d',
  },
  high: {
    dot:    '#fb923c',
    bg:     'rgba(249,115,22,0.08)',
    border: 'rgba(249,115,22,0.25)',
    text:   'var(--sev-high-text)',
    glow:   'rgba(249,115,22,0.50)',
    dim:    '#7c2d12',
  },
  medium: {
    dot:    '#fbbf24',
    bg:     'rgba(229,168,50,0.08)',
    border: 'rgba(229,168,50,0.22)',
    text:   'var(--sev-medium-text)',
    glow:   'rgba(229,168,50,0.50)',
    dim:    '#78350f',
  },
  low: {
    dot:    '#60a5fa',
    bg:     'rgba(59,130,246,0.07)',
    border: 'rgba(59,130,246,0.20)',
    text:   'var(--sev-low-text)',
    glow:   'rgba(59,130,246,0.40)',
    dim:    '#1e3a5f',
  },
  info: {
    dot:    '#4ade80',
    bg:     'rgba(74,222,128,0.07)',
    border: 'rgba(74,222,128,0.15)',
    text:   'var(--sev-info-text)',
    glow:   'rgba(74,222,128,0.40)',
    dim:    '#14532d',
  },
};
```

---

## EMAIL GRADE SYSTEM

B/C/D/F `text` values are `var(--sev-*-text)` for the same reason as
above. A+/A keep their literal `#6ee7b7` — it's a distinct, brighter
green than `--sev-info-text` and doesn't byte-match any severity token.

```typescript
const GRADE = {
  'A+': { bg: 'linear-gradient(135deg,rgba(16,185,129,0.25),rgba(16,185,129,0.10))', border: 'rgba(16,185,129,0.50)', text: '#6ee7b7', glow: 'rgba(16,185,129,0.30)' },
  'A':  { bg: 'linear-gradient(135deg,rgba(16,185,129,0.20),rgba(16,185,129,0.08))', border: 'rgba(16,185,129,0.40)', text: '#6ee7b7', glow: 'rgba(16,185,129,0.25)' },
  'B':  { bg: 'linear-gradient(135deg,rgba(59,130,246,0.18),rgba(59,130,246,0.07))', border: 'rgba(59,130,246,0.35)', text: 'var(--sev-low-text)', glow: 'rgba(59,130,246,0.25)' },
  'C':  { bg: 'linear-gradient(135deg,rgba(229,168,50,0.18),rgba(229,168,50,0.07))',  border: 'rgba(229,168,50,0.35)',  text: 'var(--sev-medium-text)', glow: 'rgba(229,168,50,0.25)' },
  'D':  { bg: 'linear-gradient(135deg,rgba(249,115,22,0.18),rgba(249,115,22,0.07))',  border: 'rgba(249,115,22,0.35)',  text: 'var(--sev-high-text)', glow: 'rgba(249,115,22,0.25)' },
  'F':  { bg: 'linear-gradient(135deg,rgba(239,68,68,0.22),rgba(239,68,68,0.08))',    border: 'rgba(239,68,68,0.45)',   text: 'var(--sev-critical-text)', glow: 'rgba(239,68,68,0.30)' },
};
```

---

## CORE COMPONENTS

### 1. DeepCard — The Foundation

> **Removed in UI consolidation Phase 1 PR6a (2026-10).** `components/ui/DeepCard.tsx` was a re-export of `Card` and is deleted; every call site now uses `Card` (`import { Card } from '@/design-system/components'`). The variants below are `Card`'s variants. The code excerpt is retained as historical reference only.

Four variants. Every card in the platform is one of these.

```tsx
// packages/averrow-ops/src/components/ui/DeepCard.tsx

type DeepVariant = 'base' | 'elevated' | 'active' | 'critical';

interface DeepCardProps {
  children: React.ReactNode;
  variant?: DeepVariant;
  accentColor?: string;   // drives glow + border + rim on 'active'
  style?: React.CSSProperties;
  className?: string;
  onClick?: () => void;
}

const VARIANT_CONFIG = {
  // Standard content — Layer 2
  base: {
    bg:     'linear-gradient(160deg, rgba(22,30,48,0.85) 0%, rgba(12,18,32,0.95) 100%)',
    border: 'rgba(255,255,255,0.09)',
    rim:    'rgba(255,255,255,0.14)',
    shadow: '0 8px 32px rgba(0,0,0,0.60)',
  },
  // Panels, modals, dropdowns — Layer 3
  elevated: {
    bg:     'linear-gradient(160deg, rgba(18,26,44,0.92) 0%, rgba(8,12,24,0.98) 100%)',
    border: 'rgba(255,255,255,0.11)',
    rim:    'rgba(255,255,255,0.18)',
    shadow: '0 12px 48px rgba(0,0,0,0.75)',
  },
  // Live data, metrics — amber glow — Layer 4
  active: {
    bg:     'linear-gradient(160deg, rgba(22,30,48,0.85) 0%, rgba(12,18,32,0.95) 100%)',
    border: 'rgba(229,168,50,0.22)',
    rim:    'rgba(229,168,50,0.35)',
    shadow: '0 8px 32px rgba(0,0,0,0.60), 0 0 20px rgba(229,168,50,0.10)',
  },
  // Critical/high-severity — red glow
  critical: {
    bg:     'linear-gradient(150deg, rgba(40,12,12,0.95) 0%, rgba(15,8,8,0.98) 100%)',
    border: 'rgba(239,68,68,0.35)',
    rim:    'rgba(239,68,68,0.45)',
    shadow: '0 8px 32px rgba(0,0,0,0.70), 0 0 24px rgba(239,68,68,0.15)',
  },
};

export function DeepCard({
  children, variant = 'base', accentColor,
  style = {}, className = '', onClick
}: DeepCardProps) {
  // Allow accentColor to override border/rim/glow on 'active' variant
  const cfg = { ...VARIANT_CONFIG[variant] };
  if (accentColor && variant === 'active') {
    cfg.border = `${accentColor}30`;
    cfg.rim    = `${accentColor}40`;
    cfg.shadow = `0 8px 32px rgba(0,0,0,0.60), 0 0 20px ${accentColor}18`;
  }

  return (
    <div
      onClick={onClick}
      className={className}
      style={{
        background:           cfg.bg,
        backdropFilter:       'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border:               `1px solid ${cfg.border}`,
        boxShadow:            [
          cfg.shadow,
          `inset 0 1px 0 ${cfg.rim}`,
          'inset 0 -1px 0 rgba(0,0,0,0.40)',
        ].join(', '),
        borderRadius:         16,
        position:             'relative',
        overflow:             'hidden',
        cursor:               onClick ? 'pointer' : 'default',
        ...style,
      }}
    >
      {/* Top rim light — the most important depth signal */}
      <div style={{
        position:   'absolute', top: 0, left: 0, right: 0, height: 1,
        background: `linear-gradient(90deg, transparent, ${cfg.rim} 25%, ${cfg.rim} 75%, transparent)`,
        pointerEvents: 'none', zIndex: 2,
      }} />
      {/* Bottom rim shadow */}
      <div style={{
        position:   'absolute', bottom: 0, left: 0, right: 0, height: 1,
        background: 'rgba(0,0,0,0.50)',
        pointerEvents: 'none', zIndex: 2,
      }} />
      {children}
    </div>
  );
}
```

**Usage:**
```tsx
// Standard card
<DeepCard>...</DeepCard>

// Panel / modal
<DeepCard variant="elevated">...</DeepCard>

// Live stat (amber glow)
<DeepCard variant="active">...</DeepCard>

// Branded accent color
<DeepCard variant="active" accentColor="#0A8AB5">...</DeepCard>

// Critical alert
<DeepCard variant="critical">...</DeepCard>
```

---

### 2. DimensionalAvatar — Solid gradient avatar

> **Removed in PR6a (2026-10).** `components/ui/DimensionalAvatar.tsx`, `Avatar.tsx` and `BrandAvatar.tsx` are deleted. Entity avatars use the shared kit `Avatar` (`@averrow/shared/ui`, re-exported by `@/design-system/components`): `size={40} glow` is the old BrandAvatar look, `tone="neutral"` the quiet list-row tile, and `label` makes a standalone avatar `role="img"`. User avatars stay initials-only (`UserAvatar`). The code excerpt is retained as historical reference only.

Used for: brand initials, user avatar, threat actor, org logo placeholders.
This is what makes the "CL" button and brand avatars look physical.

```tsx
// packages/averrow-ops/src/components/ui/DimensionalAvatar.tsx

interface DimensionalAvatarProps {
  name: string;          // uses first character
  color: string;         // solid gradient top color
  dimColor?: string;     // solid gradient bottom color (default: darken color)
  size?: number;         // px, default 40
  radius?: number;       // border-radius px, default 12
  fontSize?: number;     // default auto from size
}

export function DimensionalAvatar({
  name, color, dimColor, size = 40, radius = 12, fontSize
}: DimensionalAvatarProps) {
  const dim = dimColor ?? `${color}80`; // fallback: 50% opacity
  const fs  = fontSize ?? Math.round(size * 0.375);

  return (
    <div style={{
      width:  size, height: size, borderRadius: radius,
      flexShrink: 0,
      // Solid gradient — NO opacity suffix — this is the key difference
      background: `linear-gradient(145deg, ${color}, ${dim})`,
      border:     `1px solid ${color}70`,
      boxShadow: [
        `0 ${Math.round(size*0.1)}px ${Math.round(size*0.35)}px rgba(0,0,0,0.70)`, // depth
        'inset 0 1px 0 rgba(255,255,255,0.28)',                                     // top rim
        'inset 0 -1px 0 rgba(0,0,0,0.45)',                                          // bottom rim
        `0 0 ${Math.round(size*0.45)}px ${color}35`,                               // outer glow
      ].join(', '),
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: fs, fontWeight: 900,
      color: '#fff',
      textShadow: '0 1px 3px rgba(0,0,0,0.65)',
    }}>
      {name[0]?.toUpperCase() ?? '?'}
    </div>
  );
}
```

**Usage:**
```tsx
// Brand avatar — red
<DimensionalAvatar name="Acme Corp" color="#C83C3C" dimColor="#8B1A1A" />

// User avatar
<DimensionalAvatar name="Claude Leroux" color="#C83C3C" dimColor="#8B1A1A" size={36} radius={11} />

// Threat actor — blue
<DimensionalAvatar name="APT-Phantom" color="#0A8AB5" dimColor="#065A78" />

// Organization — amber
<DimensionalAvatar name="LRX Enterprises" color="#E5A832" dimColor="#B8821F" />
```

---

### 3. SeverityChip — legacy alias for Badge

> **Removed in PR6a (2026-10).** `SeverityChip.tsx`, `SeverityPill.tsx` and the ops `Badge.tsx` are deleted. `Badge` is the shared kit component (accepts any/unknown/null `severity`, plus `status`, `context`, `verdict`, `classification`). The code excerpt is retained as historical reference only.

Superseded by `Badge` (§ CORE COMPONENTS). `SeverityChip.tsx` is now a
12-line compatibility wrapper that renders `<Badge severity={...} />` —
it no longer owns its own SEV_CONFIG, sizing, or JSX; that logic lives
in `Badge.tsx` (see the canonical `SEV` config under SEVERITY SYSTEM
above, whose `text` values are `var(--sev-*-text)` tokens, not literal
hex). Existing call sites keep working unchanged; **new code should
import `Badge` directly** (`@/design-system/components`).

```tsx
// packages/averrow-ops/src/components/ui/SeverityChip.tsx
import { Badge } from './Badge';
import type { Severity, BadgeSize } from './Badge';

export interface SeverityChipProps {
  severity: Severity;
  size?:    BadgeSize;
  pulse?:   boolean;
}

export function SeverityChip({ severity, size = 'sm', pulse = false }: SeverityChipProps) {
  return <Badge severity={severity} size={size} pulse={pulse} />;
}
```

---

### 4. GlowNumber — Animated metric with text shadow (retired in PR6b)

> `GlowNumber` and the ops `StatCard` were deleted; stat numbers are rendered by the
> shared `StatTile` (`@averrow/shared/ui`). The spec below is kept for history.

Used for: all stat tile numbers, threat counts, key metrics.

```tsx
// packages/averrow-ops/src/components/ui/GlowNumber.tsx
import { useCountUp } from '@/hooks/useCountUp';

interface GlowNumberProps {
  value: number;
  color: string;          // accent color — drives the glow
  size?: 'sm'|'md'|'lg'|'xl';
  animate?: boolean;      // CountUp on mount, default true
  format?: 'number'|'compact'; // compact: 1.2K, 25.6K etc
}

const SIZE_MAP = {
  sm: { fontSize: 18, letterSpacing: -0.5 },
  md: { fontSize: 24, letterSpacing: -0.5 },
  lg: { fontSize: 32, letterSpacing: -1 },
  xl: { fontSize: 42, letterSpacing: -2 },
};

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n/1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n/1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

export function GlowNumber({
  value, color, size = 'lg', animate = true, format = 'number'
}: GlowNumberProps) {
  const counted = useCountUp(animate ? value : 0, animate ? value : 0);
  const display = format === 'compact' ? compact(counted) : counted.toLocaleString();
  const sz = SIZE_MAP[size];

  return (
    <span style={{
      fontSize:     sz.fontSize,
      fontWeight:   900,
      fontFamily:   'monospace',
      letterSpacing: sz.letterSpacing,
      color,
      textShadow:   `0 0 20px ${color}60, 0 0 40px ${color}30`,
      tabularNums:  true,
    }}>
      {display}
    </span>
  );
}
```

---

### 5. SectionLabel — Consistent section headers

Used everywhere a section needs a label: "BRANDS AT RISK", "LATEST INTEL", etc.

```tsx
// packages/averrow-ops/src/components/ui/SectionLabel.tsx

interface SectionLabelProps {
  label: string;
  accent?: string;        // left bar color, default AMBER
  action?: string;        // right-side link text
  onAction?: () => void;
  attribution?: string;   // "Powered by Observer" style footnote
}

export function SectionLabel({
  label, accent = '#E5A832', action, onAction, attribution
}: SectionLabelProps) {
  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:11 }}>
      <div style={{ display:'flex', alignItems:'center', gap:10 }}>
        {/* Accent bar */}
        <div style={{
          width: 2, height: 14, borderRadius: 99,
          background: `linear-gradient(180deg, ${accent}, transparent)`,
          flexShrink: 0,
        }} />
        <div>
          <span style={{
            fontSize: 9, fontFamily: 'monospace', letterSpacing: '0.20em',
            color: 'rgba(255,255,255,0.45)', textTransform: 'uppercase',
            fontWeight: 700,
          }}>
            {label}
          </span>
          {attribution && (
            <span style={{
              fontSize: 8, fontFamily: 'monospace',
              color: 'rgba(255,255,255,0.22)', marginLeft: 8,
            }}>
              {attribution}
            </span>
          )}
        </div>
      </div>
      {action && (
        <span onClick={onAction} style={{
          fontSize: 11, color: accent, cursor: 'pointer', fontWeight: 700,
          textShadow: `0 0 10px ${accent}60`,
        }}>
          {action} →
        </span>
      )}
    </div>
  );
}
```

---

### 6. DimensionalButton — Primary and secondary buttons

> **Removed in PR6a (2026-10).** `components/ui/DimensionalButton.tsx` was a re-export of `Button` and is deleted; use `Button` from `@/design-system/components`.

```tsx
// packages/averrow-ops/src/components/ui/DimensionalButton.tsx

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

interface DimensionalButtonProps {
  children: React.ReactNode;
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}

const BUTTON_CONFIG = {
  primary: {
    bg:     `linear-gradient(135deg, #E5A832, #B8821F)`,
    border: 'rgba(229,168,50,0.60)',
    color:  '#000',
    rim:    'rgba(255,255,255,0.30)',
    shadow: '0 4px 16px rgba(229,168,50,0.40), 0 2px 4px rgba(0,0,0,0.40)',
    hover:  'linear-gradient(135deg, #F0B83C, #C8921F)',
  },
  secondary: {
    bg:     'linear-gradient(160deg, rgba(22,30,48,0.90), rgba(12,18,32,0.98))',
    border: 'rgba(255,255,255,0.12)',
    color:  'rgba(255,255,255,0.80)',
    rim:    'rgba(255,255,255,0.14)',
    shadow: '0 4px 16px rgba(0,0,0,0.40)',
    hover:  'linear-gradient(160deg, rgba(30,40,60,0.95), rgba(15,22,36,0.99))',
  },
  danger: {
    bg:     `linear-gradient(135deg, #C83C3C, #8B1A1A)`,
    border: 'rgba(239,68,68,0.60)',
    color:  '#fff',
    rim:    'rgba(255,120,120,0.35)',
    shadow: '0 4px 16px rgba(239,68,68,0.35), 0 2px 4px rgba(0,0,0,0.40)',
    hover:  'linear-gradient(135deg, #D84C4C, #9B2A2A)',
  },
  ghost: {
    bg:     'transparent',
    border: 'rgba(255,255,255,0.10)',
    color:  'rgba(255,255,255,0.60)',
    rim:    'transparent',
    shadow: 'none',
    hover:  'rgba(255,255,255,0.05)',
  },
};

const SIZE_CONFIG = {
  sm: { fontSize: 10, padding: '6px 14px',  radius: 8,  fontWeight: 700 },
  md: { fontSize: 11, padding: '9px 20px',  radius: 10, fontWeight: 800 },
  lg: { fontSize: 12, padding: '12px 28px', radius: 12, fontWeight: 800 },
};

export function DimensionalButton({
  children, variant = 'primary', size = 'md',
  fullWidth = false, onClick, disabled = false
}: DimensionalButtonProps) {
  const c = BUTTON_CONFIG[variant];
  const z = SIZE_CONFIG[size];

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display:        'inline-flex',
        alignItems:     'center',
        justifyContent: 'center',
        width:          fullWidth ? '100%' : 'auto',
        background:     c.bg,
        border:         `1px solid ${c.border}`,
        borderRadius:   z.radius,
        color:          c.color,
        fontSize:       z.fontSize,
        fontWeight:     z.fontWeight,
        fontFamily:     'monospace',
        letterSpacing:  '0.06em',
        textTransform:  'uppercase',
        padding:        z.padding,
        cursor:         disabled ? 'not-allowed' : 'pointer',
        opacity:        disabled ? 0.4 : 1,
        boxShadow:      [
          c.shadow,
          `inset 0 1px 0 ${c.rim}`,
          'inset 0 -1px 0 rgba(0,0,0,0.30)',
        ].join(', '),
        transition:     'all 0.15s ease',
        outline:        'none',
      }}
    >
      {children}
    </button>
  );
}
```

---

### 7. LiveIndicator — Pulsing live status dot

```tsx
// packages/averrow-ops/src/components/ui/LiveIndicator.tsx
// Already built in Phase 8a — ensure it matches this spec

export function LiveIndicator({
  label = 'LIVE', active = true, color = '#22c55e'
}: { label?: string; active?: boolean; color?: string }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:6 }}>
      <div style={{ position:'relative', width:8, height:8 }}>
        {active && (
          <div style={{
            position:'absolute', inset:0, borderRadius:'50%',
            background:color, opacity:0.65,
            animation:'live-ping 1.6s ease-in-out infinite',
          }} />
        )}
        <div style={{
          position:'relative', width:8, height:8, borderRadius:'50%',
          background: active ? color : 'rgba(255,255,255,0.20)',
          boxShadow: active ? `0 0 8px ${color}90` : 'none',
        }} />
      </div>
      <span style={{
        fontSize:8, fontFamily:'monospace', letterSpacing:'0.18em',
        color: active ? 'rgba(255,255,255,0.50)' : 'rgba(255,255,255,0.25)',
        textTransform:'uppercase',
      }}>
        {label}
      </span>
    </div>
  );
}
```

---

### 8. DeepBackground — Page atmosphere layer

> **Removed in UI consolidation Phase 1 PR3 (2026-10).** `components/ui/DeepBackground.tsx` was deleted along with the legacy Shell; the v4 shell (`components/layout/ShellV4.tsx`) owns the page atmosphere. The spec below is retained as historical reference only — do not import it.

```tsx
// packages/averrow-ops/src/components/ui/DeepBackground.tsx
// Already built in Phase 8a — this is the locked spec

export function DeepBackground() {
  return (
    <div style={{ position:'fixed', inset:0, zIndex:-1, overflow:'hidden', pointerEvents:'none' }}>
      {/* Base */}
      <div style={{ position:'absolute', inset:0, background:'#060A14' }} />
      {/* Top-left fog — intelligence origin */}
      <div style={{ position:'absolute', top:-120, left:-80, width:460, height:460, borderRadius:'50%', background:'rgba(10,37,64,0.40)', filter:'blur(130px)' }} />
      {/* Bottom-right amber — data activity */}
      <div style={{ position:'absolute', bottom:-140, right:-80, width:420, height:420, borderRadius:'50%', background:'rgba(229,168,50,0.055)', filter:'blur(150px)' }} />
      {/* Center screen glow */}
      <div style={{ position:'absolute', top:'35%', left:'50%', transform:'translateX(-50%)', width:700, height:300, borderRadius:'50%', background:'rgba(10,37,90,0.12)', filter:'blur(180px)' }} />
      {/* Subtle grid */}
      <div style={{ position:'absolute', inset:0, opacity:0.018, backgroundImage:'linear-gradient(rgba(255,255,255,0.15) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.15) 1px,transparent 1px)', backgroundSize:'64px 64px' }} />
      {/* Noise grain */}
      <div style={{ position:'absolute', inset:0, opacity:0.025, backgroundImage:`url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`, backgroundSize:'128px 128px' }} />
    </div>
  );
}
```

---

## Shared kit (`@averrow/shared/ui`)

Phase 1 PR5 (`docs/UI_CONSOLIDATION_PLAN_2026-10.md`). Source:
`packages/shared/src/ui/`, single barrel `index.ts`. Named exports only; no `@/`
or router imports, so ops and tenant render it identically. **New code imports
from the kit.** The legacy ops primitives documented above are collapsed into it
by PR6 (6a done: Badge, Tabs, FilterBar, Sparkline, Avatar, PageHeader; 6b done:
states and stat tiles; 6c done: Card and tables).

```tsx
import {
  Badge, StatTile, PageState, pageStateKind,
  DataTable, Table, Th, Td, Tabs, FilterBar,
  PageHeader, WorkspaceEmbedContext, WorkspaceEmbedProvider, useWorkspaceEmbed,
  Sparkline, Avatar, Button, Card,
} from '@averrow/shared/ui';
```

- **Avatar is for entities only** (brands, orgs, providers, actors). User avatars
  stay initials-only via `@averrow/shared/avatar` (`parseInitials`,
  `colorForUserId`, `SELF_AVATAR_COLOR`); there is no `avatarUrl` prop.
- **`PageState`**: `kind` (`loading | empty | clear | error | locked`) is
  required, no default. Error is never shown as empty or `0`. Derive it with
  `pageStateKind({ isLoading, isError, isEmpty })` (error > loading > empty;
  returns `null` when the data should render).
- **`PageHeader` inside a `TabbedWorkspace`** drops its `<h1>` and subtitle (the
  workspace owns the one h1); badge/meta/actions stay. Enabled by
  `WorkspaceEmbedProvider`/context, or the `embedded` prop.
- **`DataTable`**: the first click on a sortable column sorts descending; later
  clicks flip asc/desc.
- **Text colour**: `--text-secondary` or the `--sev-*-text` tokens for any text
  that must be read, not `--text-tertiary`/`--text-muted`.
- **Focus**: Tabs, Table (header cells, rows, scroll region) and FilterBar pills
  use `focus-visible:outline` (amber; inset inside scroll containers so it is
  not clipped). Button, StatTile and the PageHeader back control use the amber
  ring (`focus-visible:ring-2`).

**Ops import path (PR6a):** `@/design-system/components` is the single ops barrel
(`components/ui/index.ts` is gone). It re-exports Badge, Tabs, FilterBar, Sparkline
and Avatar straight from the kit, and exports an ops `PageHeader` adapter
(`design-system/components/PageHeader.tsx`) that wraps the kit header and maps
`back.to` to a router `navigate()` (the kit has no router import). Import all of
these from the barrel. PR6b added `PageState`, `pageStateKind` and `StatTile`
(the ops `EmptyState`, `StatCard`, `StatTile`, `GlowNumber` and `PageLoader` are
gone) plus the ops-local `BreakdownCard` (titled headline-metric + breakdown rows,
formerly `DetailStatCard`). The remaining ops primitives (Button, DataRow, ...) still
live in `components/ui/`.

**Card and tables (PR6c):** `Card`, `Table`, `Th`, `Td`, `Tr` and `DataTable` are
re-exported from the kit via the barrel (`components/ui/Card.tsx` and
`components/ui/Table.tsx` are gone). `Card` takes `variant`
(`base | elevated | active | critical | flat`), `accent` (only with `active`) and
`padding`: `none | sm | md | lg` (0/12/20/24px), a number (px) or raw CSS, default
`md` (20px). Pass `padding="none"` when composing `CardHeader`/`CardContent`/
`CardFooter`. There is no `hover` prop. Use `DataTable` for column-driven tables
and `Table`/`Th`/`Td` for hand-built ones. Never put `role="button"` on a `<tr>` that contains other controls; make the first cell hold a real disclosure/name `<button>` (`aria-expanded` + `aria-controls` for an expansion row) and treat the row click as a mouse convenience. `Card variant="flat"` is for panels inset in a table or card. No raw `<table>` in ops.

**List pages (PR6b):** never branch a list on `rows.length === 0` alone. Use
`pageStateKind({ isLoading, isError, isEmpty })` (error beats loading beats empty)
and pass `onRetry={refetch}`; if a refetch fails while data is on screen, keep the
data and render `<PageState kind="error" layout="inline" />`. Stat tiles take
`value={null}` while loading (never `'—'`, `'...'` or `0`) and `error` on failure.

---

## SIDEBAR STANDARD

The sidebar uses the same 5 depth rules. This replaces the current Phase 8a treatment.

```tsx
// Sidebar container
style={{
  background:           'linear-gradient(180deg, rgba(10,16,30,0.96) 0%, rgba(6,10,20,0.99) 100%)',
  backdropFilter:       'blur(24px)',
  WebkitBackdropFilter: 'blur(24px)',
  borderRight:          '1px solid rgba(255,255,255,0.07)',
  boxShadow:            '4px 0 48px rgba(0,0,0,0.60), inset -1px 0 0 rgba(255,255,255,0.05)',
}}

// Section headers (INTELLIGENCE / RESPONSE / PLATFORM)
// Label + horizontal line
<div style={{ display:'flex', alignItems:'center', gap:8, padding:'16px 16px 6px' }}>
  <span style={{ fontSize:9, fontFamily:'monospace', letterSpacing:'0.22em', color:'rgba(255,255,255,0.35)', textTransform:'uppercase', whiteSpace:'nowrap' }}>
    {section}
  </span>
  <div style={{ flex:1, height:1, background:'linear-gradient(90deg, rgba(255,255,255,0.08), transparent)' }} />
</div>

// Inactive nav item
style={{
  display:     'flex', alignItems: 'center', gap: 10,
  padding:     '9px 14px', margin: '1px 8px', borderRadius: 10,
  color:       'rgba(255,255,255,0.55)',
  background:  'transparent',
  border:      '1px solid transparent',
  transition:  'all 0.15s ease',
}}

// Active nav item — amber treatment
style={{
  display:    'flex', alignItems: 'center', gap: 10,
  padding:    '9px 14px', margin: '1px 8px', borderRadius: 10,
  color:      '#E5A832',
  background: 'linear-gradient(135deg, rgba(229,168,50,0.12), rgba(229,168,50,0.06))',
  border:     '1px solid rgba(229,168,50,0.22)',
  boxShadow:  'inset 0 1px 0 rgba(229,168,50,0.20), 0 0 12px rgba(229,168,50,0.08)',
  // Left accent bar
  borderLeft: '2px solid #E5A832',
  paddingLeft: '12px', // compensate for border
}}
```

---

## TABLE ROW STANDARD

Every clickable data row in every table:

```css
/* Standard data row */
.data-row {
  border-left: 2px solid transparent;
  transition: background 0.12s ease, border-color 0.12s ease;
  cursor: pointer;
}

/* Hover state — amber left border + subtle glow */
.data-row:hover {
  background: linear-gradient(90deg, rgba(229,168,50,0.04) 0%, transparent 40%);
  border-left-color: rgba(229,168,50,0.45);
}

/* Severity-colored rows — use sev color instead of amber */
.data-row[data-severity="critical"]:hover {
  background: linear-gradient(90deg, rgba(239,68,68,0.06) 0%, transparent 40%);
  border-left-color: rgba(239,68,68,0.50);
}
```

---

## REQUIRED CSS ANIMATIONS

Add to `index.css` — all animations used by the component system:

```css
/* Live indicator ping */
@keyframes live-ping {
  75%, 100% { transform: scale(2.2); opacity: 0; }
}

/* Severity chip pulse (for active/live items) */
@keyframes chip-ping {
  75%, 100% { transform: scale(2); opacity: 0; }
}

/* Gauge fill on mount */
.gauge-arc {
  transition: stroke-dashoffset 1.2s cubic-bezier(0.4, 0, 0.2, 1);
}

/* Gauge glow pulse — high severity */
@keyframes gauge-high {
  0%, 100% { filter: drop-shadow(0 0 6px rgba(229,168,50,0.5)); }
  50%       { filter: drop-shadow(0 0 14px rgba(229,168,50,0.9)); }
}

/* Gauge glow pulse — critical */
@keyframes gauge-critical {
  0%, 100% { filter: drop-shadow(0 0 6px rgba(239,68,68,0.5)); }
  50%       { filter: drop-shadow(0 0 18px rgba(239,68,68,0.95)); }
}

.gauge-high     { animation: gauge-high     4s ease-in-out infinite; }
.gauge-critical { animation: gauge-critical 2s ease-in-out infinite; }

/* Page transition */
@keyframes page-enter {
  from { opacity: 0; transform: translateY(6px); filter: blur(3px); }
  to   { opacity: 1; transform: translateY(0);   filter: blur(0);   }
}
.page-enter { animation: page-enter 0.22s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards; }
```

---

## TYPOGRAPHY STANDARD

```
Primary headings:   font-bold text-white/92          — names, page titles
Stat numbers:       font-black font-mono text-[accent] — GlowNumber component
Section labels:     font-bold font-mono text-white/45  tracking-[0.20em] uppercase text-[9px]
Body text:          font-normal text-white/70          text-sm
Secondary text:     font-normal text-white/50          text-xs
Metadata:           font-mono text-white/30            text-[10px]
Timestamps:         font-mono text-white/28            text-[10px]

NEVER use:          text-white/20 or below on readable content
                    Inter, Roboto, Arial as the display font
                    opacity below /25 on any interactive element
```

---

## HOW TO APPLY THIS IN CLAUDE CODE SESSIONS

Every future UI session starts with:

```bash
cat packages/averrow-ops/src/design-system/components/index.ts
cat packages/shared/src/ui/Badge.tsx
cat packages/shared/src/ui/Avatar.tsx
cat packages/shared/src/ui/Card.tsx
cat packages/averrow-ops/src/components/ui/Button.tsx
```

Then the prompt says:
"Use the Averrow UI Standard. Every card is a Card variant.
Every entity avatar is the shared Avatar. Every button is Button.
No flat backgrounds. No rgba() fills without the 5 depth rules."

---

## WHAT GETS REBUILT NEXT

Priority order for applying this standard:

1. **Sidebar** — upgrade to sidebar standard above
2. **Observatory mobile chrome** — mode tabs, stat bar, bottom panel
3. **Brands Hub** — table rows, stat cards, search bar
4. **Brand Detail** — exposure card (ExposureGauge removed in PR3, 2026-10), tab bar, stat grid
5. **Threats / Alerts** — table rows, filter chips, detail cards
6. **All remaining pages** — systematic pass

Each screen gets its own Claude Code session.
Each session reads this document before writing a single line.
