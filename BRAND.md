# Averrow Brand Standards

This file is the **single source of truth** for the Averrow brand
identity. Anyone (or any agent) generating logos, social tiles,
emails, decks, app icons, or external collateral must follow this
file. If it disagrees with what looks right "by feel" — this file
wins. If you need to change the brand, change this file FIRST,
then regenerate everything from it.

Parent company: **LRX Enterprises Inc.** (Canadian-incorporated)
Product: **Averrow** — global threat intelligence + brand protection
Heritage reference (About page only): Avro Arrow — the upward red
arrow in the mark is a direct nod to the CF-105 Avro Arrow.

---

## 1. Master assets (sources of truth)

| Path | Role |
|---|---|
| `packages/averrow-worker/public/favicon.svg` | **Master logo SVG** — the canonical Avro Arrow on dark navy. Edit this file to change the brand mark; regenerate everything else. |
| `packages/averrow-worker/public/bimi.svg` | BIMI-compliant variant (`baseProfile="tiny-ps"` + `<title>`). Same artwork. Updated when favicon.svg changes — see `docs/BIMI_SETUP_RUNBOOK.md`. |
| `packages/averrow-worker/public/icon-192.svg` / `icon-512.svg` | PWA manifest icons (round-canvas variant). Same artwork on a circular background instead of rounded square. |
| `packages/averrow-worker/public/brand/` | **Generated** — do not edit by hand. Regenerate via `scripts/generate-logo-assets.py`. |

### Regenerate the asset suite

```bash
python3 scripts/generate-logo-assets.py
```

Pre-reqs: `pip install cairosvg Pillow` (already installed in the
dev environment). The script is idempotent — re-run any time the
master SVG changes. Output goes to `packages/averrow-worker/public/brand/`
and is served live at `https://averrow.com/brand/...`.

### Generated file naming

| Pattern | Use |
|---|---|
| `averrow-{N}.png` | Plain mark at NxN — favicon, app icon, web embed |
| `averrow-social-{N}.png` | Mark centred on dark page bg with ~11% margin — Twitter/X, LinkedIn, Instagram avatars |
| `averrow-og.png` | 1200×630 Open Graph / link-preview image (mark + "Averrow" wordmark + "THREAT INTELLIGENCE" tag + red rule) |
| `favicon.ico` | Multi-resolution .ico bundling 16/32/48 PNGs |

| Special locations (not under `brand/`) | Why |
|---|---|
| `packages/averrow-worker/public/logo-email.png` | Stable URL `https://averrow.com/logo-email.png` referenced by the abuse-mailbox email template (`src/lib/abuse-mailbox-responder.ts`). 144×144 retina-grade PNG. Don't move — would break previously sent emails' image refs. |

---

## 2. Colour palette

All colours are defined in `packages/averrow-ops/src/index.css` /
`@averrow/shared/theme.css` as CSS custom properties. **Never
hardcode hex values in app code** — use the variable. This table
exists for asset generation, print, and external collateral
where CSS isn't available.

### Brand primaries

| Name | Hex | RGB | Use |
|---|---|---|---|
| **Brand red** | `#C83C3C` | `200, 60, 60` | The Avro Arrow mark, critical alerts, severity=critical |
| **Brand red deep** | `#6B1010` | `107, 16, 16` | Top of mark gradient (favicon.svg only); never used solid |
| **Brand amber** | `#E5A832` | `229, 168, 50` | CTAs, active states, accent stripes, secondary brand colour |
| **Brand amber dim** | `#B8821F` | `184, 130, 31` | Amber gradient pair |

### Backgrounds

| Name | Hex | RGB | Use |
|---|---|---|---|
| **Page (deepest)** | `#060A14` | `6, 10, 20` | `--bg-page` — site/app background, social-tile canvas |
| **Mark canvas** | `#080E18` | `8, 14, 24` | Logo background tile (favicon rounded square) |
| **Card** | `rgba(22,30,48,0.85)` | — | Glass cards over `--bg-page` |
| **Sidebar** | `rgba(10,16,30,0.96)` | — | Sidebar / nav surfaces |

### Text on dark

| Name | Value | Use |
|---|---|---|
| Primary | `rgba(255,255,255,0.92)` | Headings, metrics |
| Secondary | `rgba(255,255,255,0.60)` | Sub-labels, descriptions |
| Tertiary | `rgba(255,255,255,0.40)` | Metadata, timestamps |
| Muted | `rgba(255,255,255,0.25)` | Disabled / hint only |

### Severity (semantic, not branding)

`--sev-critical`, `--sev-high`, `--sev-medium`, `--sev-low` —
defined in CLAUDE.md §5. These are functional, not brand colours,
so they don't appear in marketing/social/print assets.

---

## 3. Typography

| Role | Font | Fallback chain |
|---|---|---|
| **Display + body** | `Plus Jakarta Sans` | `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif` |
| **Mono / data** | `JetBrains Mono` | `'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace` |

Defined in `packages/averrow-ops/tailwind.config.ts` (`fontFamily.display`
+ `fontFamily.mono`) and applied site-wide in `src/index.css`.

### Email + external collateral
Email clients don't fetch web fonts (Apple Mail is a partial exception).
Use the same stack — Plus Jakarta Sans first, then the system fallbacks.
Plus Jakarta Sans degrades gracefully to Segoe UI / SF Pro / Helvetica
which are all visually similar enough to preserve the brand voice.

### Wordmark
"Averrow" set in **Plus Jakarta Sans 800** (extra-bold), letter-spacing
`-0.015em`. The wordmark is always set in white on dark or `#0F1828`
on light — never in red (red is reserved for the mark itself, mixing
the two competes for the eye).

### Tagline
"THREAT INTELLIGENCE" in Plus Jakarta Sans 700, letter-spacing
`0.18em`–`0.22em`, all-caps, in `--amber` (#E5A832).

---

## 4. The mark — geometry & rules

The Avro Arrow mark is the upward red triangle with a small inverted
triangle cut out (forming an "A"-style negative space). On a 32×32
viewBox:

- Outer arrow: `M16 5 L26 26 L18 26 L16 21 L14 26 L6 26 Z`
- Inner cutout: `M14.5 22 L17.5 22 L16 18 Z`

The mark is **always** presented on a dark navy `#080E18` rounded
square (radius 6/32 = ~19% of side) when used as an icon/avatar.
Standalone (no tile) usage is allowed in headers/wordmarks where
context already provides separation, but the mark itself is always
red `#C83C3C` (or its source gradient `#6B1010 → #C83C3C` in the
SVG variant).

### Don'ts

- Do **not** use the mark in any colour other than the brand red.
- Do **not** add drop shadows, glows, or strokes to the mark.
- Do **not** rotate, skew, or stretch.
- Do **not** use Unicode triangles (▲ U+25B2) as a logo substitute.
  We tried. They look terrible. Render PNG from the master SVG.
- Do **not** crop the mark. It's already minimal.
- Do **not** place the mark on a busy / photographic background.
  Use the dark navy tile, the page background, or pure white.
- Do **not** combine the mark with another logo in a "lockup"
  unless explicitly approved (partnership announcements only).

### Minimum size

- Digital: 16×16 (favicon)
- Print: 0.25" / 6mm
- Below 16px the mark loses the inner cutout; use `averrow-16.png`
  which is hand-tuned at that size, do not downscale a larger PNG.

### Clear space

Maintain padding equal to the height of the inner cutout (~12% of
the mark's height) on all sides. The generated `averrow-social-*`
tiles already enforce this.

---

## 5. Domains & canonical URLs

| Asset | URL |
|---|---|
| Master SVG | `https://averrow.com/favicon.svg` |
| BIMI SVG | `https://averrow.com/bimi.svg` |
| Email logo | `https://averrow.com/logo-email.png` |
| OG image | `https://averrow.com/brand/averrow-og.png` |
| Generated PNGs | `https://averrow.com/brand/averrow-{size}.png` |
| Social tiles | `https://averrow.com/brand/averrow-social-{size}.png` |

The same paths are served from `averrow.ca`, `trustradar.ca`, and
`lrxradar.com` — all four domains route to the same Worker and
serve identical static assets.

---

## 6. Voice / tone (brief — for collateral copy)

- **Confident, not loud.** "We identified this as phishing." not
  "WARNING! PHISHING DETECTED!"
- **Specific over vague.** Numbers, indicators, named feeds.
- **Human authorship even on automated copy.** "Your submission is
  in our system" beats "Your submission has been received and queued
  for asynchronous processing."
- **Never claim a human did something an AI did.** Marketing pages
  promise automated triage; copy must match.

---

## 7. When in doubt

1. Read this file.
2. Look at the master SVG: `packages/averrow-worker/public/favicon.svg`.
3. If you think the brand needs to evolve, change this file FIRST,
   then regenerate via `scripts/generate-logo-assets.py`, then
   update the master SVG, then deploy.
4. Don't ask Claude Chat to re-create assets — they'll diverge from
   the master. Use the script.
