# UI Consolidation Plan (2026-10)

Source review: the "Averrow Interface Review" (Oct 2026). Phase 0 shipped in #1736. It deleted dead UI files, the preview harness, unused deps, the `?cards=classic` switch and MilestoneBanner. It also made two route aliases redirect and stopped load failures being hidden as an all-clear.

Phase 1 consolidates the ops console onto one shell and one component kit. PRs ship one at a time on a single branch, in the order below. Each PR goes through the CLAUDE.md §1A pipeline: build, test, `qa-verifier`, then review.

## Owner decisions (2026-10-02)

| Topic | Decision |
|---|---|
| Brand admins in ops (`isBrandAdmin`) | Get the normal Overview. Delete `BrandAdminDashboard` and the classic sidebar's org label. |
| Unused frozen components (`ThreatMap`, `ExposureGauge`, `Sparkline`, `ActivitySparkline`) | Delete them and remove them from the CLAUDE.md frozen list. `PortfolioHealthCard` and `EventTicker` stay frozen. |
| PWA prompts | Re-mount them. `InstallAppBanner` goes on Overview, `InstallAppCard` on Profile, and `PasskeysCard` wherever the shared Profile page expects it. **Revised 2026-10-03:** `PasskeysCard.tsx` is deleted instead — it duplicated the shared `PasskeysSection` (`packages/shared/src/profile/sections.tsx`) that the shared `ProfilePage` already renders. |
| Worker legacy `/admin/organizations` redirect | Point it at `/v2/admin/customers`, matching the SPA. |
| Font pair | Plus Jakarta Sans and JetBrains Mono everywhere, including the shared login. FarmTrack must adopt the same pair to stay identical (SHARED_LOGIN_SPEC). |
| Daily briefing | Use one briefing component with two data sources. Home shows the intelligence briefing; the `/admin` Briefing tab shows the ops briefing. |
| Phone navigation in ops | The v4 slide-out menu only, in both orientations. The classic bottom tab bar is not ported. (Revised the same day; the first answer was to port it.) |

## Phase 1 PRs

1. **Foundations.** *(Shipped, #1737.)* Add the font pair, a radius scale, motion tokens and a global reduced-motion rule to `packages/shared/src/theme/tokens.css`, and wire both apps to them. The font pair applies to the ops and tenant SPAs and the shared login. Worker-rendered public templates and marketing still use IBM Plex and are out of scope for now.
2. **v4 parity.** *(Shipped, #1738.)* Add these to `ShellV4.tsx`:
   - NotificationBell and the avatar menu
   - PlatformAlertBanner
   - the theme toggle
   - the open-alert badge via `useOpenAlertCount`
   - a check that the slide-out menu works on phones in both orientations

   Classic is not switched off yet.
3. **Switch to v4.** *(Shipped, #1739; follow-up #1745.)* Make v4 the only shell and delete the classic one: Shell, Sidebar, TopBar, MobileNav, the drawer, DeepBackground, PageTransition, `useShellVersion`, the "Try v4" pill, `HomeUnified` and `framer-motion`. Also delete `BrandAdminDashboard` and the unused frozen components.

   Follow-up: remove the server endpoint `GET /api/dashboard/brand-admin` (and its `docs/API_REFERENCE.md` entry) — it has no client after this PR.
4. **Routes.** *(Shipped, #1747.)* Turn the 18 standalone routes into `?tab=` redirects that keep query strings. Rewrite in-app and ⌘K links. Fix the worker's links, including the broken `/admin/feeds` and `/admin/agents` and the legacy `/admin/organizations` redirect. Keep one incidents list.

   Follow-ups that shipped alongside it: audit-log `view_audit` gating (#1748) and the org webhook secret fix (#1749).
5. **Shared kit.** *(Shipped, #1750.)* Add these to `@averrow/shared/ui`, with one barrel:
   - Badge (severity, status and classification)
   - StatTile
   - PageState
   - Table
   - Tabs
   - FilterBar
   - PageHeader
   - Sparkline
   - Avatar

   The barrel is `packages/shared/src/ui/index.ts` (it also re-exports the existing Button and Card). Correction: `@averrow/shared/ui` did not have 0 imports before this PR. `Button` was already imported by two ops files (`components/v4/TabbedWorkspace.tsx` and `features/console/Console.tsx`). Usage rules are in `AVERROW_UI_STANDARD.md` "Shared kit".
6. **Collapse duplicates in ops.** Too large for one reviewable diff, so it ships as three PRs (6a, 6b, 6c), one at a time. The ops `design-system/components/index.ts` barrel becomes the single import path and re-exports the kit.

   **6a. Barrel and drop-in components.** *(Shipped, #1752.)*
   - One barrel: `components/ui/index.ts` is folded into `@/design-system/components` and deleted. Deep imports of the moved components are rewritten to the barrel.
   - Aliases deleted: `DeepCard` (call sites renamed to `Card`), `SeverityChip`, `DimensionalAvatar`, `DimensionalButton`.
   - Badge, Tabs, FilterBar, Sparkline and Avatar come from `@averrow/shared/ui`; the ops copies are deleted (`Badge`, `Tabs`, `FilterBar`, `Avatar`, `BrandAvatar`, `TrendSparkline`, `SeverityPill`). One-off pills (DarkWeb, BrandDetail, CampaignDetail) and the local `StatusBadge` copies (Providers, Campaigns, spam-trap `CampaignPanel`) now use `Badge`. Local single-series sparklines (Pipelines, BrandDetail) use `Sparkline`; `BrandsGrid`'s `FaviconAvatar` uses `Avatar tone="neutral"`.
   - `PageHeader` is a thin ops adapter (`design-system/components/PageHeader.tsx`) over the shared one. It maps `back.to` to `navigate()`; the shared header drops its `<h1>` and subtitle inside a workspace. Console wraps its panes in `WorkspaceEmbedProvider`, and the five panes that rendered a raw `<h1>` (Brands, Trends, AttributionBacklog, AdminAudit, PricingConfig) use the PageHeader, so every `TabbedWorkspace` and Console tab shows exactly one `<h1>`.
   - `.ds-focusable` is not undefined: it is defined in `packages/shared/src/theme/tokens.css:344-372` (focus ring, an amber-surface variant and a light-theme override), so there is nothing to fix there.

   **6b. Page states and stat tiles (behaviour fixes).** *(Shipped, #1753.)*
   - `EmptyState` is replaced by the shared `PageState` at every site (50 production sites plus the local loaders); `components/ui/EmptyState.tsx` and its test are deleted, with the useful assertions ported to `test/shared-ui/PageState.test.tsx`. Every list page now reads `pageStateKind({ isLoading, isError, isEmpty })`, so a failed query shows `kind="error"` with a retry and never "empty" or an all-clear. A failed refetch with data still on screen keeps the data and shows an inline error. Access-denied pages are `locked`; not-found pages are `empty` with explicit copy, separated from the error branch.
   - `lib/api.ts`: a first-attempt 5xx on a GET now rejects (it used to resolve with the `{ success: false }` envelope, so every `res.data ?? []` hook read a server failure as an empty list). Mutations and 4xx responses still resolve with the envelope.
   - `PageLoader`, the local `TabLoading` copies, `LoadingPanel` and the inline "Loading…" divs are `PageState kind="loading"`. `TableLoader` and `CardGridLoader` stay.
   - Simple `StatCard` is replaced by the shared `StatTile` (`sublabel` is `sub`, `accentColor` is `accent`; the left accent stripe is dropped). A tile whose query has not settled passes `value={null}` (and `error` on failure) instead of `'—'`/`'...'`/`0`. The ops `StatTile`, `StatCard` and `GlowNumber` are deleted, and the local `StatCard`/`StatTile` copies in AttributionBacklog, AdminAudit and spam-trap `InsightsTabs` use the shared one.
   - `DetailStatCard` is kept as `BreakdownCard` (`design-system/components/BreakdownCard.tsx`) on the shared `Card`, with the `.detail-stat-*` container-query CSS unchanged.
   - Not migrated (follow-ups): the `features/admin/metrics/*` `Stat` copies, the Feeds/Threats `Stat`, `BigStat` and `StatMiniCard`, and OverviewV4's `KpiTile` (deleted in PR7a).

   **6c. Cards and tables.** *(Shipped, #1754.)*
   - Shared `Card` is now the ops glass card: `base | elevated | active | critical` variants (`glow` kept as an alias of `active`), `accent` (with `active`, via `color-mix` so hex and `var()` both work), and `padding` taking `none | sm | md | lg` (0 / 12 / 20 / 24px), a number (px) or raw CSS. The default is `md` (20px), the old ops default, so the ~296 ops sites are drop-in. Tenant had no call sites on the shared `Card` (its `<Card>` in `MonitoringRules` is a local component), so the default does not change tenant; the shared `FilterBar` is the one internal consumer and now passes `padding="10px 16px"` explicitly. Compositions with `CardHeader`/`CardContent`/`CardFooter` (which carry their own padding) pass `padding="none"`. No ops site passed `radius`, so it was not added.
   - The dead `hover` prop is removed by codemod (138 sites: 132 `hover={false}`, 4 bare `hover`, 2 `hover={!isSelected}`); the ops `Card.tsx` and its test are deleted (assertions ported to `test/shared-ui/Card.test.tsx`). The `padding="lg|md"` sites in `BrandDetail` now resolve through the token path and render valid CSS (`lg` is 24px; the invalid value used to fall through to nothing).
   - Tables: all 17 raw `<table>` tags (15 files) and the ops `ui/Table` users (NotificationCenter, PlatformUsers, ScanLeads, Leads, DarkWeb) use the shared `Table`/`Th`/`Td`; the ops `ui/Table.tsx` is deleted. AttributionBacklog and AdminAudit stay hand-built (each row has an inline expansion row that `DataTable` cannot render). Their rows keep native `<tr>` semantics (a `role="button"` row would hide the nested Attribute/Dismiss buttons and the resource link from assistive tech); keyboard activation is a real control in the first cell, an `aria-expanded`/`aria-controls` disclosure button in AdminAudit and a name button in AttributionBacklog (its Attribute button is the picker disclosure). Row click stays as a mouse convenience. Shared `Card` also has a `flat` variant (no shadow, rims or blur) for inset panels such as the audit expansion row. Sorting is unchanged.
   - Review fixes: aggregate failures are errors, not empty/zero, on Home StatGrid, Threats (panels, tiles, inflow chart) and the Brands Intel tab; campaign pages and SpamTrap panels use `PageState` with retry (a 500 is no longer "not found"); shared `PageState` retry buttons are named `Try again: <title>`, inline errors are `role="status"` (pass `assertive` when no data is on screen), `StatTile` exposes its state name via `role="group"` and dims the glow while loading or failed, and the BreakdownCard label and HeroCards pills use theme-aware tokens.

   Known API differences PR6 must handle (6a status in brackets):
   - `PageHeader`: the ops `back.to` (router path) is not in the kit, which has no router import. [6a: handled by the ops adapter.]
   - `EmptyState` to `PageState` is not drop-in. It needs an adapter or codemod for `message`, `subtitle` and `variant`; `kind` is required (`title`/`description` replace the text props). [6b: migrated directly at every site; no adapter was left behind.]
   - `Sparkline` renders a flat placeholder line for fewer than 2 points instead of returning `null`. [6a: callers that guard keep their guards; SpamTrap and InsightsTabs keep their `> 1` point guards, so they hide a single-point sparkline rather than showing the placeholder.]
   - `Avatar` is `aria-hidden` unless `label` is set. [6a: `label` passed where no name is shown beside the avatar.]
   - `StatTile` changes visually from the ops version. [6b: done; `null` now means loading, so sites pass `null` rather than `'—'`.]
   - Console panes need `WorkspaceEmbedProvider`, otherwise `PageHeader` renders a second `<h1>`. [6a]
   - Tenant severity colours for "high" are inconsistent (amber vs orange); pick one when the tenant moves onto `Badge`. [Phase 2]
   - `Badge` radius differs from the tenant's 4px chips. [Phase 2]
   - Follow-up, not migrated in 6a: `FeedCardSparkline` (Feeds) and `CardHealthChart` (Agents) are multi-series (pulls/runs plus ingested/outputs and error overlays on a shared y-scale), so they are not duplicates of the single-series kit `Sparkline` and stay as they were. Moving them needs a multi-series sparkline added to the kit later.
7. **Home rebuild.** Ships as two PRs, one at a time: 7a (Home, frontend) then 7b (Navigator warm list, backend). The target is the review's mockup A: a ranked "needs you now" queue, the daily briefing, a platform pulse, a threat tempo band and a one-line digest, with `InstallAppBanner` kept.

   **7a. Home rebuild (`packages/averrow-ops`).** *(This PR.)*
   - Layout, top to bottom: hero ("N items need you" plus LIVE), `InstallAppBanner`, threat tempo band, "Needs you now" queue, daily briefing beside the platform pulse, digest row. No new endpoints, dependencies or AI calls.
   - **Queue.** Sources are existing hooks, each given an `enabled` option so a role that may not call an endpoint never sends the request: alerts awaiting triage, critical intel events (absorbs `StatusRow`), open incidents (super_admin), agent approvals (super_admin), takedowns in draft/requested (`manage_takedowns`), tripped or erroring agents, feeds at risk (admin and above), attribution backlog (admin and above), brand candidates (admin and above). `lib/home-queue.ts` ranks by severity weight x recency decay x log-damped reach and shows the top 5 ("N of M open"). A failed or stale source adds a "Couldn't check {source}" row with retry; the clear state needs every enabled source to have succeeded with nothing.
   - **Tempo band.** The current hourly rate (last completed hour) against the 7-day hourly mean, from the same `/api/threats/inflow?window=24h|7d` queries ThreatInflowChart uses (hook extracted to `features/threats/useThreatInflow.ts`, same query keys, so the cache is shared with Threats). Surge chip at >= 1.5x baseline, "quiet" below 0.5x.
   - **Briefing.** One shell (`features/briefing/Briefing.tsx`), two bodies. Home uses `source="intelligence"` (the latest Observer insight, with entity source chips). The `/admin` Briefing tab uses `source="ops"` and now also renders `geopoliticalCampaigns`, `marketingVisibility` and the new-capability counts; its type mirrors the worker's `ComprehensiveBriefing`. `lib/briefing-text.ts` replaces the three duplicate markdown/title helpers (Home DailyBriefing, `ExecutiveSummary`, Trends `splitBriefing`). The `IntelligenceBriefing` type drift (`agent_name`/`output_type` vs the API's `type`) is fixed.
   - **Deleted:** the ten Home sections (`StatGrid`, `ModuleHub`, `BrandMovers`, `ProviderMovers`, `LatestIntel`, `IntelHotlist`, `LiveActivity`, `ThreatPulse`, `StatusRow`, `DailyBriefing`), `components/DailyBriefingWidget`, the local `KpiTile` and the `.kpi-v4` CSS, and the hooks `useProviderMovers`, `useIntelHotlist`, `useLatestInsights` and `useDailyBriefing`. `useBrandMovers` (Brands) and `useCriticalBanner` (the queue) stay.
   - **Role fixes:** the hero's incident query moved into the queue (super_admin only); the Agents page `PendingApprovalsBanner` is gated to super_admin.
   - **Backend follow-ups (not in this PR).** These endpoints have no client after 7a, so a backend PR can remove them and their `docs/API_REFERENCE.md` entries: `GET /api/providers/movers`, `GET /api/intel/hotlist`, `GET /api/insights/latest`. **Done in PR-D (2026-10)**, together with the also-unused `/api/providers/worst` + `/api/providers/improving`; the two unique pieces were kept as `/api/providers/v2?sort=cooling` and `GET /api/intel/multi-feed-consensus`.
   - **Owner decision (follow-up):** the provider movers, intel hotlist and latest intel views are no longer reachable in ops. Their Home sections are deleted and the tabs they would link to do not show that content, so the digest only keeps chips whose destination shows what they name (Brand movers, All briefings, Threats, Observatory). Decide whether to rebuild any of them elsewhere or retire them for good.
   - Review fixes in this PR: the Brands Prospects tab and teaser are admin+ (`/api/admin/brand-candidates` is `requireAdmin`); the Console hides its incidents KPIs and tab for non-super_admins (a deep link shows a locked state); the tempo baseline ignores zero-padded and gap buckets; `react-countup` and the dead `.ql-*` CSS are removed; the ops briefing body is lazy-loaded.

   **7b. Navigator warm list (`packages/averrow-worker`).** *(Next.)* Fix the Observatory `source_feed` cache-key mismatch, retire the warms with no live consumer, re-target the rest to what the UI sends, correct the stale "24 endpoints" docs, and add a test that pins the warm list.

Phase 2 moves the tenant app onto the kit and adds the `ModuleLanding` template, the 6-item navigation, a mobile shell and tokens. Phase 3 adds new capabilities: React 19.3 View Transitions, actor dossier pages, Ask Averrow and the MapLibre 5 globe.
