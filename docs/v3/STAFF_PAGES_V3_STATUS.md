# Staff /v2 Pages — V3 Rebuild Status

Tracks the v3 redesigns of `/v2/*` staff-back-office pages. Distinct
from `V3_BUILD_STATUS.md`, which covers the customer-tenant build at
`/tenant/*`. The two tracks share design tokens but evolve
independently — staff pages are operator-facing; tenant pages are
customer-facing.

Each row is a top-level sidebar destination. **Status** is one of:
- ✅ **V3 canonical** — v2 decommissioned, /path serves v3 directly
- 🔄 **V3 dual-route** — `/path-v3` lives alongside `/path` with a
  toggle pill; v2 stays until v3 is validated
- ⏳ **V3 planned** — audit complete, scope agreed, not yet built
- ❌ **No v3 plan yet**

## Status

| Page         | Status           | Notes |
|---|---|---|
| Brands       | ✅ V3 canonical  | PR1192 scaffold → PRs 1-14 brands Phase 2 → PR1208 v2 decommission. Intel + All Brands + Prospects tabs. Full sectioned IA (Defense / Pressure / Composition / Posture) + Brand-Health × Exposure scoring + CT candidate review + 100K Tranco import. |
| Threats      | ✅ V3 canonical  | PRs 1220/1221/1222. Hero strip + Coordination (multi-brand patterns) + Evolving (WoW surging) + Top-of-pile leaderboards + multi-dimension slicers + slice-summary strip. Tells the analyst what's happening, not just a list. |
| Agents       | ✅ V3 canonical  | Decommissioned in PR1189. v3 Grid + Network view with zoom/pan/fullscreen. PR1217 added pending-approval banner on /agents. |
| Feeds        | ✅ V3 canonical  | Decommissioned in PR1189. v3 page with failure-pattern detection + history. |
| Metrics      | ✅ V3 canonical  | Decommissioned in PR1189. 6-tab Metrics surface (Summary / Pipelines / D1 Budget / AI Spend / Geo Coverage / Feed Failures). |
| Observatory  | 🔄 V3 dual-route | `/observatory` (v2 legacy) ↔ `/observatory-v3` (GPU TripsLayer). v3 ships as default in the toggle hook. Decommission pending operator dogfood validation. |
| Home         | ❌ No v3 plan    | Three-zone home layout designed in `.claude/plans/v3.md` §9.4 but not built. RoleAwareHome routes brand-admins to `BrandAdminDashboard` today. |
| Providers    | ❌ No v3 plan    | List + detail untouched. |
| Campaigns    | ❌ No v3 plan    | Geopolitical campaign dashboard + standard campaign view. |
| Threat Actors | ❌ No v3 plan   | Per `.claude/plans/v3.md` §9.6 the goldstandard is ~80% done; would add Pivot map tab + row-level actions. |
| Intelligence (Trends) | ❌ No v3 plan | `/trends` is the briefing archive. v3 surfaces it as a primary destination. |
| Apps         | ❌ No v3 plan    | App-store impersonation list. Already module-shaped via `app_store_listings`. |
| Dark Web     | ❌ No v3 plan    | Dark-web mentions list. Already module-shaped via `dark_web_mentions`. |
| Incidents    | ❌ No v3 plan    | Admin incidents list + detail. |
| Takedowns    | ❌ No v3 plan    | Admin takedowns queue. Sparrow Phase G/H wired (auto-submit + follow-up). |
| Alerts       | ❌ No v3 plan    | Tier 1/1.5/1.6/3 triage queue. Already has AI judge (Tier 3) and rule-based dismissal. |
| Spam Trap    | ❌ No v3 plan    | Honeypot-captured email triage. |
| Leads        | ❌ No v3 plan    | Sales leads + scan leads tabs. |
| Customers    | ❌ No v3 plan    | Renamed from Organizations during v3 D Stripe sprint 1. |
| Pricing      | ❌ No v3 plan    | `/admin/pricing` global edit page (Stripe S3b). |
| Audit Log    | ❌ No v3 plan    | `/admin/audit`. |
| Push Config  | ❌ No v3 plan    | `/admin/push`. |
| Team         | ❌ No v3 plan    | `/admin/users` org membership. |

## What "v3" means for a staff page

A page graduates to **V3 canonical** when:
1. The v2 source files are deleted
2. The route `/page` serves the v3 component directly (no toggle)
3. The IA reflects an analyst question, not a database table
4. Platform-consistency boxes ticked: `PanelHeader` / `DeepCard` /
   accent gradients / `--sev-*` tokens / sectioned narrative / no
   bare COUNT(*) reads (cubes + `cachedValue` per CLAUDE.md)
5. The brand surface pattern is borrowed where applicable — favicons,
   leaderboards-with-magnitude-bars, click-through to cross-cutting
   destinations (`/brands/:id`, `/threat-actors/:id`, `/providers/:id`,
   `/campaigns/:id`)

When a page is **V3 dual-route**, the `useVersionToggle` hook still
has its surface key. When **V3 canonical**, the surface key is
removed from the hook (see `design-system/hooks/useVersionToggle.ts`).
