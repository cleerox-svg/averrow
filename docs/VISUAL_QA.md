# Visual / Responsive QA

How to render the platform's UI at real viewports and catch responsive
defects (horizontal overflow, invisible-in-light-mode text, broken
layouts) that a static code read misses.

## Why this doc exists

The browser MCP tools (`playwright` / `chrome-devtools`) hardcode the
Chrome **channel** and can't launch in the build environment, so for a
long stretch UI shipped with *static-only* responsive review — nobody
rendered it at a phone width. That's how a light-mode form whose inputs
were white-on-white, and an ops tab bar in the wrong amber hue, both got
past review.

The fix: `@playwright/test`'s **default chromium** resolves via
`PLAYWRIGHT_BROWSERS_PATH` (`/opt/pw-browsers`) to the pre-installed
browser, so it *does* run here. Use it, not the MCP tools, for visual QA.

## Marketing site — automated overflow gate

`packages/averrow-marketing/tests/responsive.spec.ts` renders every key
route at mobile / tablet / desktop (375 / 768 / 1440) and fails if the
page scrolls horizontally, naming the widest offending element.

```bash
pnpm --filter @averrow/marketing test:responsive
```

It reuses the existing Playwright `webServer` config (builds + serves the
Astro preview automatically) and screenshots on failure. Add a route to
the `ROUTES` array in the spec when you ship a new marketing page. This
is cheap enough to run before merging any marketing layout change.

## SPA pages (averrow-ops / averrow-tenant) — component isolation

The SPAs sit behind cookie-refresh auth, so a full-app render needs a
live backend. To validate **one authed component's** responsive layout
without a backend, mount it in isolation in a real browser with the
network layer stubbed. This was used to validate the tenant Executives
registry form (light + dark, 3 viewports) and works for any component.

Recipe:

1. **Build the component with the real Tailwind pipeline** — keep Vite's
   `root` at the package (so `postcss.config.js` + `tailwind.config.ts`
   resolve and utilities generate); point the build `input` at a small
   harness `index.html` that imports the component.
2. **Stub only the network + auth layers.** A `resolveId` Vite plugin
   redirects `@/lib/api` + the relative `./api` (imported from
   `src/lib/*`) to a stub, and `@/lib/auth` + `@averrow/shared/auth` to a
   mock `useAuth` returning an admin user with an org. Everything else is
   the real code.
3. **Match the API envelope.** `apiGet` returns `{ data: T }` and the
   hooks read `res.data` — the stub must wrap payloads the same way, or
   the component renders its empty state.
4. **Mount** in `<QueryClientProvider>` (retry off) + `<MemoryRouter>`,
   serve the built `dist`, and drive it with `playwright-core` against
   `executablePath: process.env.PLAYWRIGHT_BROWSERS_PATH + '/chromium'`.
5. **Force the theme after boot** — the app's own theme bootstrap runs on
   mount, so set `data-theme="light"` via `page.evaluate` *after* load to
   capture the light variant; confirm with
   `getComputedStyle(document.documentElement).getPropertyValue('--bg-page')`.
6. Assert no horizontal overflow (`documentElement.scrollWidth <=
   innerWidth + 1`) and screenshot each viewport × theme.

This isolation harness is intentionally not committed as a permanent
fixture (it's per-component throwaway); build it under a package's
gitignored scratch dir when a specific SPA surface needs a visual check,
and delete it after.
