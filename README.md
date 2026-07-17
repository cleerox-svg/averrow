# Averrow

**Brand Protection and Threat Actor Intelligence Platform**

Averrow monitors the internet for brand impersonation, phishing infrastructure, email security weaknesses, and domain abuse — then correlates those signals into threat actor profiles. The goal isn't just to find attacks. It's to identify who is running them, how they operate, and where they'll move next.

> Built by [LRX Enterprises Inc.](https://averrow.com) — Canadian-incorporated, globally deployed

## What It Does

- **Threat actor profiling** — Correlate shared infrastructure, registrars, and hosting patterns into named operators (via the NEXUS clustering agent)
- **Brand exposure scoring** — Composite risk from email posture, active threats, lookalike domains, and social impersonation
- **Email security grading** — Outside-in SPF / DKIM / DMARC analysis with A+ through F report cards
- **Lookalike domain detection** — Permutation generation + DNS monitoring for typosquats, homoglyphs, and combosquats
- **Threat feed integration** — 38 feeds including Certificate Transparency logs, PhishTank, URLhaus, OpenPhish, ThreatFox, Cloudflare Radar, NRD feeds, CISA KEV, Spamhaus DBL/DROP, SURBL, Emerging Threats, and more
- **OLAP analytics cubes** — Pre-aggregated hourly rollups by country, provider, and brand for sub-50ms dashboard queries
- **Real-time event stream** — WebSocket push via Durable Objects for live threat notifications
- **AI-generated intelligence** — Claude Haiku classifies and attributes; Claude Sonnet writes narrative briefings
- **Free public brand scan** — One-click exposure report at [averrow.com](https://averrow.com)

## Repository Layout

```
averrow/                             ← repo: cleerox-svg/averrow (renamed from trust-radar 2026-07-17)
├── packages/
│   ├── averrow-worker/              ← Averrow Worker (backend)
│   ├── averrow-ops/                 ← Staff back-office React SPA (rebadged from averrow-ui; serves /v2/*)
│   ├── averrow-tenant/              ← Customer-facing React SPA (serves /tenant/*)
│   └── averrow-mcp/                 ← MCP server exposing platform diagnostics to Claude Code
├── docs/                            ← Platform documentation
├── migrations/                      ← Legacy (per-package migrations live inside packages/)
├── prototypes/                      ← HTML design prototypes
└── scripts/                         ← Diagnostics + operational scripts
```

## Architecture

Averrow runs entirely on Cloudflare's edge. There is no traditional backend server.

| Component | Technology |
|---|---|
| Compute | Cloudflare Workers (TypeScript) |
| Database | Cloudflare D1 (SQLite at the edge, read replicas via Sessions API) |
| Cache | Cloudflare KV (IOC dedup, rate limiting, page-load caching) |
| Real-time | Durable Objects — `ThreatPushHub` (WebSocket), `CertStreamMonitor` |
| Workflows | Cloudflare Workflows — Cartographer backfill + NEXUS clustering (durable, no CPU ceiling) |
| AI | Claude Haiku + Sonnet via Cloudflare AI Gateway |
| DNS | Cloudflare DoH |
| Frontend | React + Vite + TanStack Router + Tailwind CSS |
| Monorepo | pnpm workspaces + Turborepo |
| CI/CD | Cloudflare Workers Git integration (auto-deploy on push to `master`) |

## AI Agents

35 agents coordinate through `agent_runs` / `agent_events` tables. SQL does correlation; AI does narrative.

| Agent | Role | Cadence |
|---|---|---|
| **Navigator** | DNS resolution, OLAP cube refresh, KV cache pre-warming (24 endpoints) | Every 5 min |
| **Flight Control** | Autonomous supervisor — load, AI budget, backlog throttle | Hourly (inside orchestrator) |
| **Sentinel** | Threat classification + homoglyph detection | After feed ingest, if new records |
| **Cartographer** | Geo / ASN / hosting enrichment (runs as a Workflow) | After Sentinel, or as fallback |
| **Analyst** | AI brand attribution for unlinked threats | Hourly |
| **NEXUS** | Infrastructure clustering and campaign detection (Workflow) | Every 4 hours |
| **Strategist** | Campaign correlation from shared infrastructure | Every 6 hours |
| **Sparrow** | Automated takedown request generation | Every 6 hours |
| **Seed Strategist** | Spam trap seeding strategy | Daily (06:00) |
| **Observer** | Daily intelligence briefings + trend analysis | Daily (00:00, 06:00) |
| **Narrator** | Natural-language briefing rendering | Daily (06:00) |
| **Pathfinder** | Sales intelligence + lead generation | Weekly (KV-throttled) |
| **Curator** | Library curation for the threat-actor corpus | On-demand |
| **Watchdog** | Stale-run + enrichment-stall detection | Continuous |
| **Cube Healer** | 30-day retroactive cube rebuild | Every 6 hours |
| **Recon** (Auto-Seeder) | Bulk-plants spam-trap addresses into harvester channels with per-location yield tracking | Weekly (Sun 05:07 UTC, dispatched from hourly orchestrator) |

## Cron Triggers

From `packages/averrow-worker/wrangler.toml`:

| Schedule | Handler | Purpose |
|---|---|---|
| `*/5 * * * *` | Navigator | DNS backfill, cube refresh, cache warming |
| `7 * * * *` | Orchestrator | Feed ingestion, agent mesh dispatch, Workflow triggers, **weekly Recon dispatch (Sun 05:07)** |
| `12 */6 * * *` | Cube Healer | 30-day bulk cube rebuild (drift remediation) |

The orchestrator's `:07` offset (rather than `:00`) exists to stop Navigator, cube-healer, and the hourly mesh from colliding on the D1 writer. When changing cron schedules, audit minute-based gates in the handler — see the cron-audit rule in `CLAUDE.md` §6.

## Database

- Primary: `trust-radar-v2` (D1, SQLite at the edge) — internal name kept
- Audit: `trust-radar-v2-audit`
- **95 migrations** in `packages/averrow-worker/migrations/`
- Key tables: `threats`, `brands`, `hosting_providers`, `campaigns`, `infrastructure_clusters`, `agent_runs`, `agent_events`, `feed_configs`, `feed_status`, OLAP cubes (`threat_cube_geo`, `threat_cube_provider`, `threat_cube_brand`)

## Development

```bash
pnpm install
pnpm dev            # Run all packages in parallel (wrangler dev + vite)
pnpm typecheck      # Type check every package
pnpm lint           # Lint every package

# Single package
pnpm --filter averrow-worker dev
pnpm --filter averrow-ops build

# Deploy manually (normally auto-deploys on push to master)
pnpm deploy:radar
```

### Migrations

```bash
cd packages/averrow-worker

# Local
npx wrangler d1 execute trust-radar-v2 --local --file=migrations/NNNN_name.sql

# Production (remote)
npx wrangler d1 execute trust-radar-v2 --remote --file=migrations/NNNN_name.sql
```

### Deploy

Automated via Cloudflare Workers Git integration. Push to `master` → Cloudflare builds and deploys the Worker automatically. Path-filtering keeps it scoped to the package that changed.

## Domains

| Domain | Purpose |
|---|---|
| `averrow.com` | Production (primary) |
| `averrow.ca` | Canadian market |
| `trustradar.ca` / `lrxradar.com` | Legacy — redirect to `averrow.com` |
| `staging.averrow.com` | Staging |

## Pricing

| Tier | Price | Brands |
|---|---|---|
| Free | — | One-time exposure report |
| Professional | $1,499/mo | 1 brand |
| Business | $3,999/mo | Up to 10 brands |
| Enterprise | Custom | Custom |

## Documentation

- [API Reference](docs/API_REFERENCE.md)
- [Architecture](docs/ARCHITECTURE.md)
- [AI Agents](docs/AI_AGENTS.md)
- [Threat Feeds](docs/THREAT_FEEDS.md)
- [Email Security Engine](docs/EMAIL_SECURITY_ENGINE.md)
- [Social Monitoring](docs/SOCIAL_MONITORING.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Standing instructions for Claude Code sessions](CLAUDE.md)

## Security

Report security vulnerabilities to [security@averrow.com](mailto:security@averrow.com).

## License

Proprietary — LRX Enterprises Inc. All rights reserved.
