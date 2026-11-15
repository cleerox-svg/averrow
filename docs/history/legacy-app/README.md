# Averrow legacy (pre-React) app, historical screenshots

Averrow's first interface was a vanilla-JavaScript single-page app (`app.js`, `styles.css`, `dashboard.html`) served directly by the Worker, plus a server-rendered marketing homepage (kept at `/legacy`). It was replaced by the React staff app (first at `/v2`, now `/ops`) and was deleted from the repository on 2026-11-15 at the owner's request. These screenshots show where the platform started: a dark "threat observatory" console with a deck.gl world map, brand / hosting-provider / campaign intelligence views, AI agent operations, an admin console and a tenant (customer) dashboard.

Captured 2026-11-15, just before deletion, by rendering the original files in headless Chromium at 1440x900 (device scale factor 2 unless noted).

**All data shown is generated mock data** (generic names such as "Example Corp", RFC 5737 / `.example` / `.test` addresses). No real customers, people, or production data appear. The UI chrome, layout and styling are the original code, unmodified.

| File | What it shows |
|---|---|
| `01-observatory.png` | Observatory: live deck.gl world map with attack-flow arcs, threat nodes, stat bar and the top brands / providers sidebar (the default landing view) |
| `02-brands.png` | Brands Intelligence: top-targeted brand cards with sparklines and email-security grades |
| `03-brand-detail.png` | Brand detail: trust score ring, AI threat analysis, safe domains and social profile panels |
| `04-providers.png` | Infrastructure Intelligence: worst hosting providers with reputation and response-time gauges |
| `05-campaign-detail.png` | Campaign detail: Strategist assessment and the domain -> IP -> provider infrastructure graph |
| `06-agents.png` | AI Agent Operations: the agent roster (Sentinel, ASTRA, Navigator, Strategist, Observer, Blackbox, Pathfinder, Sparrow) with 24h activity bars |
| `07-trends.png` | Trend Explorer: threat volume chart with dimension and period controls |
| `08-admin-overview.png` | Admin System Overview (full page, scale 1): users, feeds, leads, agent health, email-security coverage, feed ingestion, system events |
| `09-tenant-dashboard.png` | Tenant (customer) dashboard: brand health rings, 7-day threat trend, recent alerts |
| `10-login.png` | Login screen (cropped): animated Averrow mark, "Threat Interceptor", Google sign-in |
| `11-legacy-home.png` | The original server-rendered marketing homepage (`/legacy`), hero and live intercept feed |
| `12-legacy-home-agents.png` | Same homepage, "Agent Squadron" section |

## Reading the code

The last commit that still contains the legacy app (`packages/averrow-worker/public/app.js`, `styles.css`, `dashboard.html`, `manifest.json` and `packages/averrow-worker/src/templates/homepage.ts`) is `b9effa3dc5eb5e814239360d793976b013820ea2`. Browse it with `git show b9effa3:packages/averrow-worker/public/app.js` or `git checkout b9effa3`.
