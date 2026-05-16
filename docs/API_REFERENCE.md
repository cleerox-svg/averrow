# API Reference

Complete reference for the Averrow API. All authenticated endpoints require a `Bearer` token in the `Authorization` header. Base URL: `https://acerrow.com`

## Authentication

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/auth/login` | — | Initiate Google OAuth login |
| GET | `/api/auth/invite` | — | Accept invite via token |
| GET | `/api/auth/callback` | — | OAuth callback handler |
| POST | `/api/auth/refresh` | Cookie | Refresh access token |
| POST | `/api/auth/logout` | Cookie | Logout and clear session |
| GET | `/api/auth/me` | User | Get current user info |
| GET | `/api/invites/:token` | — | Validate an invite token before acceptance |
| GET | `/invite` | — | Invite landing page (HTML) |

## Public Endpoints (No Auth)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| GET | `/api/heatmap` | Public threat heatmap data |
| GET | `/api/observatory/nodes` | Observatory graph nodes |
| GET | `/api/observatory/arcs` | Observatory graph arcs |
| GET | `/api/observatory/live` | Live observatory feed |
| GET | `/api/observatory/brand-arcs` | Brand-specific arcs |
| GET | `/api/observatory/stats` | Observatory statistics |
| GET | `/api/observatory/operations` | Observatory operations (active NEXUS clusters feed) |
| POST | `/api/scan/public` | Public domain scan (rate-limited) |
| POST | `/api/scan/report` | Generate brand exposure report |
| POST | `/api/brand-scan/public` | Public brand exposure scan |
| GET | `/api/brand-scan/public/:id` | Get public scan results |
| GET | `/api/stats/public` | Public platform statistics |
| POST | `/api/contact` | Contact form submission |
| GET | `/status` | Public platform status page (HTML). Server-rendered 30-day uptime rollup with per-day bars per category (Feeds / Agents / Processing). Inline script polls `/api/v1/public/platform-status` every 60s for live updates. |
| GET | `/status/incidents` | Public incident archive (HTML). Lists every public incident, newest first, grouped by month. Linked from the recent-incidents section on `/status`. Same visibility gate as the rest. |
| GET | `/status/feed.xml` | RSS 2.0 feed of public incidents (Content-Type `application/rss+xml`). Most recent 50, newest first by latest activity. Each item links to the `/status/incidents/:id` permalink. Cached 5 min. |
| GET | `/status/incidents/:id` | Public incident permalink (HTML). Mirrors the `/api/v1/public/incidents` visibility gate — only renders when the incident's `visibility='public'` AND `public_title` is set. Returns 404 with the same shell otherwise (no information leak about whether the id exists). Linked from each card on `/status`. |

## Public API v1

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/public/stats` | Platform statistics |
| GET | `/api/v1/public/geo` | Geographic threat distribution |
| GET | `/api/v1/public/feeds` | Feed status overview |
| POST | `/api/v1/public/assess` | Domain assessment |
| POST | `/api/v1/public/leads` | Lead capture |
| POST | `/api/v1/public/monitor` | Monitor request |
| GET | `/api/v1/public/email-security/:domain` | Public email security check |
| GET | `/api/v1/public/platform-status` | Platform uptime rollup (no auth) — feeds Home banner + Phase 3 public status page. Same payload as `/api/admin/platform-status`. KV-cached 60s. |
| GET | `/api/v1/public/milestones/latest` | Most recently fired platform milestone (e.g. "1,000,000 threats ingested"). Drives the Home celebration banner. Public, polled every 5 min by clients. |
| GET | `/api/v1/public/incidents` | Public incidents feed for `/status`. Returns only rows with `visibility='public'` AND `public_title` set. Stripped to `id`, `title`, `details`, `status`, `severity`, `affected_components`, `started_at`, `resolved_at`, `updates[]`. Internal title/description never exposed. |

## Dashboard

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/dashboard/overview` | User | Dashboard overview stats |
| GET | `/api/dashboard/top-brands` | User | Top targeted brands |
| GET | `/api/dashboard/providers` | User | Provider summary |
| GET | `/api/dashboard/stats` | User | Dashboard statistics |
| GET | `/api/dashboard/sources` | User | Threat source breakdown |
| GET | `/api/dashboard/trend` | User | Threat trend data |
| GET | `/api/dashboard/brand-admin` | User | Brand-scoped admin dashboard |

## Brands

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/brands` | User | List all brands |
| GET | `/api/brands/top-targeted` | User | Top targeted brands (with trends) |
| GET | `/api/brands/monitored` | User | Monitored brands |
| GET | `/api/brands/stats` | User | Brand aggregate statistics |
| GET | `/api/brands/movers` | User | 7-day movers (rising / falling by active threat delta) |
| POST | `/api/brands/monitor` | User | Add brand to monitoring |
| DELETE | `/api/brands/monitor/:id` | User | Remove brand from monitoring |
| GET | `/api/brands/:id` | User | Get brand detail |
| GET | `/api/brands/:id/threats` | User | Brand's active threats |
| GET | `/api/brands/:id/threats/locations` | User | Threat geo locations |
| GET | `/api/brands/:id/threats/timeline` | User | Threat timeline |
| GET | `/api/brands/:id/providers` | User | Hosting providers for brand threats |
| GET | `/api/brands/:id/campaigns` | User | Campaigns targeting brand |
| GET | `/api/brands/:id/analysis` | User | Get AI brand analysis |
| POST | `/api/brands/:id/analysis` | User | Trigger AI brand analysis |
| POST | `/api/brands/:id/deep-scan` | User | Trigger deep scan |
| GET | `/api/brands/:id/report` | User | Generate brand report |
| POST | `/api/brands/:id/clean-false-positives` | User | Clean false positives |
| GET | `/api/brands/:id/safe-domains` | User | List safe/owned domains |
| POST | `/api/brands/:id/safe-domains` | User | Add safe domain |
| POST | `/api/brands/:id/safe-domains/bulk` | User | Bulk add safe domains |
| DELETE | `/api/brands/:id/safe-domains/:domainId` | User | Remove safe domain |
| GET | `/api/brands/:id/social-config` | User | Get brand social-monitoring config |
| PATCH | `/api/brands/:id/social-config` | User | Update brand social-monitoring config |
| GET | `/api/brands/:id/social-profiles` | User | List discovered social profiles for the brand |
| PATCH | `/api/brands/:id/social-profiles/:profileId` | User | Classify / update a discovered social profile |
| POST | `/api/brands/:id/discover-social` | User | Trigger social-link discovery for the brand |
| POST | `/api/brands/:id/social-profiles/:profileId/assess` | User | Re-assess a social profile |
| POST | `/api/brands/:id/compute-score` | User | Recompute brand threat score |

## Brand Profiles (DEPRECATED)

> These endpoints support the social monitoring system. They will be replaced when social data is unified with the core brand model.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/brand-profiles` | User | Create brand profile |
| GET | `/api/brand-profiles` | User | List brand profiles |
| GET | `/api/brand-profiles/:id` | User | Get brand profile |
| PATCH | `/api/brand-profiles/:id` | User | Update brand profile |
| DELETE | `/api/brand-profiles/:id` | User | Delete brand profile |
| POST | `/api/brand-profiles/:id/handles` | User | Update official handles |
| GET | `/api/brand-profiles/:id/handles` | User | Get official handles |

## Social Monitoring

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/social/monitor` | User | Social monitoring overview (all brands) |
| GET | `/api/social/monitor/:brandId` | User | Brand-specific monitoring results |
| GET | `/api/social/alerts` | User | Active impersonation alerts |
| POST | `/api/social/scan/:brandId` | User | Trigger immediate social scan |

## Threats

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/threats` | User | List threats (filterable) |
| GET | `/api/threats/stats` | User | Threat statistics |
| GET | `/api/threats/recent` | User | Recent threats |
| GET | `/api/threats/correlations` | User | Threat correlations |
| GET | `/api/threats/geo-clusters` | User | Geographic clusters |
| GET | `/api/threats/attack-flows` | User | Attack flow visualization |
| GET | `/api/threats/heatmap` | User | Paginated, KV-cached threat heatmap data |
| GET | `/api/threats/:id` | User | Get threat detail |
| PATCH | `/api/threats/:id` | User | Update threat status |
| POST | `/api/threats/enrich-geo` | Admin | Enrich threats with geo data |
| POST | `/api/threats/enrich-all` | Admin | Full enrichment run |

## Feeds

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/feeds` | User | List threat feeds |
| GET | `/api/feeds/stats` | User | Feed statistics |
| GET | `/api/feeds/jobs` | User | Recent feed jobs |
| GET | `/api/feeds/quota` | User | API quota status |
| GET | `/api/feeds/:id` | User | Get feed detail |
| PATCH | `/api/feeds/:id` | Admin | Update feed config |
| POST | `/api/feeds/:id/trigger` | Admin | Trigger single feed |
| POST | `/api/feeds/:id/reset` | Admin | Reset feed state |
| POST | `/api/feeds/:id/unpause` | Admin | Clear auto-pause: enabled=1, paused_reason=NULL, consecutive_failures=0, health_status='healthy' |
| POST | `/api/feeds/trigger-all` | Admin | Trigger all feeds |
| POST | `/api/feeds/trigger-tier/:tier` | Admin | Trigger feeds by tier |
| GET | `/api/feeds/overview` | User | Aggregated feed-health overview (tier summary, last-run freshness) |
| GET | `/api/feeds/aggregate-stats` | User | Aggregate statistics across all feeds |
| GET | `/api/feeds/:id/history` | User | Per-feed run / pull history |

## AI Agents

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/agents` | User | List all agents |
| GET | `/api/agents/stats` | User | Agent statistics |
| GET | `/api/agents/runs` | User | Recent agent runs |
| GET | `/api/agents/outputs` | User | Recent agent outputs |
| GET | `/api/agents/approvals` | User | Pending approvals |
| GET | `/api/agents/:name` | User | Get agent detail |
| GET | `/api/agents/:name/outputs` | User | Agent-specific outputs |
| GET | `/api/agents/:name/health` | User | Agent health status |
| POST | `/api/agents/trigger-all` | Admin | Trigger all agents |
| POST | `/api/agents/:name/trigger` | Admin | Trigger specific agent |
| POST | `/api/agents/approvals/:id/resolve` | Admin | Resolve approval |
| GET | `/api/admin/agents/api-usage` | Admin | AI API usage stats |
| GET | `/api/admin/agents/config` | Admin | Agent configuration |
| GET | `/api/admin/agents/attribution-backlog` | Admin | Infrastructure clusters with no attributed actor, top-N by threat count. Powers the Admin "Attribution Backlog" queue. KV cached 5 min. PR-B from 2026-05-16 audit. |
| GET | `/api/agents/token-usage` | User | Agent token usage breakdown |
| POST | `/api/agents/:name/toggle` | Admin | Enable/disable agent |
| POST | `/api/agents/:name/reset-circuit` | Admin | Reset agent circuit breaker |
| PUT | `/api/agents/:name/threshold` | Admin | Set per-agent consecutive-failure threshold (circuit breaker) |

### Flight Control (v1)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/agents/health` | User | Flight Control health snapshot (per-agent status + last run) |
| GET | `/api/v1/agents/outputs` | User | Agent outputs ticker feed |
| GET | `/api/v1/agents/activity` | User | Flight Control activity log (scaling decisions, circuit events) |

## Trustbot

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/trustbot/chat` | User | Chat with threat intelligence copilot |

## Briefings

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/briefings` | User | List briefings |
| GET | `/api/briefings/history` | User | Briefing history |
| GET | `/api/briefings/:id` | User | Get briefing detail |
| POST | `/api/briefings/generate` | Admin | Generate new briefing |

## Campaigns

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/campaigns` | User | List campaign clusters |
| GET | `/api/campaigns/stats` | User | Campaign statistics |
| GET | `/api/campaigns/:id` | User | Get campaign detail |
| GET | `/api/campaigns/:id/threats` | User | Campaign threats |
| GET | `/api/campaigns/:id/infrastructure` | User | Campaign infrastructure |
| GET | `/api/campaigns/:id/brands` | User | Brands targeted by campaign |
| GET | `/api/campaigns/:id/timeline` | User | Campaign timeline |

## Operations (NEXUS Clusters)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/operations` | User | List active NEXUS operations/clusters |
| GET | `/api/v1/operations/stats` | User | Operations statistics |
| GET | `/api/v1/operations/:id/timeline` | User | Operation event timeline |
| GET | `/api/v1/operations/:id/threats` | User | Threats in operation cluster |

## Geopolitical Campaigns

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/campaigns/geo` | User | List geopolitical campaigns (optional `?status=active`) |
| GET | `/api/campaigns/geo/:slug` | User | Get geopolitical campaign by slug |
| GET | `/api/campaigns/geo/:slug/stats` | User | Live aggregate stats (total threats, 24h, 7d, brands, IPs, domains) |
| GET | `/api/campaigns/geo/:slug/threats` | User | Threats from adversary countries/ASNs (paginated) |
| GET | `/api/campaigns/geo/:slug/timeline` | User | Daily attack timeline with type breakdown |
| GET | `/api/campaigns/geo/:slug/brands` | User | Targeted brands heat map data |
| GET | `/api/campaigns/geo/:slug/asns` | User | ASN cluster analysis (marks known adversary ASNs) |
| GET | `/api/campaigns/geo/:slug/attack-types` | User | Attack type breakdown with severity counts |

## Providers

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/providers` | User | List hosting providers |
| GET | `/api/providers/stats` | User | Provider statistics |
| GET | `/api/providers/worst` | User | Worst providers (most threats) |
| GET | `/api/providers/improving` | User | Improving providers |
| GET | `/api/providers/movers` | User | 7-day movers (rising / falling by active threat delta) |
| GET | `/api/providers/:id` | User | Get provider detail |
| GET | `/api/providers/:id/threats` | User | Provider's threats |
| GET | `/api/providers/:id/brands` | User | Brands affected by provider |
| GET | `/api/providers/:id/timeline` | User | Provider timeline |
| GET | `/api/providers/:id/locations` | User | Provider locations |

### Provider Endpoints v2

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/providers/v2` | User | Providers list with pre-computed columns (replaces v1 JOIN-based query) |
| GET | `/api/providers/intelligence` | User | Provider intelligence summary |
| GET | `/api/providers/clusters` | User | Provider infrastructure clusters |

## Email Security

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/email-security/stats` | User | Email security statistics |
| GET | `/api/email-security/scan-all` | Admin | Scan all monitored brands |
| GET | `/api/email-security/:brandId` | User | Get brand email security posture |
| POST | `/api/email-security/scan/:brandId` | User | Trigger email security scan |

## DMARC Reports

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/dmarc-reports/overview` | User | DMARC overview |
| GET | `/api/dmarc-reports/:brandId` | User | Brand DMARC reports |
| GET | `/api/dmarc-reports/:brandId/stats` | User | Brand DMARC statistics |
| GET | `/api/dmarc-reports/:brandId/sources` | User | DMARC sending sources |

## Lookalike Domains

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/lookalikes/:brandId` | User | List lookalike domains |
| POST | `/api/lookalikes/:brandId/generate` | User | Generate domain permutations |
| POST | `/api/lookalikes/:brandId/scan` | User | Scan lookalike domains |
| PATCH | `/api/lookalikes/:id` | User | Update lookalike status |

## App Store Impersonation Monitoring

iOS App Store impersonation scanner (Google Play + 3rd-party Android
stores planned). Findings are upserted into `app_store_listings` and
classified rule-based first; ambiguous rows are re-assessed by Haiku.
HIGH/CRITICAL impersonation findings create `alerts` rows of type
`app_store_impersonation` and fire an `alert.created` webhook.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/appstore/monitor/:brandId` | User | List app-store listings + schedule for a brand. Filters: `store`, `classification`, `severity`, `status`, `limit`, `offset`. |
| POST | `/api/appstore/scan/:brandId` | User | Trigger an immediate iOS scan + AI drain for this brand. |
| PATCH | `/api/appstore/:id` | User | Update a listing's `classification` or `status` (manual override, wins over AI/system). |
| PATCH | `/api/brands/:brandId/official-apps` | User | Replace the brand's `official_apps` allowlist. Matching existing rows auto-flip to `classification='official'`. |

**Takedown integration:** App-store findings can be escalated by creating
a takedown with `target_type='mobile_app'` and `target_platform='ios_app_store'`
or `'google_play_store'`. When `source_type='app_store_listing'` and
`source_id` is a listing UUID, severity and evidence are auto-filled.

## Dark-Web Mention Monitoring

Paste-archive mention scanner (PSBDMP initially; Telegram, HIBP, Flare,
and DarkOwl land in future slices via the `source` column without schema
changes). Per-brand scanner fans out watch terms (brand name, aliases,
domain, executive names from `brands.executive_names`) against the paste
archive, fetches candidate bodies, and classifies each. Threat-actor
aliases from the `threat_actors` table are cross-referenced as a
severity boost. HIGH/CRITICAL confirmed findings create `alerts` rows
of type `dark_web_mention` and fire an `alert.created` webhook.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/darkweb/overview` | User | Cross-brand dashboard: one row per monitored brand with severity-bucketed counts and schedule info. Admin scope sees all; tenant scope sees `monitored_brands.added_by = :userId`. |
| GET | `/api/darkweb/mentions/:brandId` | User | List mentions + schedule for a brand. Filters: `source`, `classification`, `severity`, `match_type`, `status`, `limit`, `offset`. |
| POST | `/api/darkweb/scan/:brandId` | User | Trigger an immediate scan + AI drain for this brand. |
| PATCH | `/api/darkweb/:id` | User | Update a mention's `classification` or `status` (manual override, wins over AI/system). |

**Classification values:** `confirmed`, `suspicious`, `false_positive`, `resolved`, `unknown`.
**Status values:** `active`, `resolved`, `false_positive`, `investigating`.
**Match types:** `brand_name`, `domain`, `executive`, `actor_alias`, `mixed`.

## Certificate Transparency

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/ct/certificates/:brandId` | User | List CT certificates |
| GET | `/api/ct/certificates/:brandId/stats` | User | CT statistics |
| POST | `/api/ct/scan/:brandId` | User | Trigger CT scan |
| PATCH | `/api/ct/certificates/:id` | User | Update certificate status |

## Threat Narratives

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/narratives/:brandId` | User | List narratives for brand |
| GET | `/api/narratives/:brandId/:id` | User | Get narrative detail |
| POST | `/api/narratives/:brandId/generate` | User | Generate AI narrative |
| PATCH | `/api/narratives/:id` | User | Update narrative |

## Threat Assessment

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/brand/:brandId/threat-assessment` | User | Brand threat assessment |
| GET | `/api/brand/:brandId/threat-assessment/history` | User | Assessment history |
| GET | `/api/threat-feeds/stats` | User | Threat feed statistics |

## Alerts

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/alerts` | User | List alerts |
| GET | `/api/alerts/stats` | User | Alert statistics |
| GET | `/api/alerts/:id` | User | Get alert detail |
| PATCH | `/api/alerts/:id` | User | Update alert status |
| POST | `/api/alerts/bulk-acknowledge` | User | Bulk acknowledge alerts |
| POST | `/api/alerts/bulk-takedown` | User | Bulk create takedown requests from alerts |
| POST | `/api/admin/alerts/backfill-triage?limit=500&offset=0&threshold=0.5` | Admin | Auto-triage pass over `new` alerts. Dispatches by alert family: threat-sourced (VT/GSB/GreyNoise/SecLookup clean), social_impersonation (handle in official_handles or score < threshold), app_store_impersonation (developer in official_apps OR developer name normalizes to brand name OR score < threshold). Returns `{scanned, dismissed, kept, no_threat, by_type}`. **Use `offset` to advance through the queue across calls** — without it, batches with 0 dismissals will re-scan the same alerts forever. |
| POST | `/api/admin/alerts/run-ai-judge?limit=50&offset=0` | Admin | Tier 3 — runs Haiku second-opinion on `new` alerts that haven't been AI-judged yet (`ai_assessment IS NULL`). Stamps verdict + reasoning into `ai_assessment`. Auto-dismisses only when verdict='likely_safe' AND confidence >= 90. Returns `{scanned, judged, dismissed, kept, failed, by_verdict}`. ~$0.001 per alert. Idempotent. |
| POST | `/api/admin/notifications/cleanup-dismissed?lookback_hours=168&window_minutes=15&limit=1000` | Admin | Sweeps `notifications` for unread rows correlating (by `brand_id` + ±`window_minutes` of `created_at`) to recently auto-dismissed alerts (`resolution_notes LIKE 'auto:%'`). Marks matched notifications as `read`. Heuristic by design — alerts and notifications are not FK-linked. Returns `{alerts_checked, notifications_cleared}`. Idempotent. |

## Notifications

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/notifications` | User | List notifications. Query params: `state=inbox\|snoozed\|done\|all` (default `inbox` hides done + unexpired snoozed), `unread=true`, `type`, `severity`, `q`, `cursor`, `limit` |
| GET | `/api/notifications/unread-count` | User | Unread count |
| GET | `/api/notifications/preferences` | User | Notification preferences |
| PUT | `/api/notifications/preferences` | User | Update preferences |
| POST | `/api/notifications/:id/read` | User | Mark as read |
| POST | `/api/notifications/read-all` | User | Mark all as read |
| POST | `/api/notifications/:id/snooze` | User | Snooze until ISO-8601 timestamp (body: `{until}`) |
| POST | `/api/notifications/:id/done` | User | Mark done (Linear-style fourth state) |
| GET | `/api/notifications/preferences/v2` | User | Per-channel severity floors + digest mode + super_admin opt-in (auto-seeds row if missing) |
| PUT | `/api/notifications/preferences/v2` | User | Patch any subset of v2 fields |
| GET | `/api/notifications/subscriptions` | User | List per-brand subscriptions joined with brand metadata |
| PUT | `/api/notifications/subscriptions/:brandId` | User | Set level (watching\|default\|ignored), optional `snoozed_until` |
| DELETE | `/api/notifications/subscriptions/:brandId` | User | Remove subscription |

## Trends

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/trends/volume` | User | Threat volume over time |
| GET | `/api/trends/types` | User | Threat type breakdown |
| GET | `/api/trends/brands` | User | Brand trend data |
| GET | `/api/trends/providers` | User | Provider trends |
| GET | `/api/trends/tlds` | User | TLD trends |
| GET | `/api/trends/compare` | User | Compare periods |
| GET | `/api/trends/intelligence` | User | Observer intelligence insights |
| GET | `/api/trends/threat-volume` | User | Threat volume by type over time window |
| GET | `/api/trends/brand-momentum` | User | Brand threat momentum (week-over-week) |
| GET | `/api/trends/provider-momentum` | User | Hosting provider momentum (7d/30d) |
| GET | `/api/trends/nexus-active` | User | Active accelerating Nexus clusters |

## Insights

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/insights/latest` | User | Latest AI insights |

## Signals

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/signals` | User | List signals |
| POST | `/api/signals` | Admin | Create signal |

## Scans

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/scan` | User | Trigger scan |
| GET | `/api/scan/history` | User | Scan history |
| POST | `/api/brand-scan` | User | Brand exposure scan |
| GET | `/api/brand-scan/history` | User | Brand scan history |
| POST | `/api/snapshots/generate` | Admin | Generate threat snapshot |

## Investigations

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/tickets` | User | List investigation tickets |
| GET | `/api/tickets/:id` | User | Get ticket detail |
| POST | `/api/tickets` | User | Create ticket |
| PATCH | `/api/tickets/:id` | User | Update ticket |
| POST | `/api/tickets/:id/evidence` | User | Attach evidence |
| GET | `/api/erasures` | User | List erasure/takedown requests |
| POST | `/api/erasures` | User | Create erasure request |
| PATCH | `/api/erasures/:id` | User | Update erasure status |

## Threat Actors

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/threat-actors` | User | List threat actors (KV cached, read replicas, parallel count+list) |
| GET | `/api/threat-actors/stats` | User | Threat actor statistics (KV cached, read replicas, parallel 6-query aggregation) |
| GET | `/api/threat-actors/:id` | User | Get threat actor detail with infrastructure + targets |
| GET | `/api/threat-actors/by-brand/:brandId` | User | Threat actors targeting a specific brand |
| GET | `/api/threat-actors/:id/threats` | User | Threats linked to actor via `threat_attributions` (Phase B — OTX/NEXUS/news) **OR** known ASN infrastructure |

## Intel

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/intel/hotlist` | Staff | Mass-impersonation IPs + multi-feed-consensus IPs + recent temporal bursts (KV cached 5min). Powers the Home "Intel Hotlist" section — PR-A from the 2026-05-16 platform audit. |
| GET | `/api/intel/critical-banner` | Staff | Prioritized "Critical Intelligence" events (provider surges, bursts, mass-impersonation IPs, new campaigns, falls back to open-critical alerts). Powers the red banner on Home — replaces the bare `alertStats.critical` count that conflated severity with operator concern. KV cached 60s. |
| GET | `/api/breaches` | User | Breach check data (KV cached, read replicas) |
| GET | `/api/ato-events` | User | Account takeover events (KV cached, read replicas) |
| PATCH | `/api/ato-events/:id` | User | Update ATO event |
| GET | `/api/email-auth` | User | Email auth reports (KV cached, read replicas) |
| GET | `/api/cloud-incidents` | User | Cloud security incidents (KV cached, read replicas) |
| GET | `/api/trust-scores` | User | Trust score history |
| GET | `/api/social-iocs` | User | Social IOCs |

## Spam Trap

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/spam-trap/stats` | Admin | Spam trap statistics |
| GET | `/api/spam-trap/captures` | Admin | Captured phishing emails |
| GET | `/api/spam-trap/captures/brand/:brandId` | User | Brand-specific captures |
| GET | `/api/spam-trap/captures/:id` | Admin | Single capture detail |
| GET | `/api/spam-trap/sources` | Admin | Spam sources |
| GET | `/api/spam-trap/campaigns` | Admin | Seed campaigns |
| POST | `/api/spam-trap/campaigns` | Admin | Create seed campaign |
| POST | `/api/spam-trap/campaigns/:id/execute` | Admin | Execute seed campaign |
| PUT | `/api/spam-trap/campaigns/:id` | Admin | Update seed campaign |
| GET | `/api/spam-trap/seeding-sources` | Admin | Seeding source inventory |
| GET | `/api/spam-trap/addresses` | Admin | Trap addresses |
| POST | `/api/spam-trap/seed/initial` | Admin | Initial trap seeding |
| POST | `/api/spam-trap/strategist/run` | Admin | Run seed strategist |
| POST | `/api/spam-trap/reparse-auth` | Admin | Re-parse DMARC / DKIM / SPF fields on existing captures |
| POST | `/api/spam-trap/seeds/:id/retire` | Admin | Soft-retire a dead seed address (Wave-1 PR-AB) |
| GET | `/api/spam-trap/insights` | Admin | Bundled trends / correlations / strategy datasets (Wave-4 PR-AE) |
| GET | `/api/admin/seed-domains` | Admin | List seed-domain config (Wave-2.1 PR-AF) |
| POST | `/api/admin/seed-domains` | Admin | Add seed domain to auto-seeder rotation |
| PATCH | `/api/admin/seed-domains/:domain` | Admin | Update status / pages / notes |
| DELETE | `/api/admin/seed-domains/:domain` | Super-admin | Hard delete (prefer status='retired') |
| GET | `/api/admin/abuse-mailbox` | Super-admin | Averrow self abuse-mailbox summary (PR-AA) |
| GET | `/api/admin/abuse-mailbox/messages` | Super-admin | Averrow self abuse-mailbox messages list |
| GET | `/api/admin/abuse-mailbox/messages/:id` | Super-admin | Per-message detail with raw body / headers / URL list / attachments (PR-AS) |
| POST | `/api/admin/abuse-mailbox/messages/:id/unthrottle` | Super-admin | Clear rate-limit flag on a message + queue for next classifier pass (PR-AT) |
| PATCH | `/api/admin/abuse-mailbox/messages/:id/status` | Super-admin | Update message status (new / investigating / resolved / dismissed) — PR-BD |
| GET | `/api/admin/abuse-mailbox/intel` | Super-admin | Aggregated intel summary from `deep_analysis` rows: active campaigns, recent takedown recommendations, top hosting providers, 7d/30d analyzed counts (PR-BD) |

## Data Export

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/export/scans` | User | Export scan data |
| GET | `/api/export/signals` | User | Export signals |
| GET | `/api/export/alerts` | User | Export alerts |
| GET | `/api/export/stix/:brandId` | User | STIX bundle export |
| GET | `/api/export/stix/:brandId/indicators` | User | STIX indicators only |

## Admin

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/admin/stats` | Admin | Platform statistics |
| GET | `/api/admin/pipeline-status` | Admin | Pipeline backlog counts with trend direction, owning agent, last run time. Reads from pre-computed backlog_history + agent_runs — no COUNT queries on threats. 5-min KV cache. |
| GET | `/api/admin/health` | Admin | System health |
| GET | `/api/admin/budget/ledger-health` | Admin | Budget ledger fill diagnostic — surfaces per-call-site rows in the last 24h, flags any expected agentId that has not landed a row, and returns BudgetManager.getStatus() so operators can spot-check monthly_spend / throttle_level after the wrapper refactor. |
| GET | `/api/admin/platform-diagnostics` | Super Admin | Comprehensive platform diagnostics for programmatic consumption. Returns enrichment pipeline state (stuck pile, cartographer queue, enriched counts), per-feed failure rates with auto-pause risk, per-agent run counts, backlog trends, AI spend, cron health, stalled agents. Accepts `?hours=N` (default 6, max 48). |
| GET | `/api/internal/platform-diagnostics` | AVERROW_INTERNAL_SECRET | Same as above, accessible via `Authorization: Bearer $AVERROW_INTERNAL_SECRET` for programmatic/CLI access without JWT. |
| GET | `/api/admin/platform-status` | Super Admin | 30-day rolling uptime rollup across three categories (Feeds, Agents, Processing) plus a realtime (last-6h) state for the Home banner. Replaces the static "ALL SYSTEMS OPERATIONAL" lie that hid the 50cb1e4 ingest blackout. Cached 60s in KV; pass `?refresh=1` to bypass. Used by the Home banner and (Phase 3) public status page. |
| GET | `/api/internal/platform-status` | AVERROW_INTERNAL_SECRET | Same as above, accessible via `Authorization: Bearer $AVERROW_INTERNAL_SECRET` for the averrow-mcp server and the (Phase 3) public status page Worker. |
| GET | `/api/admin/notification-delivery-audit` | Super Admin | Per-channel delivery audit for platform_* notifications. Reads `notification_deliveries` (migration 0131) and reports which channels (in_app / push / email) succeeded, failed, or were skipped per notification, plus a `delivery_health` rollup and a `stale` flag for unread platform alerts older than 6h. Built after 50cb1e4 to verify platform alerts actually reach humans. Accepts `?days=N` (default 7, max 30). |
| GET | `/api/internal/notification-delivery-audit` | AVERROW_INTERNAL_SECRET | Same as above for programmatic / MCP access. |
| GET | `/api/admin/incidents` | Super Admin | List incidents (migration 0132). `?status=open` filters to non-resolved. `?visibility=public\|internal` filters by exposure. Returns severity/status pivoted with parsed `affected_components`. Auto-created from critical platform_* notifications + manually creatable. |
| POST | `/api/admin/incidents` | Super Admin | Create a manual incident. Body: `{ title, description?, severity?, status?, affected_components? }`. |
| GET | `/api/admin/incidents/:id` | Super Admin | Incident detail + full update timeline (operator + system rows). |
| POST | `/api/admin/incidents/:id/updates` | Super Admin | Append an operator update. Body: `{ message, status?, visibility?, public_message? }`. If `visibility='public'`, `public_message` is required (returns 400 otherwise). If `status` is set, transitions the incident as part of the same write. |
| PATCH | `/api/admin/incidents/:id/updates/:updateId` | Super Admin | Edit an existing update's public copy. Works on operator AND auto-stored system rows so the auto-create trigger / recovery sweep messages can be promoted. Body: `{ public_message: string \| null, visibility? }`. Pass `public_message: null` to clear. Logs a system update for audit. |
| POST | `/api/admin/incidents/:id/transition` | Super Admin | Status-only transition without a message. Body: `{ status }`. Logs a system update for audit. |
| POST | `/api/admin/incidents/:id/promote` | Super Admin | Flip visibility internal↔public AND/OR edit `public_title` / `public_details`. Promoting to public requires a non-empty `public_title` (200/2000 char caps). |
| GET | `/api/admin/cartographer-health` | Super Admin | Focused Phase 0 enrichment diagnostic. Returns migration sanity (column + index for migration 0110), attempts histogram, queue / exhausted / stuck-pile counts, throughput (1h / 6h / 24h), recent runs, and ip-api yield per recent batch with computed avg_yield_pct. |
| GET | `/api/internal/cartographer-health` | AVERROW_INTERNAL_SECRET | Same as above, accessible via `Authorization: Bearer $AVERROW_INTERNAL_SECRET` for programmatic/CLI access (used by `scripts/cartographer-health.sh`). |
| GET | `/api/admin/d1-health` | Super Admin | Database-level D1 diagnostic. Returns DB size (page_count × page_size), per-table row counts (top N, default 20), index counts (incl. partial), schema version, FK enforcement state, applied migrations, sample query latency. Accepts `?check_fk=true` to run `PRAGMA foreign_key_check` (slow — gated). Accepts `?top_n=N` (max 50). |
| GET | `/api/internal/d1-health` | AVERROW_INTERNAL_SECRET | Same as above for programmatic/CLI access (used by `scripts/d1-health.sh` and the `d1_health` MCP tool). |
| GET | `/api/internal/cf-zone-introspect?zone=<hostname>` | AVERROW_INTERNAL_SECRET | Read-only Cloudflare zone debug. Uses the worker's CF_API_TOKEN to enumerate DNS records, Workers Routes, Page Rules, and Custom WAF rules for the given zone, plus probes the public URL to capture edge-level response headers (deny-reason etc.). Each section fails independently with the CF error message when the token lacks the required scope. |
| POST | `/api/admin/leads/:id/qualified-report` | Super Admin | Generates a sales-qualified Brand Risk Plan for a `scan_leads.id`. Aggregates active threats, infrastructure (hosting providers, countries, campaigns), email security posture, lookalike inventory; calls Haiku for the threat actor briefing + remediation plan; computes ROI projection. Returns `share_url` (token-gated, 30-day TTL), `risk_grade`, `expires_at`. |
| GET | `/qualified-report/:token` | (token only) | Public view of a generated qualified report. Token is a 32-byte URL-safe random id from the generate response; presence + non-expired = access. Returns server-rendered HTML with print-friendly styling. |
| POST | `/api/admin/leads/:id/outreach` | Super Admin | Sends a templated outreach email to the lead's email via Resend (from `sales@averrow.com`). Embeds the most recent qualified-report share URL + risk grade + top 3 key findings. Returns 400 if no active qualified report exists for the lead. Updates `scan_leads.outreach_sent_at` + `outreach_email_id`. |
| POST | `/api/admin/leads/:id/convert-to-tenant` | Super Admin | Converts a qualified lead into a tenant organization. Creates `organizations` row + adds super_admin as owner-role `org_members` row + correlates/creates brand row + adds to `monitored_brands` for tenant scope. Updates `scan_leads.status='converted'`. Returns `{ org_id, slug, invite_code, brand_id, brand_was_created }`. |
| GET | `/api/internal/system-health` | AVERROW_INTERNAL_SECRET | Internal mirror of `/api/admin/system-health` for MCP server access. |
| GET | `/api/internal/pipeline-status` | AVERROW_INTERNAL_SECRET | Internal mirror of `/api/admin/pipeline-status` for MCP server access. |
| GET | `/api/internal/stats` | AVERROW_INTERNAL_SECRET | Internal mirror of `/api/admin/stats` for MCP server access. |
| GET | `/api/internal/budget/status` | AVERROW_INTERNAL_SECRET | Internal mirror of `/api/admin/budget/status` for MCP server access. |
| GET | `/api/internal/budget/ledger-health` | AVERROW_INTERNAL_SECRET | Internal mirror of `/api/admin/budget/ledger-health` for MCP server access. |
| GET | `/api/internal/agents/:name/health` | AVERROW_INTERNAL_SECRET | Internal mirror of `/api/agents/:name/health` for MCP server access. |
| GET | `/api/admin/users` | Admin | List users |
| PATCH | `/api/admin/users/:id` | Admin | Update user |
| GET | `/api/admin/sessions` | Admin | Active sessions |
| POST | `/api/admin/users/:id/force-logout` | Admin | Force logout user |
| GET | `/api/admin/invites` | Admin | List invites |
| POST | `/api/admin/invites` | Admin | Create invite |
| DELETE | `/api/admin/invites/:id` | Admin | Revoke invite |
| GET | `/api/admin/audit` | Admin | Audit log |
| GET | `/api/admin/audit/export` | Admin | Export audit log |
| GET | `/api/admin/brands` | Admin | List all brands (admin) |
| POST | `/api/admin/brands/bulk-monitor` | Admin | Bulk add brands |
| POST | `/api/admin/brands/bulk-delete` | Admin | Bulk delete brands |
| GET | `/api/admin/sales-leads` | Admin | List sales leads |
| GET | `/api/admin/sales-leads/stats` | Admin | Lead statistics |
| GET | `/api/admin/sales-leads/:id` | Admin | Get lead detail |
| PATCH | `/api/admin/sales-leads/:id` | Admin | Update lead |
| POST | `/api/admin/sales-leads/:id/approve` | Admin | Approve lead |
| POST | `/api/admin/sales-leads/:id/send` | Admin | Send outreach |
| POST | `/api/admin/sales-leads/:id/respond` | Admin | Record response |
| POST | `/api/admin/sales-leads/:id/book` | Admin | Book demo |
| POST | `/api/admin/sales-leads/:id/convert` | Admin | Convert to customer |
| POST | `/api/admin/sales-leads/:id/decline` | Admin | Decline lead |
| DELETE | `/api/admin/sales-leads/:id` | Admin | Delete lead |
| GET | `/api/admin/sales-leads/:id/activity` | Admin | Lead activity log |
| POST | `/api/admin/sales-leads/:id/refresh-firmographics` | SuperAdmin | Re-run SEC/Wikidata enricher for this lead's brand and copy the refreshed firmographic + buying-signal data onto the lead snapshot. Cheap (no AI). |
| GET  | `/api/admin/notifications/stats` | SuperAdmin | NX5 Notification Center — fired-by-(type, audience, severity) breakdown over a window (default 24h, max 720h via `?hours=`). |
| GET  | `/api/admin/notifications/mutes` | SuperAdmin | NX5 — list active system-wide notification type mutes. |
| POST | `/api/admin/notifications/mute` | SuperAdmin | NX5 — system-wide mute for a notification type. Body: `{ type, hours, reason? }`. |
| DELETE | `/api/admin/notifications/mute/:type` | SuperAdmin | NX5 — clear a system-wide mute. |
| POST | `/api/admin/backfill-classifications` | SuperAdmin | Backfill threat classifications |
| POST | `/api/admin/backfill-saas-techniques` | Admin | Backfill SaaS attack technique classification (PushSecurity taxonomy) |
| POST | `/api/admin/backfill-geo` | SuperAdmin | Backfill geo enrichment |
| POST | `/api/admin/backfill-domain-geo` | Admin | Resolve malicious domains → IP → geo + hosting provider (Cloudflare DoH, 500/call) |
| POST | `/api/admin/geoip-refresh` | Admin | Trigger the `geoip_refresh` agent. Polls MaxMind for a new GeoLite2-City release; auto-reimports only if the .sha256 differs from the last loaded version. Body `{ "forceReload": true }` bypasses the version guard. Auto-runs Sundays at 02:00 UTC. |
| GET  | `/api/admin/geoip-status` | Admin | Dedicated GeoIP DB status: row count, last refresh, last error. Used by the Pipeline Automation card. |
| POST | `/api/admin/backfill-brand-match` | SuperAdmin | Backfill brand matching |
| POST | `/api/admin/backfill-brand-enrichment` | Admin | Populate brand logo_url, website_url, hq_lat/lng/country via Clearbit + DNS + ipapi (50/call) |
| POST | `/api/admin/backfill-brand-sector` | Admin | Classify brand sector via Haiku + fetch RDAP registrant data (20/call) |
| POST | `/api/admin/backfill-safe-domains` | SuperAdmin | Backfill safe domains |
| POST | `/api/admin/backfill-ai-attribution` | SuperAdmin | Backfill AI attribution |
| POST | `/api/admin/import-tranco` | SuperAdmin | Import Tranco top sites |
| POST | `/api/admin/honeypot/generate` | SuperAdmin | Generate honeypot sites |
| POST | `/api/admin/cube-backfill` | Admin | Backfill `threat_cube_geo` / `threat_cube_provider` OLAP tables via streaming NDJSON. Query params: `cube=geo\|provider\|brand\|all` (required), `days=1..365` (default 30), `dry_run=true\|false`, `resume_from=<hour_bucket>`. Returns one NDJSON line per hour plus a summary line with `resume_from` if the 25s budget is hit. |
| GET | `/api/admin/system-health` | Admin | System health dashboard |
| GET | `/api/admin/budget/status` | Admin | AI budget status and spend |
| GET | `/api/admin/budget/breakdown` | Admin | Budget breakdown by agent |
| GET | `/api/admin/organizations` | Super Admin | List all organizations |
| POST | `/api/admin/organizations` | Super Admin | Create organization |
| GET | `/api/admin/organizations/:orgId` | Super Admin | Get organization detail |
| PATCH | `/api/admin/organizations/:orgId` | Super Admin | Update organization |
| GET | `/api/admin/brands/search` | Super Admin | Search brands for org assignment |
| GET | `/api/admin/leads` | Admin | List leads |
| PATCH | `/api/admin/leads/:id` | Admin | Update lead |
| GET | `/api/admin/takedowns` | Super Admin | List takedowns across orgs |
| PATCH | `/api/admin/takedowns/:id` | Super Admin | Update takedown status |
| POST | `/api/admin/discover-social-batch` | Super Admin | Run social discovery batch |
| POST | `/api/admin/pathfinder-enrich` | Super Admin | Pathfinder AI enrichment batch |

ARCHITECT is now a standard agent triggered via `POST /api/agents/architect/trigger` (Admin auth, see [Agents section](#agents)). The full audit pipeline (collect → analyze → synthesize) runs inline in one execute() call. The markdown report, computed scorecard, and per-section analyses are stored in the latest `agent_outputs.details` row for `agent_id='architect'`; read them via `GET /api/agents/architect/outputs?limit=5`.

## Sparrow (Takedown Automation)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/admin/sparrow/scan-capture/:id` | Admin | Run Sparrow analysis on a single capture |
| POST | `/api/admin/sparrow/scan-batch` | Admin | Batch scan captures |
| GET | `/api/admin/sparrow/results/:captureId` | Admin | Get scan results for a capture |
| GET | `/api/admin/sparrow/malicious` | Admin | List confirmed malicious scan results |
| GET | `/api/admin/sparrow/providers` | Admin | Hosting/registrar providers discovered by Sparrow |
| POST | `/api/admin/sparrow/assemble-evidence/:takedownId` | Admin | Assemble takedown evidence bundle |
| GET | `/api/admin/sparrow/evidence/:takedownId` | Admin | Get assembled evidence bundle |
| GET | `/api/admin/sparrow/resolve-provider/:domain` | Admin | Resolve hosting provider for a domain |
| POST | `/api/admin/sparrow/generate-draft/:takedownId` | Admin | Generate AI takedown notice draft |

## Organizations (Tenant-Scoped)

All endpoints under `/api/orgs/:orgId/...` require the caller to be a member of the organization. Roles within the org gate specific actions (e.g. invite management requires `admin` or `owner`).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/orgs/:orgId` | Member | Get organization detail |
| GET | `/api/orgs/:orgId/members` | Member | List organization members |
| POST | `/api/orgs/:orgId/invite` | Admin (org) | Invite a user to the organization |
| DELETE | `/api/orgs/:orgId/members/:userId` | Admin (org) | Remove a member |
| PATCH | `/api/orgs/:orgId/members/:userId` | Admin (org) | Update a member role |
| GET | `/api/orgs/:orgId/invites` | Admin (org) | List outstanding invites |
| DELETE | `/api/orgs/:orgId/invites/:inviteId` | Admin (org) | Revoke an invite |
| GET | `/api/orgs/:orgId/brands` | Member | List brands assigned to the org |
| POST | `/api/orgs/:orgId/brands` | Admin (org) | Assign a brand to the org |
| DELETE | `/api/orgs/:orgId/brands/:brandId` | Admin (org) | Unassign a brand |
| GET | `/api/orgs/:orgId/api-keys` | Admin (org) | List API keys |
| POST | `/api/orgs/:orgId/api-keys` | Admin (org) | Create API key |
| DELETE | `/api/orgs/:orgId/api-keys/:keyId` | Admin (org) | Revoke API key |
| GET | `/api/orgs/:orgId/integrations` | Admin (org) | List integrations (SIEM, SOAR, webhook) |
| POST | `/api/orgs/:orgId/integrations` | Admin (org) | Create integration |
| PATCH | `/api/orgs/:orgId/integrations/:integrationId` | Admin (org) | Update integration |
| DELETE | `/api/orgs/:orgId/integrations/:integrationId` | Admin (org) | Delete integration |
| POST | `/api/orgs/:orgId/integrations/:integrationId/test` | Admin (org) | Send a test event through an integration |
| GET | `/api/orgs/:orgId/webhook` | Admin (org) | Get webhook config |
| PATCH | `/api/orgs/:orgId/webhook` | Admin (org) | Update webhook |
| POST | `/api/orgs/:orgId/webhook/regenerate-secret` | Admin (org) | Rotate webhook HMAC secret |
| POST | `/api/orgs/:orgId/webhook/test` | Admin (org) | Send a test webhook delivery |
| GET | `/api/orgs/:orgId/dashboard` | Member | Tenant-scoped dashboard |
| GET | `/api/orgs/:orgId/alerts` | Member | Tenant alerts list |
| PATCH | `/api/orgs/:orgId/alerts/:alertId` | Member | Update tenant alert |
| GET | `/api/orgs/:orgId/brands/:brandId/detail` | Member | Tenant brand detail |
| GET | `/api/orgs/:orgId/brands/:brandId/threats` | Member | Tenant brand threats |
| GET | `/api/orgs/:orgId/brands/:brandId/social-profiles` | Member | Tenant brand social profiles |
| GET | `/api/orgs/:orgId/brands/:brandId/monitoring-config` | Member | Get monitoring config |
| PATCH | `/api/orgs/:orgId/brands/:brandId/monitoring-config` | Admin (org) | Update monitoring config |
| POST | `/api/orgs/:orgId/takedowns` | Member | Create takedown request |
| GET | `/api/orgs/:orgId/takedowns` | Member | List takedown requests |
| GET | `/api/orgs/:orgId/takedowns/:id` | Member | Get takedown detail |
| PATCH | `/api/orgs/:orgId/takedowns/:id` | Admin (org) | Update takedown |

## Internal Endpoints

All internal endpoints require `Authorization: Bearer $AVERROW_INTERNAL_SECRET`. They are used by the MCP server, CLI scripts, and platform diagnostics without a user JWT.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/debug/run-enrichment` | Manually trigger the enrichment pipeline |
| POST | `/api/internal/agents/cartographer/run` | Trigger Cartographer agent inline |
| POST | `/api/internal/agents/nexus/run` | Trigger NEXUS agent inline |
| POST | `/api/internal/agents/cartographer/backfill` | Run Cartographer backfill inline |
| POST | `/api/internal/agents/cartographer/backfill-workflow` | Dispatch Cartographer backfill as a durable Workflow |
| GET | `/api/internal/agents/cartographer/backfill-workflow/:instanceId` | Check backfill workflow status |
| POST | `/api/internal/agents/nexus/workflow` | Dispatch NEXUS as a durable Workflow |
| GET | `/api/internal/agents/nexus/workflow/:instanceId` | Check NEXUS workflow status |
| POST | `/api/internal/briefing/send` | Manually generate and email the daily briefing |
| GET | `/api/certstream/stats` | CertStream Durable Object stats |
| POST | `/api/certstream/reload-brands` | Reload brand watchlist in CertStream DO |

## WebSocket

| Path | Auth | Description |
|------|------|-------------|
| `/ws/threats` | User | Real-time threat push (Durable Object) |

## Corporate Site Pages

These are server-rendered HTML pages (not API endpoints):

| Path | Description |
|------|-------------|
| `/` | Landing page |
| `/platform` | Platform overview |
| `/about` | About page |
| `/pricing` | Pricing page |
| `/security` | Security page |
| `/blog` | Blog index |
| `/blog/email-security-posture-brand-defense` | Blog post |
| `/blog/cost-brand-impersonation-mid-market` | Blog post |
| `/blog/ai-powered-threat-narratives` | Blog post |
| `/blog/lookalike-domains-threat-hiding` | Blog post |
| `/changelog` | Changelog |
| `/contact` | Contact page |
| `/privacy` | Privacy policy |
| `/terms` | Terms of service |
| `/scan` | Public scan page |
| `/scan/:id` | Scan result page |
| `/assess` | Brand assessment (POST) |
| `/assess/:id/results` | Assessment results |

## Response Format

All API endpoints return JSON in this format:

```json
{
  "success": true,
  "data": { ... }
}
```

Error responses:

```json
{
  "success": false,
  "error": "Error message"
}
```

## Rate Limiting

Public endpoints are rate-limited using KV-based counters:

| Endpoint Type | Limit |
|--------------|-------|
| Auth endpoints | 10 req/min |
| Public scans | 5 req/min |
| General API | 60 req/min |

Rate limit headers are included in responses: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.
