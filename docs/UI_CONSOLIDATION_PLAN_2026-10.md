# UI Consolidation Plan (2026-10)

Source review: the "Averrow Interface Review" (Oct 2026). Phase 0 shipped in #1736. It deleted dead UI files, the preview harness, unused deps, the `?cards=classic` switch and MilestoneBanner. It also made two route aliases redirect and stopped load failures being hidden as an all-clear.

Phase 1 consolidates the ops console onto one shell and one component kit. PRs ship one at a time on a single branch, in the order below. Each PR goes through the CLAUDE.md §1A pipeline: build, test, `qa-verifier`, then review.

## Owner decisions (2026-10-02)

| Topic | Decision |
|---|---|
| Brand admins in ops (`isBrandAdmin`) | Get the normal Overview. Delete `BrandAdminDashboard` and the classic sidebar's org label. |
| Unused frozen components (`ThreatMap`, `ExposureGauge`, `Sparkline`, `ActivitySparkline`) | Delete them and remove them from the CLAUDE.md frozen list. `PortfolioHealthCard` and `EventTicker` stay frozen. |
| PWA prompts | Re-mount them. `InstallAppBanner` goes on Overview, `InstallAppCard` on Profile, and `PasskeysCard` wherever the shared Profile page expects it. |
| Worker legacy `/admin/organizations` redirect | Point it at `/v2/admin/customers`, matching the SPA. |
| Font pair | Plus Jakarta Sans and JetBrains Mono everywhere, including the shared login. FarmTrack must adopt the same pair to stay identical (SHARED_LOGIN_SPEC). |
| Daily briefing | Use one briefing component with two data sources. Home shows the intelligence briefing; the `/admin` Briefing tab shows the ops briefing. |
| Phone navigation in ops | The v4 slide-out menu only, in both orientations. The classic bottom tab bar is not ported. (Revised the same day; the first answer was to port it.) |

## Phase 1 PRs

1. **Foundations.** Add the font pair, a radius scale, motion tokens and a global reduced-motion rule to `packages/shared/src/theme/tokens.css`, and wire both apps to them.
2. **v4 parity.** Add these to `ShellV4.tsx`:
   - NotificationBell and the avatar menu
   - PlatformAlertBanner
   - the theme toggle
   - the open-alert badge via `useOpenAlertCount`
   - a check that the slide-out menu works on phones in both orientations

   Classic is not switched off yet.
3. **Switch to v4.** Make v4 the only shell and delete the classic one: Shell, Sidebar, TopBar, MobileNav, the drawer, DeepBackground, PageTransition, `useShellVersion`, the "Try v4" pill, `HomeUnified` and `framer-motion`. Also delete `BrandAdminDashboard` and the unused frozen components.
4. **Routes.** Turn the 18 standalone routes into `?tab=` redirects that keep query strings. Rewrite in-app and ⌘K links. Fix the worker's links, including the broken `/admin/feeds` and `/admin/agents` and the legacy `/admin/organizations` redirect. Keep one incidents list.
5. **Shared kit.** Add these to `@averrow/shared/ui`, with one barrel:
   - Badge (severity, status and classification)
   - StatTile
   - PageState
   - Table
   - Tabs
   - FilterBar
   - PageHeader
   - Sparkline
   - Avatar
6. **Collapse duplicates in ops.**
   - Stat tiles become StatTile.
   - Severity and status badges become Badge.
   - DeepCard becomes Card.
   - Raw tables become Table, here or in a follow-up PR.
7. **Home rebuild.** Build a ranked "needs you now" queue from existing hooks, with no new endpoint. Add digest links, a platform pulse, a tempo band and the merged briefing component. Re-mount `InstallAppBanner`. Delete the sections the digest replaces. Then retire any Navigator cache warmers for endpoints nothing reads any more.

Phase 2 moves the tenant app onto the kit and adds the `ModuleLanding` template, the 6-item navigation, a mobile shell and tokens. Phase 3 adds new capabilities: React 19.3 View Transitions, actor dossier pages, Ask Averrow and the MapLibre 5 globe.
