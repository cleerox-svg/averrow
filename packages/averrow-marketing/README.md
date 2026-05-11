# @averrow/marketing

Astro + MDX rebuild of the Averrow corporate marketing site
(averrow.com). See `docs/marketing-rebuild-evaluation.md` at the
repo root for the decision rationale and the phased migration
plan (R1–R7).

## Status: R1 — skeleton only

This package contains only the build pipeline and a placeholder
page right now. Production marketing pages are still served by
inline TypeScript templates in `packages/trust-radar/src/templates/*.ts`.

## Architecture

```
packages/averrow-marketing/
├── src/
│   ├── pages/        ← Astro routes (.astro / .mdx)
│   ├── layouts/      ← shared layouts (R2+)
│   ├── components/   ← Astro components (R2+)
│   ├── islands/      ← React islands for interactive widgets (R2+)
│   └── content/      ← MDX content collections — blog, changelog (R3+)
├── astro.config.mjs  ← outDir points into trust-radar/public/marketing/
└── package.json
```

Astro builds with `output: 'static'`. The output is written
directly into `packages/trust-radar/public/marketing/` so the
trust-radar Worker's existing Static Assets binding picks it up
without any wrangler.toml changes.

## Local development

```bash
# From the repo root
pnpm install
pnpm --filter @averrow/marketing dev          # http://localhost:4321/marketing/

# Production build (writes to ../trust-radar/public/marketing/)
pnpm --filter @averrow/marketing build

# Then serve via the Worker
pnpm --filter @averrow/trust-radar dev        # whatever port wrangler picks
# -> http://localhost:8787/marketing/
```

## Deploy

The Worker deploy handles it. Turbo ensures this package builds
before trust-radar, so the static files are present in
`public/marketing/` when wrangler uploads.

```bash
# From the repo root
pnpm turbo build --filter=@averrow/trust-radar
pnpm --filter @averrow/trust-radar deploy
```

## Migration phase plan

| Phase | Scope |
|-------|-------|
| **R1** | Astro skeleton, build pipeline wired, served at `/marketing/`. **← we are here** |
| R2     | Port shared layout + theme island; first cutover page (`/changelog`) |
| R3     | Blog + 4 posts → MDX content collection + Astro RSS |
| R4     | `/about`, `/contact`, `/security`, `/report-abuse`, `/pricing` |
| R5     | `/platform`, `/` (with the intercept-ticker island) |
| R6     | Production cutover — drop the `/marketing` prefix, retire inline templates |
| R7     | Lighthouse + Playwright regression suite, OG images, sitemap automation |
