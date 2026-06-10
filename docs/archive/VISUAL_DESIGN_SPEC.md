> Archived 2026-06-10: superseded by AVERROW_UI_STANDARD.md + design-system tokens.css.

# TRUST RADAR — VISUAL DESIGN SPECIFICATION

## Claude Code Build Reference
**Version:** 1.0
**Date:** March 21, 2026

> This document defines the visual standard for every surface in Trust Radar —
> from the public corporate site through the authenticated dashboard.
> Claude Code should read this BEFORE building any UI.

---

## 1. OBSERVATORY WATERMARK — HERO SECTION

### Concept

The landing page hero section shows the actual Trust Radar Observatory dashboard (7-day threat trend view) as a ghosted watermark behind the headline text. The product UI is visible — real chart shapes, real panel outlines — but softened so the headline reads clearly over it. This communicates "this is a real, working product" without requiring a screenshot.

### Implementation

```
┌─────────────────────────────────────────────────────────┐
│                                                          │
│  ┌─ Observatory watermark (behind everything) ────────┐ │
│  │                                                     │ │
│  │   ┌──────────────────────────┐  ┌──────────────┐   │ │
│  │   │ 7-Day Threat Trend       │  │ Score: 72    │   │ │
│  │   │ ▁▂▃▅▆▇█▇▅▃▂▁▂▃▅▆       │  │ ████████░░   │   │ │
│  │   │                          │  │              │   │ │
│  │   └──────────────────────────┘  └──────────────┘   │ │
│  │   ┌──────────┐ ┌──────────┐ ┌──────────────────┐   │ │
│  │   │ Email: B+│ │Social: 3 │ │ Threats: 12 ▲    │   │ │
│  │   └──────────┘ └──────────┘ └──────────────────┘   │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌─ Hero content (on top, fully legible) ─────────────┐ │
│  │                                                     │ │
│  │  [badge] AI-Powered Brand Threat Intelligence       │ │
│  │                                                     │ │
│  │  See your brand the way                             │ │
│  │  attackers do.                                      │ │
│  │                                                     │ │
│  │  Continuous monitoring for impersonation...          │ │
│  │                                                     │ │
│  │  [Scan Your Brand] [Explore Platform]               │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### Build Specification

The observatory watermark is a **real rendered component**, not an image. Build it as actual HTML/CSS/SVG that renders the dashboard layout with real chart shapes.

```css
/* Observatory watermark container */
.observatory-watermark {
  position: absolute;
  inset: 0;
  z-index: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  overflow: hidden;
}

/* The dashboard mockup inside */
.observatory-inner {
  width: 1100px;
  max-width: 90vw;
  transform: perspective(1200px) rotateX(8deg) rotateY(-3deg) scale(0.92);
  transform-origin: center center;

  /* Ghosting effect — visible but not competing with text */
  opacity: 0.06;                               /* Light theme */
  filter: blur(0.5px);

  /* Theme-aware: slightly more visible on dark */
  /* [data-theme="dark"] .observatory-inner { opacity: 0.08; } */
}

/* Subtle entrance animation */
.observatory-inner {
  animation: observatoryFadeIn 2s 0.5s ease-out both;
}

@keyframes observatoryFadeIn {
  from {
    opacity: 0;
    transform: perspective(1200px) rotateX(12deg) rotateY(-5deg) scale(0.88);
  }
  to {
    opacity: 0.06;
    transform: perspective(1200px) rotateX(8deg) rotateY(-3deg) scale(0.92);
  }
}
```

### Observatory Dashboard Content (rendered as SVG/HTML)

The watermark should contain these actual dashboard elements:

```
┌─────────────────────────────────────────────────────────┐
│ Observatory — trustradar.ca/dashboard                    │
│                                                          │
│ TOP BAR: Brand Exposure Score (72) + sparkline           │
│                                                          │
│ MAIN CHART: 7-day threat trend                           │
│   - Area chart with gradient fill                        │
│   - X axis: Mon Tue Wed Thu Fri Sat Sun                  │
│   - Y axis: Threat count                                 │
│   - Actual data shape (not flat): peaks mid-week         │
│   - Afterburner amber gradient fill, amber stroke line   │
│                                                          │
│ SIDE PANEL: Quick stats                                  │
│   - Score gauge (circular, 72/100)                       │
│   - Email grade badge (B+)                               │
│   - Active threats count (12)                            │
│   - Social alerts count (3)                              │
│                                                          │
│ BOTTOM ROW: Recent threat cards (3 mini cards)           │
│   - Each: colored severity dot + domain + timestamp      │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

Build this using:
- **SVG** for the area chart (path element with gradient fill)
- **CSS grid** for the dashboard layout
- **CSS variables** from the design system for all colors
- Real-looking data (not random — threat counts that peak mid-week look realistic)

```typescript
// Example 7-day trend data for the watermark chart
const trendData = [
  { day: 'Mon', threats: 8 },
  { day: 'Tue', threats: 14 },
  { day: 'Wed', threats: 22 },
  { day: 'Thu', threats: 18 },
  { day: 'Fri', threats: 11 },
  { day: 'Sat', threats: 5 },
  { day: 'Sun', threats: 7 },
];
```

---

## 2. ADVANCED VISUAL TREATMENTS — BOXES, LINES, BORDERS

### Philosophy

Every box, card, border, and line in Trust Radar should feel engineered and intentional — like a threat intelligence heads-up display, not a SaaS template. Use CSS techniques that create depth, motion, and atmosphere.

### Card Treatments

#### Standard Card (used for feature cards, pricing cards, content blocks)

```css
.tr-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  position: relative;
  overflow: hidden;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

/* Animated top-edge gradient line */
.tr-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(
    90deg,
    transparent 0%,
    var(--accent) 20%,
    var(--accent-light) 50%,
    var(--accent) 80%,
    transparent 100%
  );
  opacity: 0;
  transition: opacity 0.4s;
}

.tr-card:hover::before {
  opacity: 1;
}

/* Subtle inner glow on hover */
.tr-card:hover {
  border-color: var(--accent);
  box-shadow:
    0 0 0 1px rgba(8, 145, 178, 0.1),
    0 8px 32px rgba(0, 0, 0, 0.08),
    inset 0 1px 0 rgba(8, 145, 178, 0.05);
  transform: translateY(-2px);
}
```

#### Elevated Card (used for scan reports, threat narratives, featured content)

```css
.tr-card-elevated {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  position: relative;
  overflow: hidden;

  /* Layered shadow for depth */
  box-shadow:
    0 1px 2px rgba(0, 0, 0, 0.04),
    0 4px 8px rgba(0, 0, 0, 0.04),
    0 12px 32px rgba(0, 0, 0, 0.06);
}

/* Corner accent markers — subtle tech aesthetic */
.tr-card-elevated::before,
.tr-card-elevated::after {
  content: '';
  position: absolute;
  width: 20px;
  height: 20px;
  border-color: var(--accent);
  border-style: solid;
  opacity: 0.25;
  transition: opacity 0.3s;
}

.tr-card-elevated::before {
  top: 8px;
  left: 8px;
  border-width: 2px 0 0 2px;
  border-radius: 4px 0 0 0;
}

.tr-card-elevated::after {
  bottom: 8px;
  right: 8px;
  border-width: 0 2px 2px 0;
  border-radius: 0 0 4px 0;
}

.tr-card-elevated:hover::before,
.tr-card-elevated:hover::after {
  opacity: 0.5;
}
```

#### Glass Card (used for floating elements, overlays, nav dropdown)

```css
.tr-card-glass {
  background: rgba(255, 255, 255, 0.05);
  backdrop-filter: blur(20px) saturate(180%);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: var(--radius-lg);
  box-shadow:
    0 8px 32px rgba(0, 0, 0, 0.12),
    inset 0 0 0 1px rgba(255, 255, 255, 0.05);
}

/* Light theme version */
[data-theme="light"] .tr-card-glass {
  background: rgba(255, 255, 255, 0.7);
  border: 1px solid rgba(0, 0, 0, 0.06);
  box-shadow:
    0 8px 32px rgba(0, 0, 0, 0.06),
    inset 0 0 0 1px rgba(255, 255, 255, 0.5);
}
```

### Line & Divider Treatments

#### Animated Gradient Divider

```css
.tr-divider {
  height: 1px;
  background: linear-gradient(
    90deg,
    transparent,
    var(--border) 20%,
    var(--accent) 50%,
    var(--border) 80%,
    transparent
  );
  border: none;
  margin: 2rem 0;
}

/* Animated version — for section transitions */
.tr-divider-animated {
  height: 1px;
  border: none;
  margin: 2rem 0;
  background: linear-gradient(
    90deg,
    transparent,
    var(--accent),
    transparent
  );
  background-size: 200% 100%;
  animation: dividerSlide 3s ease-in-out infinite;
}

@keyframes dividerSlide {
  0%, 100% { background-position: -200% 0; }
  50% { background-position: 200% 0; }
}
```

#### Severity-Coded Left Border (for alert cards, threat items)

```css
.tr-severity-border {
  border-left: 3px solid transparent;
  padding-left: 1rem;
}

.tr-severity-border[data-severity="critical"] {
  border-left-color: var(--red);
  background: linear-gradient(90deg, rgba(239, 68, 68, 0.04), transparent 40%);
}

.tr-severity-border[data-severity="high"] {
  border-left-color: var(--coral);
  background: linear-gradient(90deg, rgba(249, 115, 22, 0.04), transparent 40%);
}

.tr-severity-border[data-severity="medium"] {
  border-left-color: var(--amber);
  background: linear-gradient(90deg, rgba(245, 158, 11, 0.04), transparent 40%);
}

.tr-severity-border[data-severity="low"] {
  border-left-color: var(--accent);
  background: linear-gradient(90deg, rgba(8, 145, 178, 0.04), transparent 40%);
}
```

### Connection Lines (for architecture diagrams, flow charts)

```css
/* Animated dashed connection line */
.tr-connection-line {
  stroke: var(--accent);
  stroke-width: 1.5;
  stroke-dasharray: 6 4;
  stroke-dashoffset: 0;
  animation: dashFlow 1.5s linear infinite;
  opacity: 0.4;
}

@keyframes dashFlow {
  to { stroke-dashoffset: -20; }
}

/* Glowing active connection */
.tr-connection-line-active {
  stroke: var(--accent);
  stroke-width: 2;
  filter: drop-shadow(0 0 4px rgba(8, 145, 178, 0.5));
  opacity: 0.8;
}
```

### Badge & Tag Treatments

```css
/* Standard tag with subtle gradient */
.tr-tag {
  font-family: var(--font-mono);
  font-size: 0.65rem;
  font-weight: 600;
  padding: 0.2rem 0.65rem;
  border-radius: 100px;
  letter-spacing: 0.04em;
  position: relative;
  overflow: hidden;
}

/* Color-specific tags with gradient backgrounds */
.tr-tag-amber {
  background: linear-gradient(135deg, rgba(229, 168, 50, 0.08), rgba(229, 168, 50, 0.12));
  color: var(--accent);
  border: 1px solid rgba(229, 168, 50, 0.2);
}

.tr-tag-coral {
  background: linear-gradient(135deg, rgba(249, 115, 22, 0.08), rgba(251, 146, 60, 0.12));
  color: var(--coral);
  border: 1px solid rgba(249, 115, 22, 0.2);
}

.tr-tag-green {
  background: linear-gradient(135deg, rgba(16, 185, 129, 0.08), rgba(52, 211, 153, 0.12));
  color: var(--green);
  border: 1px solid rgba(16, 185, 129, 0.2);
}

.tr-tag-red {
  background: linear-gradient(135deg, rgba(239, 68, 68, 0.08), rgba(248, 113, 113, 0.12));
  color: var(--red);
  border: 1px solid rgba(239, 68, 68, 0.2);
}

/* Live pulse tag (for "Live" badges, active monitoring) */
.tr-tag-live::before {
  content: '';
  display: inline-block;
  width: 6px;
  height: 6px;
  background: currentColor;
  border-radius: 50%;
  margin-right: 0.4rem;
  animation: livePulse 2s ease-in-out infinite;
}

@keyframes livePulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 0 currentColor; }
  50% { opacity: 0.6; box-shadow: 0 0 0 4px transparent; }
}
```

### Button Treatments

```css
/* Primary button with animated gradient edge */
.tr-btn-primary {
  background: var(--accent);
  color: white;
  border: none;
  border-radius: var(--radius-sm);
  padding: 0.75rem 1.75rem;
  font-weight: 600;
  cursor: pointer;
  position: relative;
  overflow: hidden;
  transition: all 0.3s;
}

/* Shimmer effect on hover */
.tr-btn-primary::after {
  content: '';
  position: absolute;
  top: 0;
  left: -100%;
  width: 100%;
  height: 100%;
  background: linear-gradient(
    90deg,
    transparent,
    rgba(255, 255, 255, 0.15),
    transparent
  );
  transition: left 0.5s;
}

.tr-btn-primary:hover::after {
  left: 100%;
}

.tr-btn-primary:hover {
  box-shadow:
    0 0 20px rgba(8, 145, 178, 0.3),
    0 0 60px rgba(8, 145, 178, 0.1);
  transform: translateY(-1px);
}
```

### Score Gauge Treatment

```css
/* Circular score gauge with animated fill and glow */
.tr-gauge-ring {
  fill: none;
  stroke-width: 8;
  stroke-linecap: round;
}

.tr-gauge-bg {
  stroke: var(--border);
}

.tr-gauge-fill {
  stroke: var(--accent);
  stroke-dasharray: 408;
  stroke-dashoffset: 408;
  filter: drop-shadow(0 0 6px rgba(8, 145, 178, 0.4));
  animation: gaugeFillIn 1.5s 0.5s ease-out forwards;
}

@keyframes gaugeFillIn {
  to { stroke-dashoffset: var(--gauge-offset); }
}

/* Score color shifts based on value */
.tr-gauge-fill[data-grade="A"] { stroke: var(--green); filter: drop-shadow(0 0 6px rgba(16, 185, 129, 0.4)); }
.tr-gauge-fill[data-grade="B"] { stroke: var(--accent); }
.tr-gauge-fill[data-grade="C"] { stroke: var(--amber); filter: drop-shadow(0 0 6px rgba(245, 158, 11, 0.4)); }
.tr-gauge-fill[data-grade="D"] { stroke: var(--coral); filter: drop-shadow(0 0 6px rgba(249, 115, 22, 0.4)); }
.tr-gauge-fill[data-grade="F"] { stroke: var(--red); filter: drop-shadow(0 0 6px rgba(239, 68, 68, 0.4)); }
```

---

## 3. UNIFIED ICON SYSTEM

### Requirements

Icons must be **identical** between the public marketing site and the authenticated dashboard. A user should see the same icon for "Email Security" on the landing page feature section as they do in their dashboard sidebar. This creates visual continuity that communicates professionalism and a cohesive product.

### Icon Library: Lucide

Use **Lucide** (lucide.dev) as the single icon source across the entire platform.

- Available as `lucide-react` for React components (already available in artifacts)
- Available as raw SVGs for the Worker-rendered HTML pages
- Consistent 24x24 grid, 2px stroke, round caps and joins
- MIT licensed, actively maintained, 1400+ icons

```bash
# Install in packages/trust-radar
pnpm add lucide-react    # For React dashboard components
# For Worker HTML pages: embed SVG strings directly (no runtime dependency)
```

### Icon Mapping — Canonical Assignment

Every concept in Trust Radar gets ONE icon, used EVERYWHERE.

```
┌─────────────────────────────────────────────────────────────────┐
│ CONCEPT                │ LUCIDE ICON        │ COLOR             │
├────────────────────────┼────────────────────┼───────────────────┤
│                        │                    │                   │
│ PLATFORM CAPABILITIES  │                    │                   │
│ Threat Detection       │ Shield             │ var(--accent)     │
│ Email Security         │ Mail               │ var(--coral)      │
│ Social Monitoring      │ Users              │ var(--green)      │
│ AI Agents              │ Brain              │ #7c3aed (purple)  │
│                        │                    │                   │
│ THREAT TYPES           │                    │                   │
│ Phishing               │ Fish               │ var(--red)        │
│ Impersonation          │ UserX              │ var(--red)        │
│ Lookalike Domain       │ Globe              │ var(--coral)      │
│ Credential Exposure    │ KeyRound           │ var(--amber)      │
│ Malware URL            │ LinkOff (or Bug)   │ var(--red)        │
│ Certificate Alert      │ ShieldAlert        │ var(--amber)      │
│ Handle Squatting       │ AtSign             │ var(--coral)      │
│                        │                    │                   │
│ SEVERITY               │                    │                   │
│ Critical               │ AlertOctagon       │ var(--red)        │
│ High                   │ AlertTriangle      │ var(--coral)      │
│ Medium                 │ AlertCircle        │ var(--amber)      │
│ Low                    │ Info               │ var(--accent)     │
│                        │                    │                   │
│ STATUS                 │                    │                   │
│ Secured / Pass         │ CheckCircle2       │ var(--green)      │
│ Alert / Fail           │ XCircle            │ var(--red)        │
│ Warning                │ AlertTriangle      │ var(--amber)      │
│ Monitoring / Active    │ Radio              │ var(--accent)     │
│ Unclaimed              │ CircleDashed       │ var(--amber)      │
│                        │                    │                   │
│ EMAIL PROTOCOLS        │                    │                   │
│ SPF                    │ ShieldCheck        │ contextual        │
│ DKIM                   │ Key                │ contextual        │
│ DMARC                  │ Lock               │ contextual        │
│ MX                     │ Server             │ contextual        │
│                        │                    │                   │
│ SOCIAL PLATFORMS       │                    │                   │
│ Twitter/X              │ Twitter (or custom)│ platform color    │
│ LinkedIn               │ Linkedin           │ platform color    │
│ Instagram              │ Instagram          │ platform color    │
│ TikTok                 │ Music2 (proxy)     │ platform color    │
│ GitHub                 │ Github             │ platform color    │
│ YouTube                │ Youtube            │ platform color    │
│                        │                    │                   │
│ AI AGENTS              │                    │                   │
│ Analyst Agent          │ Brain              │ #7c3aed           │
│ Observer Agent         │ Eye                │ var(--accent)     │
│ Sales Agent            │ Target             │ var(--coral)      │
│ Agent "thinking"       │ Loader2 (spinning) │ #7c3aed           │
│                        │                    │                   │
│ NAVIGATION             │                    │                   │
│ Dashboard              │ LayoutDashboard    │ inherit           │
│ Threats                │ Shield             │ inherit           │
│ Email Security         │ Mail               │ inherit           │
│ Social                 │ Users              │ inherit           │
│ Reports                │ FileText           │ inherit           │
│ Settings               │ Settings           │ inherit           │
│ Alerts                 │ Bell               │ inherit           │
│ Brands                 │ Building2          │ inherit           │
│                        │                    │                   │
│ ACTIONS                │                    │                   │
│ Scan                   │ Search             │ inherit           │
│ Export                  │ Download           │ inherit           │
│ Share                  │ Share2             │ inherit           │
│ Connect (integration)  │ Plug               │ inherit           │
│ Resolve                │ CheckCircle2       │ var(--green)      │
│ Dismiss                │ XCircle            │ var(--red)        │
│ Refresh                │ RefreshCw          │ inherit           │
│ Theme toggle (light)   │ Sun                │ inherit           │
│ Theme toggle (dark)    │ Moon               │ inherit           │
│                        │                    │                   │
└─────────────────────────────────────────────────────────────────┘
```

### Icon Rendering — Two Methods

#### Method 1: React Components (Dashboard, React pages)

```tsx
import { Shield, Mail, Users, Brain } from 'lucide-react';

// Standard usage
<Shield size={20} strokeWidth={2} color="var(--accent)" />

// With icon container
<div className="tr-icon-container tr-icon-amber">
  <Shield size={20} strokeWidth={2} />
</div>
```

#### Method 2: Inline SVG Strings (Worker-rendered HTML pages)

For pages rendered by the Worker as HTML strings (landing page, marketing pages), embed SVG directly. Create a shared icon utility:

```typescript
// packages/trust-radar/src/ui/icons.ts

export const icons = {
  shield: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,

  mail: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>`,

  users: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,

  brain: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/></svg>`,

  // ... complete set for all icons in the mapping above
};

// Usage in Worker HTML
function renderIcon(name: string, size = 24, color = 'currentColor'): string {
  const svg = icons[name];
  if (!svg) return '';
  return svg
    .replace('width="24"', `width="${size}"`)
    .replace('height="24"', `height="${size}"`)
    .replace('stroke="currentColor"', `stroke="${color}"`);
}
```

### Icon Container Styles

```css
/* Icon in a colored background circle */
.tr-icon-container {
  width: 48px;
  height: 48px;
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
}

.tr-icon-amber { background: rgba(229, 168, 50, 0.08); color: #E5A832; }
.tr-icon-coral { background: var(--coral-bg); color: var(--coral); }
.tr-icon-green { background: var(--green-bg); color: var(--green); }
.tr-icon-purple { background: rgba(124, 58, 237, 0.08); color: #7c3aed; }
.tr-icon-red { background: var(--red-bg); color: var(--red); }

/* Smaller variant for inline use */
.tr-icon-sm {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
}

/* Larger variant for feature hero blocks */
.tr-icon-lg {
  width: 64px;
  height: 64px;
  border-radius: var(--radius-lg);
}
```

---

## 4. SECTION BACKGROUND TREATMENTS

### Hero Background (with observatory watermark)

```css
.hero {
  position: relative;
  overflow: hidden;
}

/* Subtle radial gradients for depth */
.hero-bg {
  position: absolute;
  inset: 0;
  z-index: 0;

  /* Light theme */
  background:
    radial-gradient(ellipse at 25% 25%, rgba(8, 145, 178, 0.06) 0%, transparent 50%),
    radial-gradient(ellipse at 75% 75%, rgba(16, 185, 129, 0.04) 0%, transparent 50%),
    linear-gradient(135deg, var(--bg-primary) 0%, rgba(240, 249, 255, 0.5) 50%, var(--bg-primary) 100%);
}

/* Grid overlay — very subtle */
.hero-grid {
  position: absolute;
  inset: 0;
  z-index: 1;
  background-image:
    linear-gradient(rgba(8, 145, 178, 0.02) 1px, transparent 1px),
    linear-gradient(90deg, rgba(8, 145, 178, 0.02) 1px, transparent 1px);
  background-size: 80px 80px;
  mask-image: radial-gradient(ellipse at center, black 30%, transparent 70%);
  pointer-events: none;
}
```

### Feature Section Alternating Backgrounds

```css
/* Alternate between primary bg and tertiary bg */
.section-alt {
  background: var(--bg-tertiary);
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);

  /* Subtle noise texture */
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.02'/%3E%3C/svg%3E");
}
```

---

## 5. CLAUDE CODE BUILD INSTRUCTIONS

When building any page or component for Trust Radar, follow this checklist:

```
□ Read this visual design spec FIRST
□ Use Lucide icons from the canonical mapping — never freestyle icons
□ Use the card treatment classes (tr-card, tr-card-elevated, tr-card-glass)
□ Use severity-coded borders for threat/alert content
□ Use animated gradient dividers between major sections
□ Use the score gauge treatment for any score display
□ Use the tag treatment classes for all badges/labels
□ Use the button treatment with shimmer hover effect
□ Apply the hero background treatment (observatory watermark + radial gradients + grid)
□ Every connection line in diagrams should animate (dashFlow)
□ Every "Live" badge should pulse (livePulse)
□ Theme-test every component in BOTH light and dark mode
□ Icons must match between marketing page and dashboard sidebar
```

### Package Installation

```bash
# In packages/trust-radar/
pnpm add lucide-react      # Icon library (React components)
pnpm add d3                # Data visualization
pnpm add three             # 3D graphics (hero globe)
pnpm add recharts          # Charts (dashboard)
pnpm add framer-motion     # Animations (React)
pnpm add satori            # OG image generation
pnpm add @resvg/resvg-wasm # SVG → PNG in Worker
```

### CDN Resources (add to HTML head)

```html
<!-- Three.js for 3D hero -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js" defer></script>

<!-- d3 for data viz -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js" defer></script>

<!-- MapLibre GL for threat geography (dashboard only) -->
<link href="https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.css" rel="stylesheet">
<script src="https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.js" defer></script>
```

---

*This document should be committed alongside the other plan documents.
Referenced by ALL Claude Code sessions building Trust Radar UI.*
