# @averrow/marketing

Astro + MDX rebuild of the Averrow corporate marketing site
(averrow.com). See `docs/marketing-rebuild-evaluation.md` at the
repo root for the original decision rationale.

## Status: production — R7 shipped

All R1–R7 phases are merged. The Astro build is the canonical
marketing surface; the inline TypeScript templates that used to
serve `/`, `/platform`, `/about`, `/pricing`, `/security`,
`/contact`, `/report-abuse`, `/blog`, and `/changelog` are
retired. `homepage.ts` is kept solely to power `/legacy` and
`/assess/<id>/results`, which are Worker-only flows.

## Architecture

```
packages/averrow-marketing/
├── src/
│   ├── pages/        ← Astro routes (.astro / .mdx)
│   ├── layouts/      ← shared layouts
│   ├── components/   ← Nav, Footer, TrustSignals
│   ├── islands/      ← React islands — ThemeCycle.tsx only
│   ├── content/      ← MDX content collections (blog)
│   ├── data/         ← stats.json (refreshed at build time)
│   ├── lib/          ← nav.ts, blog.ts helpers; motion/ (scroll motion)
│   ├── scripts/      ← hero.ts (homepage hero runner)
│   └── styles/       ← tokens.css + global.css
├── scripts/
│   ├── fetch-stats.mjs       ← prebuild: pulls /api/v1/public/stats
│   ├── generate-sitemap.mjs  ← postbuild: walks dist/ → sitemap.xml
│   └── sync-to-worker.mjs    ← postbuild: overlays dist/ → averrow-worker/public/
├── tests/
│   └── *.spec.ts             ← Playwright specs (smoke, hero, motion, perf-budget, ...)
├── astro.config.mjs
├── playwright.config.ts
└── package.json
```

Astro builds with `output: 'static'`. The artifacts land in
`./dist/`, then `sync-to-worker.mjs` overlay-copies them into
`packages/averrow-worker/public/` so the averrow Worker's
`[assets]` binding serves them. Going through `dist/` + sync
keeps Astro's outDir cleanup from wiping the legacy SPA assets
(`app.js`, `dashboard.html`, `public/v2`, `public/tenant`) that
share the directory.

## Build pipeline

```
node scripts/fetch-stats.mjs        ← grab live numbers (fails-soft)
↓
astro build                         ← static HTML + island chunks → dist/
↓
node scripts/generate-sitemap.mjs   ← walk dist/, emit sitemap.xml
↓
node scripts/sync-to-worker.mjs     ← overlay copy into averrow-worker/public/
```

`@astrojs/sitemap` is intentionally NOT used — version 3.7.x
crashes on Astro 4.16 with an internal `reduce()` against
`undefined`. The custom generator above is the workaround.

## Local development

```bash
# Repo root
pnpm install
pnpm --filter @averrow/marketing dev          # http://localhost:4321
pnpm --filter @averrow/marketing build        # full pipeline
pnpm --filter @averrow/marketing preview      # serve dist/
pnpm --filter @averrow/marketing test:e2e     # Playwright smoke
pnpm --filter @averrow/marketing test:e2e:ui  # interactive
```

To point Playwright at staging or production instead of the
locally-built preview:

```bash
PLAYWRIGHT_BASE_URL=https://staging.averrow.com \
  pnpm --filter @averrow/marketing test:e2e
```

## Motion

Progressive enhancement throughout: the server-rendered HTML is the
finished state, and every motion path is skipped under
`prefers-reduced-motion: reduce`.

### Scroll sequences (`src/lib/motion/`)

- `loader.ts` exports `initScrollMotion()`, the only motion code in a
  page's initial bundle. It returns early for reduced motion or no
  `IntersectionObserver`. Otherwise it watches every `[data-motion]`
  section and, once one is within 320px of the viewport
  (`LOAD_MARGIN`), dynamic-imports `./sequences` (the lazy chunk that
  carries GSAP core) and calls `enhance(section)` on it. A failed
  import leaves the static page untouched.
- `sequences.ts` exports `enhance()`. Plain GSAP core tweens, no
  ScrollTrigger: an `IntersectionObserver` (plus a read-only scroll
  check for fast jumps) plays each section once, so hash deep links
  land where the browser put them. Entrances are 200ms, 8px travel,
  `power3.out`; numbers are never animated. A section already in view
  when the chunk arrives is left alone. `@media print` in
  `styles/global.css` forces the end state.
- The section's `data-motion` value picks the kind: `reveal`
  (`[data-motion-head]`, then children of `[data-motion-items]`),
  `stagger` (the section's own children) and `numbers` (reveal, plus
  the `.num-bar-f` bars grow from 0).
- Who uses it: `components/TakedownFlow.astro` and
  `components/Coverage.astro` (`reveal`), `components/ByTheNumbers.astro`
  (`numbers`), and the two `stagger` lists in `pages/platform.astro`.
  The components appear on `/` (all three), `/platform` (Coverage)
  and `/platform/takedowns` (TakedownFlow); each calls
  `initScrollMotion()` from its own `<script>`.

### Homepage hero (`src/scripts/hero.ts`)

`hero.ts` exports `start(root)`, the H4A "auto-play steps" runner
(canvas 2D + `requestAnimationFrame`, geometry from
`src/lib/hero-graph.ts`). `components/hero/OperationHero.astro`
renders an SVG poster of the finished operation and a step list, and
imports `hero.ts` after `load` plus idle. A pre-paint script adds the
`lv` class only when motion is allowed, so reduced-motion visitors
never load the runner. If the chunk fails, `lv` is removed and the
poster stays. The story plays three times, then rests on the finished
operation; the rAF loop pauses when paused, off-screen or in a hidden
tab. Tests fast-forward it with `window.__heroSpeed`.

### Page transitions

`styles/global.css` opts in to native cross-document view transitions
(`@view-transition { navigation: auto; }`). The nav and logo keep
`view-transition-name`s (`site-nav`, `site-logo`) so only the page
body cross-fades, using `--motion-slow` and `--ease-standard`. There
is no client router. Browsers without them (Firefox) take the
fallback: the pre-paint script in `layouts/Layout.astro` tests for
`CSSViewTransitionRule`, and when it is missing and the referrer is
the same origin, sets `data-vt="fallback"` on `<html>`. Then
`:root[data-vt="fallback"] main` plays a short `page-in` fade. Both
are disabled under reduced motion.

### Playwright projects

`playwright.config.ts` defines four projects: `chromium` (Desktop
Chrome), `mobile` (Pixel 5), and `firefox` (Desktop Firefox) and
`webkit` (Desktop Safari). The last two only match
`hero.spec.ts` and `motion.spec.ts`, so the hero and motion are
checked in every engine. They use Playwright's own browsers and clear
the pre-installed-Chromium override.

```bash
cd packages/averrow-marketing
pnpm exec playwright install firefox webkit
pnpm exec playwright test --project=firefox --project=webkit
```

CI (`.github/workflows/ci.yml`, job `marketing`) currently installs
Chromium only and runs `--project=chromium`; Firefox and WebKit are
a local gate.

## Adding a blog post

```bash
# 1. Create packages/averrow-marketing/src/content/blog/<slug>.mdx
#    with frontmatter (title, excerpt, category, author,
#    publishedAt, readingMinutes).
# 2. Build — the index, RSS feed, related-posts strip, and
#    sitemap pick it up automatically.
pnpm --filter @averrow/marketing build
```

## Deploy

The Worker deploy handles it. Turbo ensures `@averrow/marketing`
builds before `averrow-worker`, so the static files are present in
`public/` when wrangler uploads.

```bash
pnpm turbo build --filter=averrow-worker
pnpm --filter averrow-worker deploy
```
