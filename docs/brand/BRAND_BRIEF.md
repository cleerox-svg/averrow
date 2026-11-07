# Averrow Brand Brief (Phase 0, draft for gate G0)

Status: DRAFT for owner approval. Every logo, palette, type, motion and hero option is judged against this. Grounded in CLAUDE.md §13, `BRAND.md`, `AVERROW_UI_STANDARD.md`, the marketing homepage and `AverrowMark.tsx`.

## 1. Who we're for

**Buyer: CISO / head of brand protection / fraud lead** (Professional $1,499, Business $3,999, Enterprise). Today they learn about attacks from customers or the press. They need to defend headcount and budget.
Feeling: **"I'm ahead of it, and I can prove it."** Control and defensibility.

**Daily user: SOC / threat analyst.** Lives in the console for hours, distrusts dashboards that hide the evidence, hates alert noise.
Feeling: **"This already did the correlation."** Relief and trust.

Secondary: teams without a SOC (the "replaces 2-3 analysts" ROI) who need it to feel safe, not intimidating.

## 2. Positioning and attributes

**Line:** *Averrow shows who is attacking your brand, and shuts them down.* (Extends the live hero: "See who is attacking your brand, and shut them down.") Global threat-actor intelligence plus brand protection. Threats are evidence; patterns are the product.

| Attribute | Means | Doesn't mean |
|---|---|---|
| **Exact** | Evidence-backed, every claim traceable, numbers dated and labelled illustrative when they are | Cold, clinical, jargon-heavy |
| **Composed** | Calm under pressure, quiet until something matters | Sleepy, low-energy, understated to the point of invisible |
| **Decisive** | Moves from finding to action (takedown) in one flow; opinionated defaults | Aggressive, "hunt and destroy" rhetoric, fear selling |

## 3. Visual principles

"Enterprise-grade and visually stunning" for Averrow = **precision that is beautiful**, not spectacle. Stunning comes from craft: type, spacing, one hero visual built from real data shape (the operation graph), restrained light.

1. Data is the hero. Chrome recedes; numbers, graphs and evidence get the contrast.
2. Calm dark surfaces; **colour is reserved for meaning** (severity, status, one brand accent). No decorative rainbow.
3. One focal point per view. Depth by layered surface and light, not by effects stacked.
4. Monospace for facts (IDs, ASNs, timestamps), a confident sans for argument. Dense but breathable.
5. Light theme is first-class, not an inversion afterthought.

**We look like:** a precision instrument; a well-set intelligence report; Linear/Stripe-grade restraint with an analyst's density; an operation graph drawn with intent.

**We don't look like:** Recorded Future-style dense blue-corporate stock-photo marketing; ZeroFox/Doppel/Bolster-style generic gradient-blob SaaS with shield icons and padlocks; hacker-movie green-on-black, skulls, hooded figures, radar sweeps; world maps with glowing arcs as wallpaper (the Observatory owns that, in-product); any aviation or military imagery (jets, arrows-as-weapons, crosshairs, camo).

## 4. Motion principles

Motion exists to show **state change, causality and live data**. If it does none, cut it.

- Use: a new item entering a feed, a node linking into an operation graph, status transitions, hover/focus affordance, page-level continuity. 120-240ms, ease-out; one choreographed hero moment max per page.
- Banned: gratuitous parallax, scroll-jacking, bounce/overshoot on data, counting-up numbers that delay reading, looping ambient motion behind text, anything that blocks interaction.
- Data reads first: values render immediately; motion decorates the change, never gates it.
- Reduced motion: `prefers-reduced-motion` gets a full static equivalent (state change by fade/colour only, no travel, no loops). Reduced is a designed state, tested, not a fallback.

## 5. Mark requirements (all 3 logo directions)

- Legible and distinct at **16px** favicon; verify at 16/32/48.
- Survives a **maskable icon** 80% safe zone (circle crop) with no clipped geometry.
- Works **mono** (1 colour), reversed, and on light and dark, without a glow or gradient doing the work.
- Works in **email as flat PNG** (no filters, no blur shadow; current mark's `box-shadow` glow fails this).
- Pairs with an "AVERROW" wordmark; mark and wordmark each usable alone.
- **No aviation or military imagery**: no jets, wings, chevron-arrows read as aircraft, crosshairs or insignia. Do not narrate the name's derivation.
- Current mark: a red gradient triangle "A"/arrow with a notch, in a dark rounded tile. Its DNA (red, upward A-form, notched negative space) is the open question (Q1). Note its arrow silhouette is the Avro Arrow nod we no longer tell; the shape itself may still read as aircraft.

## 6. Palette requirements

**Must stay:**
- Severity semantics (critical/high/medium/low/info) with the existing token names, so 100+ components don't break.
- **AA contrast in both themes** for all text, badges and chart labels (existing `--sev-*-text` pattern).
- `--orbital-teal` reserved for Observatory WebGL; no brand use.
- Red must never become a decorative colour that competes with "critical".
- Green/amber/blue keep their status meanings (healthy / warning-primary / info).

**Open:**
- Is **amber `#E5A832`** still the primary brand accent? Amber currently doubles as CTA colour and a near-severity (medium) hue, which muddies meaning. Directions may propose a distinct brand accent (e.g. a cool or neutral primary) and demote amber to status only.
- Page navy `#060A14` base: keep, or shift to a warmer/neutral graphite.
- Neutral ramp and surface elevation (glass cards vs flat).

Each palette must ship with tokens for both themes and a severity-collision check.

## 7. Open questions for the owner (G0)

1. **Mark DNA:** keep the red upward-A (evolve) or **start fresh**? (keep / fresh)
2. **Primary accent:** stay **amber**, or free the brand to propose a new one? (amber / open)
3. **Red as brand:** keep red in the logo, or reserve red strictly for "critical"? (keep / reserve)
4. **Tone dial:** closer to **calm authority** (Stripe/Linear) or **sharper edge** (security-native)? (calm / sharp)
5. **Scope of facelift:** marketing site and logo only, or **marketing + ops + tenant** apps? (marketing / all)

## 8. Owner decisions (2026-11-07)

| # | Question | Decision |
|---|---|---|
| 1 | Mark DNA | **Mix:** one direction evolves the current upward-A mark (flat, 16px- and email-safe); two directions start fresh. |
| 2 | Primary accent | **Replace amber.** Every palette option proposes a new primary; amber becomes a status/severity colour only. |
| 3 | Red in the brand | **Show both:** each logo direction is shown in a red and a non-red version, side by side. |
| 4 | Tone | **Sharper edge:** higher contrast, more kinetic motion, a sense of live threat activity, while staying precise (no clichés from section 3). |
| 5 | Scope | **Everything:** marketing site, ops and tenant apps. The login screen follows the platform in full; FarmTrack parity is deferred. |

`WEBSITE_REBRAND_BRIEF_2026-11.md` (written in a separate marketing session) is reference input only; this brief and the gate decisions above are authoritative.

## 9. Phase 1 decisions (2026-11-07)

| Gate | Decision | Source of truth |
|---|---|---|
| G1 Logo | **R3 "Sharpened + edge"**: today's A + tail-fin mark, flattened (no glow/gradient), sharper apex, raked swallow-tail feet, ~9° forward lean, counter opened for 16px. The mark stays red `#C83C3C`. One tile spec: `#121B31`, radius 7/32, no rim, mark 22/32 high. Min size 16px (mark), clear space ¼ mark height. | `docs/brand/logo/` (SVG, ICO, PNG, `final-sheet.png`); pre-screen `LOGO_SIMILARITY_PRESCREEN.md` (not legal clearance; a trademark search by counsel is still required) |
| G2 Palette | **Indigo on graphite** is the default for dark, **indigo** for light. Marketing uses exactly this, with no options (dark/light only). Ops and tenant get a theme picker: accent Indigo / Violet / Mono / Lime × background Graphite / Navy × mode Dark / Light / System. Amber becomes a status colour only. | `docs/brand/palettes/` (`indigo.css`, `violet.css`, `mono.css`, `lime.css`; each has navy, graphite and light blocks) |
| G3 Type | **Geist + Geist Mono** (OFL, ~50 KB self-hosted). Label rules: sentence-case sans labels at 12px or larger; mono only for facts (IDs, domains, ASNs, timestamps, counts); tabular numerals; `calt`/`liga` off in mono. | Scale: display 32/36/600/−0.03em, h1 24/30/600, h2 18/24/600, body 14/21/400, small 13/18, label 12/16/500/+0.01em, mono 13/20; marketing hero 84/0.98/600/−0.045em, section 44/1.06/600, body 18/1.6 |
| Sidebar | Default (owner not yet confirmed): logo without the "THREAT INTELLIGENCE" tagline (too small to read there); the tagline stays on login and marketing. | — |

Known follow-ups for the build: Violet collides with the hardcoded NEXUS tag purple (`#A78BFA`); Lime needs "healthy" green shifted to emerald; the ops `Button` hardcodes `color:#000`; canvas/WebGL colours must read tokens at runtime.
