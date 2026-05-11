# Marketing Site Rebuild — Stack Evaluation

> **Status:** Recommendation pending sign-off
> **Author:** Marketing-site polish batch, Item 7
> **Decision needed:** React (matching platform) or Astro/MDX (purpose-built for content)

---

## Context

The marketing-site polish batch (Items 1–6 + nav redesign, PRs #1233–#1240) has taken the inline-template-string approach as far as it can productively go. The site looks consistent, the funnel is unified with the platform, and the structural backbone is in place.

What we **can't** keep doing past this point:

1. **Adding a blog post** still requires touching three files (manifest, post template, route). MDX would make it one file.
2. **Adding a marketing page** still requires writing a 200–800 line TypeScript template-string function in the Worker.
3. **A/B tests, marketing experiments, and partner pages** can't be authored by anyone who doesn't read TypeScript.
4. **Total marketing-template surface is now ~12,700 LOC** in inline strings. The single largest file (`homepage.ts`) is 1,808 lines of mixed HTML/CSS/JS.

The strategic question: **what stack do we move to so the next year of marketing iteration is faster, not slower?**

---

## Current state

```
Marketing surface today (Worker-served, inline strings)
────────────────────────────────────────────────────────
homepage.ts             1,808 LOC
shared.ts (nav/footer)  1,575 LOC  (now shared across pages)
platform.ts               782 LOC
security.ts               798 LOC
pricing.ts                377 LOC
blog.ts + 4 posts         648 LOC
changelog.ts              278 LOC
about.ts                  256 LOC
contact.ts                252 LOC
report-abuse.ts           305 LOC
not-found.ts              600 LOC
status.ts                 430 LOC
+ misc                  3,000 LOC
                       ─────────
                       ~12,700 LOC
```

Pages live in `packages/trust-radar/src/templates/*.ts`, registered as routes in `routes/public.ts`. The same Worker that serves these pages also handles the API.

The platform proper (`packages/averrow-ops`) is a React 18 + Vite SPA gated behind auth — totally different use case.

---

## Requirements the rebuild must satisfy

1. **SEO / crawlability**: every marketing page must be server-rendered HTML on first byte. Link unfurls, Twitter cards, search engines depend on it.
2. **Reuse the platform design system**: tokens, components, glass-card aesthetic.
3. **Content authoring**: blog posts in MDX or similar so marketing can ship a post without engineering review.
4. **API co-location**: `/api/*` keeps working on the same domain without a reverse proxy.
5. **Same Worker, same deploy**: minimum infrastructure churn. We don't want a Pages/Worker split if we can avoid it.
6. **Honeypot infrastructure preserved**: `generateSpiderTraps()` spam-trap links continue to render in every page.
7. **Theme system preserved**: dark default + light toggle + auto (3-mode cycle) keeps working across the rebuild.

---

## Option A — React + Vite (SSG output, Worker Assets binding)

### Architecture
- New package: `packages/averrow-marketing` — React 18, Vite, react-router-dom (server-side data routing for SSG).
- Build step: Vite SSG plugin (`vite-ssg` or similar) renders every route to static HTML at build time.
- Static `.html` + `.js` + `.css` artifacts written to `packages/averrow-marketing/dist/`.
- Worker (`packages/trust-radar`) serves those static files via the Workers **[Static Assets](https://developers.cloudflare.com/workers/static-assets/)** binding. `/api/*` continues to be Worker-handled.
- Blog content authored as `.mdx` via `@mdx-js/rollup`.

### Pros
- **Reuse from averrow-ops is nearly free.** Same React version, same Vite stack, can lift `Card`/`Button`/`Badge` primitives directly. The biggest win from a "DRY across the funnel" perspective.
- **Engineers already write React.** No new language paradigm to learn.
- **Component model is identical** to platform — Storybook (if we ever add it) would cover both.

### Cons
- **React SSG is structurally heavier than what we need.** Marketing pages are 95% static HTML with a few interactive islands (theme toggle, blog filter, mobile menu). Hydrating the whole page wastes bytes and CPU.
- **Initial JS payload is ~80–120 KB even for static pages** because React + react-router + the runtime ship even when no interactivity is on screen.
- **Vite SSG tooling is a moving target.** `vite-ssg` works but is a single-maintainer project; React's own framework story (Next.js, Remix) doesn't deploy cleanly to a single Worker without significant adapter work.
- **MDX integration in React is workable but not elegant.** You import each post as a component; collection-style "list all posts" requires either codegen or runtime glob.
- **SEO defaults are weaker.** OG image generation, sitemap automation, canonical URL handling, structured data — all require third-party packages or custom code.

### Migration cost estimate
~14–18 working days:
- New package skeleton + Vite SSG config: 2 days
- Port shared.ts (nav/footer/wrapPage) to React: 2 days
- Port 12 pages (home/platform/pricing/about/security/blog/contact/changelog/status/scan/not-found/report-abuse): 6–8 days
- Port 4 blog posts to MDX + collection plumbing: 1 day
- Worker assets binding + routing: 1 day
- QA + Lighthouse parity check: 2 days
- Buffer for surprises: 2 days

---

## Option B — Astro + MDX (SSG output, Worker Assets binding)

### Architecture
- New package: `packages/averrow-marketing` — Astro 4+ with the static adapter and the React integration enabled.
- Astro components (`.astro`) for layout, navigation, page templates.
- Blog and changelog in `.mdx` via Astro's built-in content collections (`src/content/blog/*.mdx`, `src/content/changelog/*.mdx`).
- React **islands** for the few interactive widgets we actually need: theme toggle, blog filter chips, mobile menu hamburger, the synthetic intercept ticker on the homepage. Each ships only its own JS.
- Build output is plain `.html` + per-island JS chunks written to `dist/`.
- Worker (`packages/trust-radar`) serves those static files via the Workers Static Assets binding, same as Option A. `/api/*` continues to be Worker-handled.

### Pros
- **Zero JS by default.** A page with no islands ships zero JS. The pricing page would be ~6 KB HTML + CSS instead of 100+ KB. This compounds across the visit funnel.
- **MDX + content collections is the headline feature.** A new blog post is `src/content/blog/new-post.mdx` — one file, frontmatter for metadata, body is Markdown. Astro auto-generates routes, paginates, types the collection, and surfaces `getCollection('blog')` for the index page.
- **First-class SEO.** Astro ships `<ViewTransitions/>`, automatic sitemap generation, RSS helpers, OG image generation via `@astrojs/og`, canonical URL handling, and structured-data conventions.
- **Built for the content-site DX we need.** Astro is purpose-built for marketing sites, docs, and blogs. We'd be using it for its core use case.
- **Reuses platform React components inside islands.** When we need a non-trivial interactive widget, we drop `<Component client:idle />` and bring the React primitive from averrow-ops in.
- **Faster build, faster ship.** Per the Astro team's benchmarks (and matching what folks report at our scale), a 12-page Astro site builds in seconds. Vite SSG of an equivalent React site takes ~3–5× longer because React renders every page tree to a string.

### Cons
- **New language paradigm.** `.astro` components are HTML-first with a JS frontmatter block, not React. Engineers comfortable with React learn a slightly different mental model. Curve is shallow but real (~1 day).
- **TypeScript story is slightly less polished** than pure React (Astro infers types in `.astro` files via a language server; works well in VS Code, less so in other editors).
- **Less code shared with platform.** We can pull React components into islands, but Astro's own layout/page primitives don't exist in averrow-ops. Marginally more "two ways of writing UI" in the monorepo.
- **Astro 5 is brand-new.** Astro 4 is the stable target. Worth pinning the major version.

### Migration cost estimate
~9–12 working days:
- New package skeleton + Astro config: 1 day
- Port shared layout (nav/footer/head) to `.astro`: 1 day
- Port 12 pages: 3–4 days (Astro pages are HTML-first, faster to port than re-writing as React)
- Port 4 blog posts to MDX + content collection schema: 1 day
- Build the 4 islands (theme toggle, blog filter, mobile menu, intercept ticker) in React: 1.5 days
- Worker assets binding + routing: 1 day
- QA + Lighthouse parity check: 1.5 days
- Buffer for surprises: 1 day

---

## Side-by-side

| Dimension | React + Vite SSG | Astro + MDX |
| --- | --- | --- |
| **Bytes shipped per page (median)** | ~110 KB JS + HTML | ~6 KB HTML, JS only on islands |
| **Time to first byte (Worker edge)** | ~30–40 ms | ~30–40 ms (both static) |
| **Lighthouse Performance ceiling** | 85–95 (hydration overhead) | 99–100 (zero-JS pages) |
| **Blog post authoring** | Import `.mdx` as component | Drop `.mdx` in `src/content/blog/` |
| **Sitemap / RSS / OG images** | Custom code | Built-in integrations |
| **Reuse from `averrow-ops`** | High (same paradigm) | Medium (components via islands) |
| **Migration cost** | 14–18 days | 9–12 days |
| **Long-term maintenance** | Familiar to all engineers | One additional paradigm in the monorepo |
| **Vendor risk** | High — Vite SSG is third-party | Low — Astro is the framework |

---

## Recommendation: **Astro + MDX, served via the same Worker via Static Assets binding**

### Why
1. **The marketing site is content-first, not app-first.** Every other choice traces back to that. React was the right call for the platform because it's a heavily interactive dashboard. Astro is the right call here because the marketing site is information design with light interactivity.
2. **Performance compounds.** A 100 KB savings per page on a multi-page visitor flow is a 500–700 KB savings over a session. That translates to better Lighthouse scores, faster mobile loads on bad networks, and lower Workers CPU per request.
3. **Content authoring scales.** Once MDX collections are wired up, marketing can ship a blog post or partner page without engineering review. That's a structural shift, not a polish improvement.
4. **Migration is cheaper.** ~9–12 days vs ~14–18 days, with less custom plumbing.
5. **It still reuses platform components.** When we need a React widget (a date picker, a search box, anything stateful), we drop it into an island. The platform's design system stays the single source of truth for primitives.

### Where React still applies
- The platform itself (`averrow-ops`, `averrow-tenant`) stays React — no change there.
- The 4 interactive islands inside the Astro site are written in React, importing the same platform primitives.

### Risks + mitigations
| Risk | Mitigation |
| --- | --- |
| Engineers unfamiliar with `.astro` syntax slow down | Pair-program first 2–3 pages; the curve is ~1 day |
| Worker Static Assets binding has surprises at our scale | Stage on `staging.averrow.com` for a full week before flipping production |
| Build pipeline gets more complex (two build steps: marketing + worker) | Monorepo build orchestration via existing `turbo.json`; CI just adds one job |
| The honeypot spider-trap injection needs reproducing | One Astro middleware (or a build-time post-processor) replaces `generateSpiderTraps()`. Day-1 task. |
| Existing inline-string templates need to keep working during migration | Cutover is per-route. Worker keeps serving the old template until the new Astro route is live. |

---

## Proposed migration plan (Phase 1 = this PR's follow-ups)

Each step a separate PR, paused for merge between, matching the cadence of Items 1–6.

| PR | Scope | Estimated effort |
| --- | --- | --- |
| **R1** | Add `packages/averrow-marketing` Astro skeleton. Wrangler Static Assets binding wired. Build pipeline integrated with `turbo.json`. Staging-only — production still serves from the old templates. | 1–2 days |
| **R2** | Port `Layout.astro` (nav/footer/head), tokens, and the theme cycle island. Smoke-test on a single low-stakes route (`/changelog` is a good first cut — pure content). Old template stays for everyone else. | 1.5 days |
| **R3** | Port `/blog` + 4 posts to MDX content collection. Wire up RSS feed via Astro integration (replaces our hand-rolled `blog-rss.ts`). | 1.5 days |
| **R4** | Port `/about`, `/contact`, `/security`, `/report-abuse`, `/pricing`. Static pages, no islands beyond what Layout already provides. | 2 days |
| **R5** | Port `/platform` and `/`. These are the heaviest pages — animated intercept ticker, agent squadron grid, etc. Hero ticker becomes a React island. | 2 days |
| **R6** | Cut over routing. Worker's `routes/public.ts` drops the per-page `htmlPage(renderXxxPage)` entries; the Static Assets binding takes over. Old templates deleted. | 0.5 days |
| **R7** | Lighthouse + Playwright snapshot regression suite, OG image generation, sitemap automation, final cleanup. | 1 day |

Total: **9–11 working days** of focused work, spread across 7 PRs.

---

## What I need from you before R1

This PR is the decision artifact. No code changes — just the writeup. Approve direction one of two ways:

- **Approve as written** → I open R1 immediately.
- **Disagree / want React anyway** → reply with why; I'll re-scope to Option A and re-plan.

If approved, R1 lands the skeleton on staging only — production behavior is unchanged until R6.
