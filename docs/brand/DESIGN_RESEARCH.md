# Facelift design research (Phase 0, 2026-11-07)

Input for the palette (G2), type (G3), motion (G4) and hero (G5) gates. Visual captures of every site below are on the **03 · Inspiration** page of the [Averrow Facelift Figma file](https://www.figma.com/design/sKbhtb1OVruSN1CQPrwSLb): first view, after scrolling, and a 9-second motion loop.

Owner tone decision: **sharper edge** (see `BRAND_BRIEF.md` §8). Raycast and Vercel are the closest tone references; Linear and Resend set the craft bar.

Confidence: (V) verified from a source read; (I) inferred or from third-party extraction. Re-check (I) items before a gate relies on them. Cloudflare Radar and SentinelOne blocked automated capture and are not on the Inspiration page.

## Techniques worth stealing, ranked by impact per kilobyte

| # | Source | Technique | Averrow use | Build | Cost |
|---|---|---|---|---|---|
| 1 | Linear (V) | Theme generated in a perceptual colour space (LCH) from base, accent and contrast | Derive both themes and every severity tint from one lightness scale, so AA contrast and severity separation are arithmetic | CSS `oklch()` tokens | 0 kB |
| 2 | Linear (V pairing, I tracking) | Display cut + text cut of one family, tight display tracking | One display cut, one text cut, mono only for facts | Self-hosted variable font | ~30–60 kB |
| 3 | Resend (V) | Accent colours communicate state, not style; tinted background + bright foreground per status | Matches the `--sev-*-bg` / `--sev-*-text` pattern and the "replace amber" decision | Tokens | 0 kB |
| 4 | Resend (V) | One serif display moment on marketing only | Editorial "intelligence report" headline; never in product UI | One licensed weight | ~20 kB, paid |
| 5 | Vercel Ship / Basement (V) | SVG version renders first, WebGL particles take over when ready | Static operation-graph poster first, then a small WebGL node-link scene; poster under reduced motion | Regl or raw WebGL, lazy on idle | ~25–40 kB, no LCP impact |
| 6 | Stripe (V) | Small custom WebGL gradient shader as the signature motion | A dark two-tone, low-frequency light field behind the hero, paused off-screen. Not a rainbow | One fragment shader, half-res canvas | ~5 kB, moderate GPU |
| 7 | Linear, Raycast (V/I) | Real product UI as the hero | Hero built from real components: a feed row arrives, nodes link into an operation, a takedown moves Detected → Submitted | Motion over existing components | 0–15 kB |
| 8 | Chrome docs (V) | Cross-document View Transitions | Shared header; brand/entity avatar morphs between list and detail | `@view-transition` + `view-transition-name` | ~0.5 kB CSS |
| 9 | (I) | Scroll-linked CSS animation | Section reveals and the hero choreography without a scroll library | `animation-timeline: view()` behind `@supports` | 0 kB JS |
| 10 | Linear, Raycast (I) | Depth by layered surfaces and hairline borders, not glow or blur | Stepped elevation with one top-edge highlight; avoid large `backdrop-filter` | CSS | 0 kB |
| 11 | Resend (V) | Mono for facts, tabular numerals | ASNs, IDs, timestamps and live counts stop jittering | `font-variant-numeric: tabular-nums` | 0–20 kB |
| 12 | Resend tokens (I) | ~200 ms ease-out row insertion with a brief tinted settle | Live alert and event rows | CSS or Motion `layout` | 0–18 kB |

## Three candidate visual directions

| Direction | References | Character | Risk |
|---|---|---|---|
| **A. Instrument** | Linear, Resend | Near-black graphite, one cool accent, single grotesque + mono, 120–240 ms state motion, hero built from real UI | Can read as a Linear clone; weakest fit for "sharper edge" |
| **B. Dossier** | Resend's serif display, editorial layouts | Ink/graphite with paper tones in light mode, narrow serif display, sparse typographic reveals | Serif may feel off-category to CISOs |
| **C. Operation Graph** | Vercel Ship particle hero, Raycast, Stripe gradient | Direction A's neutrals, severity colour only on graph nodes, one WebGL scene assembling an operation | Closest to the "glowing arcs" cliché; heavier JS. Works only if the graph shape is real |

Given the sharper-edge decision, **C (with A's restraint in the product UI)** is the strongest starting point; B stays in the set as the contrast option.

## Clichés to avoid

- Recorded Future: grey card template, "machine speed" language, testimonial + logo wall.
- Doppel: logo wall directly under the hero, big stat callouts, award-badge wall.
- Wiz: lead form in the hero, Fortune-100 logo strip, carousels that hide content.
- ZeroFox: globe, shields and dark-gradient clichés.
- Cloudflare Radar's attack map: keep this kind of visual inside the product, not as marketing wallpaper.
- General: shields, padlocks, hooded figures, green-on-black, radar sweeps, gradient blobs.

## Typeface candidates

| Role | Typeface | Licence |
|---|---|---|
| UI / body | Inter, Inter Display | OFL, free (V) |
| Display / UI | Geist Sans | OFL, free (I) |
| Mono | Geist Mono, JetBrains Mono (current) | OFL, free (I) |
| Mono | CommitMono | OFL, free (V) |
| Headings | Favorit | Paid per style (price unverified) |
| Display serif | Domaine Display Narrow | Paid (price unverified) |

Any paid licence needs the owner's OK before merge (CLAUDE.md §9a).

## Sources

- Linear: https://linear.app ; https://madegooddesigns.com/?p=114676 ; unofficial token extraction https://design.hagicode.com/designs/linear.app/
- Vercel: https://vercel.com ; https://rauno.me/craft/vercel ; https://basement.studio/post/behind-the-ship ; https://basement.studio/post/shipping-ship-behind-the-particle-shader-effect-for-vercels-conf
- Stripe gradient: https://www.bram.us/2021/10/13/how-to-create-the-stripe-website-gradient-effect ; https://npmjs.com/package/stripe-gradient
- Resend: https://resend.com/design.md
- Raycast (unofficial): https://www.saasframe.io/examples/raycast-landing-page ; https://design.hagicode.com/designs/raycast/
- View Transitions: https://developer.chrome.com/docs/web-platform/view-transitions
- Cloudflare Radar: https://blog.cloudflare.com/attack-maps-now-available-on-radar
- Peers: https://www.recordedfuture.com ; https://www.doppel.com ; https://www.wiz.io
