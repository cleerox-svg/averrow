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
| POST | `/api/auth/magic-link/request` | — (rate-limited) | Request a magic sign-in link by email. Body: `{ email, return_to? }` |
| GET | `/api/auth/magic-link/:token` | — (rate-limited) | Verify magic link from the email body; mints a session and 302s to the SPA like the OAuth callback |
| GET | `/api/profile` | User | Get editable profile (display_name, timezone, theme_preference). Distinct from `/api/auth/me` (read-only session bootstrap) |
| PATCH | `/api/profile` | User | Update a partial set of profile fields; pass `null` to clear a field back to its default |
| GET | `/api/invites/:token` | — | Validate an invite token before acceptance |
| GET | `/invite` | — | Invite landing page (HTML) |

**Auth hardening (AUTH_AUDIT_2026-06):**
- **Access token TTL** is **30 min** (was 12h). The SPA holds it in memory
  only and silently refreshes via the HttpOnly `radar_refresh` cookie.
- **Refresh-token reuse detection (H-2):** `/api/auth/refresh` rotates the
  refresh token and remembers the prior hash. Re-presenting an already-
  rotated token outside a ~15s concurrency grace revokes the user's entire
  session family and force-logs-them-out (audit `refresh_token_reuse`).
- **Passkey-required staff sessions (H-3):** an `admin`/`super_admin` who
  signs in via Google or magic-link receives an *enrollment-scoped* session.
  `/api/auth/me` returns `passkey_required: true`, and every protected route
  returns **403 `passkey_enrollment_required`**. Only the passkey-bootstrap
  endpoints (`/api/passkeys/register/*`, `/api/auth/me`, `/api/auth/logout`,
  `GET /api/passkeys`) remain reachable. A full session is only issued when
  `method === 'passkey'`. Non-privileged roles are unaffected.

### Passkeys (WebAuthn)

Registration is auth-required (passkey is added to a signed-in user). Authentication is public (it produces a fresh session).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/passkeys/register/begin` | User | Begin passkey registration (returns WebAuthn creation options) |
| POST | `/api/passkeys/register/finish` | User | Finish passkey registration (verifies attestation) |
| POST | `/api/passkeys/auth/begin` | — (rate-limited) | Begin passkey authentication (returns WebAuthn request options) |
| POST | `/api/passkeys/auth/finish` | — (rate-limited) | Finish passkey authentication; mints a session |
| GET | `/api/passkeys` | User | List the caller's registered passkeys |
| DELETE | `/api/passkeys/:id` | User | Delete one of the caller's passkeys |

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
| POST | `/api/leads` | Lead capture (rate-limited) |
| POST | `/api/abuse-mailbox/unsubscribe` | RFC 8058 one-click unsubscribe target for abuse-mailbox responder emails. Token is an HMAC of the email address — no auth, no body |
| GET | `/api/abuse-mailbox/unsubscribe` | Manual-click fallback for the unsubscribe link (same HMAC token gate) |
| POST | `/api/stripe/webhook` | Stripe billing lifecycle webhook. No bearer auth — the handler verifies the `Stripe-Signature` HMAC before trusting any payload |
| GET | `/status` | Public platform status page (HTML). Server-rendered 30-day uptime rollup with per-day bars per category (Feeds / Agents / Processing). Inline script polls `/api/v1/public/platform-status` every 60s for live updates. |
| GET | `/status/incidents` | Public incident archive (HTML). Lists every public incident, newest first, grouped by month. Linked from the recent-incidents section on `/status`. Same visibility gate as the rest. |
| GET | `/status/feed.xml` | RSS 2.0 feed of public incidents (Content-Type `application/rss+xml`). Most recent 50, newest first by latest activity. Each item links to the `/status/incidents/:id` permalink. Cached 5 min. |
| GET | `/status/incidents/:id` | Public incident permalink (HTML). Mirrors the `/api/v1/public/incidents` visibility gate — only renders when the incident's `visibility='public'` AND `public_title` is set. Returns 404 with the same shell otherwise (no information leak about whether the id exists). Linked from each card on `/status`. |

## Public API v1

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/public/stats` | Platform statistics. Flat numeric fields (`total_threats`, `active_threats`, `brands_monitored` [count], `active_feeds`, `threat_campaigns`, `providers_mapped`, …) power the legacy SPA. Also returns the **marketing homepage shape** as formatted strings (consumed by `averrow-marketing/scripts/fetch-stats.mjs` at build time): `agents_deployed` (registered-agent-registry count, stable "42"), `feeds_protecting` (e.g. "45+"), `threats_detected` (e.g. "210K+"), `brands_monitored_label` (e.g. "9.6K+" — distinct from the numeric `brands_monitored`), `uptime_label`, `detection_time_label`. |
| GET | `/api/v1/public/geo` | Geographic threat distribution |
| GET | `/api/v1/public/feeds` | Feed status overview |
| POST | `/api/v1/public/assess` | Domain assessment |
| POST | `/api/v1/public/leads` | Lead capture |
| POST | `/api/v1/public/monitor` | Monitor request |
| GET | `/api/v1/public/email-security/:domain` | Public email security check |
| GET | `/api/v1/public/platform-status` | Platform uptime rollup (no auth) — feeds Home banner + Phase 3 public status page. Same payload as `/api/admin/platform-status`. KV-cached 60s. Returns the `PlatformStatus` body directly (never the `{success,error}` envelope); on a compute failure it returns HTTP 200 with a `PlatformStatus`-shaped `overall:'outage'` fallback so consumers can always read a valid `overall`. |
| GET | `/api/v1/public/milestones/latest` | Most recently fired platform milestone (e.g. "1,000,000 threats ingested"). Drives the Home celebration banner. Public, polled every 5 min by clients. |
| GET | `/api/v1/public/incidents` | Public incidents feed for `/status`. Returns only rows with `visibility='public'` AND `public_title` set. Stripped to `id`, `title`, `details`, `status`, `severity`, `affected_components`, `started_at`, `resolved_at`, `updates[]`. Internal title/description never exposed. |

## Dashboard

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/dashboard/overview` | Staff | Dashboard overview stats |
| GET | `/api/dashboard/top-brands` | Staff | Top targeted brands |
| GET | `/api/dashboard/providers` | Staff | Provider summary |
| GET | `/api/dashboard/stats` | User | Dashboard statistics |
| GET | `/api/dashboard/sources` | User | Threat source breakdown |
| GET | `/api/dashboard/trend` | User | Threat trend data |
| GET | `/api/dashboard/brand-admin` | Staff | Brand-scoped admin dashboard |

## Search

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/search` | Staff | Unified type-ahead search across five groups — brands, threat_actors, hosting_providers, campaigns, and app_store (global scope — not org-filtered). `?q=` (min 2 chars; shorter returns empty groups), `?limit=` (default 8; hard-capped at 5 per group). Every match is a prefix lookup (`name`/`canonical_domain LIKE 'q%'`, backed by the additive name indexes from migration 0236) — never a leading wildcard, never scans the 691K-row `threats` table; brand counts come from the pre-computed `brands.threat_count` column. Returns `{ success: true, data: { brands, threat_actors, providers, campaigns, app_store } }`, each item shaped `{ type, id, label, sublabel }`. The `app_store` group (Tier-2, migration 0237) prefix-matches `app_store_listings.app_name` (a NOT NULL app title, backed by the NOCASE `idx_app_store_listings_app_name` index); `type='app_store'`, `label`=app name, `sublabel`=developer name (falls back to store), `id`=the **owning brand_id** (reserved for a future brand-apps deep-link) — there's no per-listing detail view and BrandDetail has no `apps` tab yet, so a palette hit currently routes to the `/apps` overview. The Tier-2 no-page entities `dark_web` (no clean prefix title — only opaque source identifiers / a JSON matched-terms blob) and `trademark` (brand-organized surface, no stable mark-text column) are intentionally excluded, as are `alerts` (events, not named entities). Whole grouped result cached ~90s in KV. Supersedes `/api/admin/brands/search` for palette/type-ahead use (see note below). |

## Brands

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/brands` | Staff | List all brands |
| GET | `/api/brands/top-targeted` | Staff | Top targeted brands (with trends) |
| GET | `/api/brands/monitored` | Staff | Monitored brands |
| GET | `/api/brands/stats` | Staff | Brand aggregate statistics |
| GET | `/api/brands/movers` | Staff | 7-day movers (rising / falling by active threat delta) |
| GET | `/api/brands/aggregate/composition` | Staff | Catalog composition aggregate (cachedValue, 5-min TTL) |
| GET | `/api/brands/aggregate/email-security` | Staff | Email-security posture aggregate across the catalog |
| GET | `/api/brands/aggregate/posture` | Staff | Brand posture aggregate |
| GET | `/api/brands/aggregate/pressure` | Staff | Threat-pressure aggregate |
| POST | `/api/brands/monitor` | Admin | Add brand to monitoring |
| DELETE | `/api/brands/monitor/:id` | Admin | Remove brand from monitoring |
| GET | `/api/brands/:id` | Staff | Get brand detail |
| GET | `/api/brands/:id/domains` | Staff | Domains associated with the brand |
| GET | `/api/brands/:id/firmographics` | Staff | Brand firmographic data (SEC/Wikidata enrichment) |
| GET | `/api/brands/:id/score-history` | Staff | Brand score snapshots over time (`brand_score_snapshots`) |
| GET | `/api/brands/:id/threats` | Staff | Brand's active threats |
| GET | `/api/brands/:id/threats/locations` | Staff | Threat geo locations |
| GET | `/api/brands/:id/threats/timeline` | Staff | Threat timeline |
| GET | `/api/brands/:id/providers` | Staff | Hosting providers for brand threats |
| GET | `/api/brands/:id/campaigns` | Staff | Campaigns targeting brand |
| GET | `/api/brands/:id/analysis` | Staff | Get AI brand analysis |
| POST | `/api/brands/:id/analysis` | Staff | Trigger AI brand analysis |
| POST | `/api/brands/:id/deep-scan` | Staff | Trigger deep scan |
| GET | `/api/brands/:id/report` | Staff | Generate brand report |
| POST | `/api/brands/:id/clean-false-positives` | Staff | Clean false positives |
| GET | `/api/brands/:id/safe-domains` | Staff | List safe/owned domains |
| POST | `/api/brands/:id/safe-domains` | Staff | Add safe domain |
| POST | `/api/brands/:id/safe-domains/bulk` | Staff | Bulk add safe domains |
| DELETE | `/api/brands/:id/safe-domains/:domainId` | Staff | Remove safe domain |
| GET | `/api/brands/:id/social-config` | Staff | Get brand social-monitoring config |
| PATCH | `/api/brands/:id/social-config` | Staff | Update brand social-monitoring config |
| GET | `/api/brands/:id/social-profiles` | Staff | List discovered social profiles for the brand |
| PATCH | `/api/brands/:id/social-profiles/:profileId` | Staff | Classify / update a discovered social profile |
| POST | `/api/brands/:id/discover-social` | Staff | Trigger social-link discovery for the brand |
| POST | `/api/brands/:id/social-profiles/:profileId/assess` | Staff | Re-assess a social profile |
| POST | `/api/brands/:id/compute-score` | Staff | Recompute brand threat score |

## Brand Profiles (RETIRED 2026-05-07)

> The `/api/brand-profiles*` endpoints were retired on 2026-05-07. All seven
> paths (POST/GET `/api/brand-profiles`, GET/PATCH/DELETE `/api/brand-profiles/:id`,
> POST/GET `/api/brand-profiles/:id/handles`) remain registered as tombstones that
> return `410 Gone` with a pointer to `/api/orgs/:orgId/brands`.
> See `docs/v3/BRAND_PROFILES_DEPRECATION.md`.

## Social Monitoring

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/social/monitor` | Staff | Social monitoring overview (all brands) |
| GET | `/api/social/monitor/:brandId` | Staff | Brand-specific monitoring results |
| GET | `/api/social/alerts` | Staff | Active impersonation alerts |
| POST | `/api/social/scan/:brandId` | Staff | Trigger immediate social scan |

## Threats

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/threats` | Staff | List threats (filterable). `q` matches indicator (domain/url/ip/ioc, LIKE) **or** exact threat `id` — lets pivots deep-link a specific threat via `?q=<id>`. |
| GET | `/api/threats/stats` | Staff | Threat statistics |
| GET | `/api/threats/recent` | Staff | Recent threats |
| GET | `/api/threats/correlations` | Staff | Threat correlations |
| GET | `/api/threats/geo-clusters` | Staff | Geographic clusters |
| GET | `/api/threats/attack-flows` | Staff | Attack flow visualization |
| GET | `/api/threats/heatmap` | Staff | Paginated, KV-cached threat heatmap data |
| GET | `/api/threats/aggregate` | Staff | Slice-aware catalog aggregate for the Threats Intel surface. Honors the same filters as the list endpoint; org-scope-gated so tenants get their own slice |
| GET | `/api/threats/inflow` | Staff | Stacked-area inflow series for the Threats page. Reads `threat_cube_status` (no raw threat COUNTs). Accepts `?window=24h\|7d` |
| GET | `/api/threats/:id` | Staff | Get threat detail |
| PATCH | `/api/threats/:id` | Admin | Update threat status |
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
| POST | `/api/feeds/:id/pause` | Admin | Manually pause a feed |
| POST | `/api/feeds` | — | Stub — always returns `501` ("Feed creation via API deferred to v2 admin module") |
| DELETE | `/api/feeds/:id` | — | Stub — always returns `501` ("Feed deletion via API deferred to v2 admin module") |
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
| GET | `/api/admin/agents/attribution-backlog` | Admin | Infrastructure clusters with no attributed actor (dismissed rows excluded), sorted by threat count. `?q=` searches name/ASNs/countries; `limit`/`offset` paginate; totals include a `dismissed` count. KV cached 60s. Powers the Admin "Attribution Backlog" queue. |
| POST | `/api/admin/clusters/:id/attribution` | Admin | Manually attribute a cluster: `{ actor_id }` sets `infrastructure_clusters.actor_id` and fans `threat_attributions` rows (source=`manual`, confidence=`confirmed`) out to every threat in the cluster. Audit-logged. |
| POST | `/api/admin/clusters/:id/attribution/dismiss` | Admin | Mark an unattributed cluster as humanly unattributable (`attribution_dismissed_at`) — it leaves the backlog queue; the cluster row is otherwise untouched. Audit-logged. |
| GET | `/api/admin/agents/approvals/pending` | Super Admin | List pending agent deployment approvals (AGENT_STANDARD §12.1, Phase 5.4a) |
| GET | `/api/admin/agents/approvals/:id` | Super Admin | Get an approval record |
| GET | `/api/admin/agents/approvals/:id/review-bundle` | Super Admin | Full review bundle for an approval |
| POST | `/api/admin/agents/approvals/:id/approve` | Super Admin | Approve an agent deployment |
| POST | `/api/admin/agents/approvals/:id/reject` | Super Admin | Reject an agent deployment |
| POST | `/api/admin/agents/approvals/:id/request-changes` | Super Admin | Request changes on an agent deployment |
| GET | `/api/admin/agents/:id/module-metadata` | Super Admin | AgentModule declared fields (supervision, budget, reads/writes, outputs) + current-month budget-vs-spend rollup for the agent detail UI (Phase 5.5) |
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
| GET | `/api/briefings` | Staff | List briefings |
| GET | `/api/briefings/latest` | Staff | Most recent briefing |
| GET | `/api/briefings/history` | Staff | Briefing history |
| GET | `/api/briefings/:id` | Staff | Get briefing detail |
| POST | `/api/briefings/generate` | Staff | Generate new briefing |

## Campaigns

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/campaigns` | Staff | List campaign clusters. Optional `?status=`, `?limit=` (max 100), `?offset=`, and `?q=` (prefix-anchored campaign-name search, min 2 chars, `LIKE 'q%'` backed by NOCASE `idx_campaigns_name` — powers unified-search "view all"). |
| GET | `/api/campaigns/stats` | Staff | Campaign statistics |
| GET | `/api/campaigns/:id` | Staff | Get campaign detail |
| GET | `/api/campaigns/:id/threats` | Staff | Campaign threats |
| GET | `/api/campaigns/:id/infrastructure` | Staff | Campaign infrastructure |
| GET | `/api/campaigns/:id/brands` | Staff | Brands targeted by campaign |
| GET | `/api/campaigns/:id/timeline` | Staff | Campaign timeline |

## Operations (NEXUS Clusters)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/v1/operations` | Staff | List active NEXUS operations/clusters |
| GET | `/api/v1/operations/stats` | Staff | Operations statistics |
| GET | `/api/v1/operations/:id/timeline` | Staff | Operation event timeline |
| GET | `/api/v1/operations/:id/threats` | Staff | Threats in operation cluster |

## Geopolitical Campaigns

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/campaigns/geo` | Staff | List geopolitical campaigns (optional `?status=active`) |
| GET | `/api/campaigns/geo/:slug` | Staff | Get geopolitical campaign by slug |
| GET | `/api/campaigns/geo/:slug/stats` | Staff | Live aggregate stats (total threats, 24h, 7d, brands, IPs, domains) |
| GET | `/api/campaigns/geo/:slug/threats` | Staff | Threats from adversary countries/ASNs (paginated) |
| GET | `/api/campaigns/geo/:slug/timeline` | Staff | Daily attack timeline with type breakdown |
| GET | `/api/campaigns/geo/:slug/brands` | Staff | Targeted brands heat map data |
| GET | `/api/campaigns/geo/:slug/asns` | Staff | ASN cluster analysis (marks known adversary ASNs) |
| GET | `/api/campaigns/geo/:slug/attack-types` | Staff | Attack type breakdown with severity counts |
| POST | `/api/campaigns/geo/:slug/assessment` | Staff | Generate AI assessment for the campaign |

## Providers

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/providers` | Staff | List hosting providers |
| GET | `/api/providers/stats` | Staff | Provider statistics |
| GET | `/api/providers/worst` | Staff | Worst providers (most threats) |
| GET | `/api/providers/improving` | Staff | Improving providers |
| GET | `/api/providers/movers` | Staff | 7-day movers (rising / falling by active threat delta) |
| GET | `/api/providers/:id` | Staff | Get provider detail |
| GET | `/api/providers/:id/threats` | Staff | Provider's threats |
| GET | `/api/providers/:id/brands` | Staff | Brands affected by provider |
| GET | `/api/providers/:id/timeline` | Staff | Provider timeline |
| GET | `/api/providers/:id/locations` | Staff | Provider locations |
| GET | `/api/providers/:id/clusters` | Staff | Infrastructure clusters on this provider (distinct from the cross-provider `/api/providers/clusters`) |

### Provider Endpoints v2

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/providers/v2` | Staff | Providers list with pre-computed columns (replaces v1 JOIN-based query) |
| GET | `/api/providers/intelligence` | Staff | Provider intelligence summary |
| GET | `/api/providers/clusters` | Staff | Provider infrastructure clusters |

## Email Security

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/email-security/stats` | User | Email security statistics |
| GET | `/api/email-security/scan-all` | Admin | Scan all monitored brands |
| GET | `/api/email-security/:brandId` | User | Get brand email security posture |
| GET | `/api/email-security/:brandId/history?limit=N` | User | Up to N most-recent scans with per-scan `protocols_passing` (0–4) for the brand-detail Surface tab posture sparkline |
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
| GET | `/api/lookalikes/:brandId` | Staff | List lookalike domains |
| POST | `/api/lookalikes/:brandId/generate` | Staff | Generate domain permutations |
| POST | `/api/lookalikes/:brandId/scan` | Staff | Scan lookalike domains |
| PATCH | `/api/lookalikes/:id` | Staff | Update lookalike status |

> **Page-content analysis fields (S2.4 / D6, migration 0243, additive).** The
> `GET /api/lookalikes/:brandId` rows (`SELECT *`) now also carry the
> deterministic page-phishing verdict written by the `lookalike_scanner` cron
> (`22 * * * *`): `page_fetched_at`, `page_http_status`, `page_phishing_score`
> (0–100), `page_signals` (JSON array of fired signal keys, e.g.
> `["credential_form","offdomain_form_exfil"]`), and `page_content_hash`
> (SHA-256 of the fetched HTML). All are `null` until the SSRF-safe fetcher
> (`lib/page-fetch.ts`) first analyzes the domain. No new endpoint; response is
> a superset of the prior shape. A credential-form-off-domain page escalates the
> row's `threat_level` (and the linked alert's severity) MEDIUM→HIGH/CRITICAL.

## App Store Impersonation Monitoring

iOS App Store impersonation scanner (Google Play + 3rd-party Android
stores planned). Findings are upserted into `app_store_listings` and
classified rule-based first; ambiguous rows are re-assessed by Haiku.
HIGH/CRITICAL impersonation findings create `alerts` rows of type
`app_store_impersonation` and fire an `alert.created` webhook.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/appstore/overview` | Staff | Cross-brand app-store dashboard: one row per monitored brand with severity-bucketed counts and schedule info. |
| GET | `/api/appstore/monitor/:brandId` | Staff | List app-store listings + schedule for a brand. Filters: `store`, `classification`, `severity`, `status`, `limit`, `offset`. |
| POST | `/api/appstore/scan/:brandId` | Staff | Trigger an immediate iOS scan + AI drain for this brand. |
| PATCH | `/api/appstore/:id` | Staff | Update a listing's `classification` or `status` (manual override, wins over AI/system). |
| PATCH | `/api/brands/:brandId/official-apps` | Staff | Replace the brand's `official_apps` allowlist. Matching existing rows auto-flip to `classification='official'`. |

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
| GET | `/api/darkweb/overview` | Staff | Cross-brand dashboard: one row per monitored brand with severity-bucketed counts and schedule info. Admin scope sees all; tenant scope sees `monitored_brands.added_by = :userId`. |
| GET | `/api/darkweb/mentions` | Staff | Cross-brand mentions list (org-scope aware) |
| GET | `/api/darkweb/mentions/:brandId` | Staff | List mentions + schedule for a brand. Filters: `source`, `classification`, `severity`, `match_type`, `status`, `limit`, `offset`. |
| POST | `/api/darkweb/scan/:brandId` | Staff | Trigger an immediate scan + AI drain for this brand. |
| PATCH | `/api/darkweb/:id` | Staff | Update a mention's `classification` or `status` (manual override, wins over AI/system). |
| GET | `/api/trademarks/overview` | Staff | Cross-brand trademark rollup: per-brand active asset count + finding counts (total/confirmed/likely/unknown/high_critical) + cross-brand totals. Admin scope sees all brands with trademark data; org scope sees its `org_brands` subset. Default page KV-cached 120s. Data from the Phase 1 correlation scanner (`scanners/trademark-monitor.ts`). |

**Classification values:** `confirmed`, `suspicious`, `false_positive`, `resolved`, `unknown`.
**Status values:** `active`, `resolved`, `false_positive`, `investigating`.
**Match types:** `brand_name`, `domain`, `executive`, `actor_alias`, `mixed`.

## Certificate Transparency

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/ct/certificates/:brandId` | Staff | List CT certificates |
| GET | `/api/ct/certificates/:brandId/stats` | Staff | CT statistics |
| POST | `/api/ct/scan/:brandId` | Staff | Trigger CT scan |
| PATCH | `/api/ct/certificates/:id` | Staff | Update certificate status |

## Threat Narratives

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/narratives/:brandId` | Staff | List narratives for brand |
| GET | `/api/narratives/:brandId/:id` | Staff | Get narrative detail |
| POST | `/api/narratives/:brandId/generate` | Staff | Generate AI narrative |
| PATCH | `/api/narratives/:id` | Staff | Update narrative |

## Threat Assessment

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/brand/:brandId/threat-assessment` | Staff | Brand threat assessment |
| GET | `/api/brand/:brandId/threat-assessment/history` | Staff | Assessment history |
| GET | `/api/threat-feeds/stats` | Staff | Threat feed statistics |

## Alerts

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/alerts` | Staff | List alerts |
| GET | `/api/alerts/stats` | Staff | Alert statistics. Includes `auto_dismissed` (false_positive rows whose `resolution_notes` start with `auto`) for triage-transparency. |
| GET | `/api/alerts/triage-summary` | Staff | Auto-triage rollup (dismissed/kept counts) for the alerts surface |
| GET | `/api/alerts/:id` | Staff | Get alert detail |
| PATCH | `/api/alerts/:id` | Staff | Triage a signal. Body: `status` and/or `assigned_to` (a users.id, or `null` to unassign — stamps `assigned_at`), `notes`. At least one of status/assigned_to required. List returns `assigned_to_name`/`assigned_to_email`. |
| POST | `/api/alerts/bulk-acknowledge` | Staff | Bulk acknowledge alerts |
| POST | `/api/alerts/bulk-takedown` | Staff | Bulk create takedown requests from alerts |
| POST | `/api/admin/alerts/backfill-triage?limit=500&offset=0&threshold=0.5` | Admin | Auto-triage pass over `new` alerts. Dispatches by alert family: threat-sourced (VT/GSB/GreyNoise/SecLookup clean), social_impersonation (handle in official_handles or score < threshold), app_store_impersonation (developer in official_apps OR developer name normalizes to brand name OR score < threshold). Returns `{scanned, dismissed, kept, no_threat, by_type}`. **Use `offset` to advance through the queue across calls** — without it, batches with 0 dismissals will re-scan the same alerts forever. |
| POST | `/api/admin/alerts/run-ai-judge?limit=50&offset=0` | Admin | Tier 3 — runs Haiku second-opinion on `new` alerts that haven't been AI-judged yet (`ai_assessment IS NULL`). Stamps verdict + reasoning into `ai_assessment`. Auto-dismisses only when verdict='likely_safe' AND confidence >= 90. Returns `{scanned, judged, dismissed, kept, failed, by_verdict}`. ~$0.001 per alert. Idempotent. |
| POST | `/api/admin/notifications/cleanup-dismissed?lookback_hours=168&window_minutes=15&limit=1000` | Admin | Sweeps `notifications` for unread rows correlating (by `brand_id` + ±`window_minutes` of `created_at`) to recently auto-dismissed alerts (`resolution_notes LIKE 'auto:%'`). Marks matched notifications as `read`. Heuristic by design — alerts and notifications are not FK-linked. Returns `{alerts_checked, notifications_cleared}`. Idempotent. |

## Notifications

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/notifications` | User | List notifications. Query params: `state=inbox\|snoozed\|done\|all` (default `inbox` hides done + unexpired snoozed), `unread=true`, `type`, `severity`, `q`, `cursor`, `limit` |
| GET | `/api/notifications/unread-count` | User | Unread count |
| GET | `/api/notifications/preferences` | User | Notification preferences |
| PATCH | `/api/notifications/preferences` | User | Update preferences |
| POST | `/api/notifications/:id/read` | User | Mark as read |
| POST | `/api/notifications/read-all` | User | Mark all as read |
| POST | `/api/notifications/:id/snooze` | User | Snooze until ISO-8601 timestamp (body: `{until}`) |
| POST | `/api/notifications/:id/done` | User | Mark done (Linear-style fourth state) |
| GET | `/api/notifications/preferences/v2` | User | Per-channel severity floors + digest mode + super_admin opt-in (auto-seeds row if missing) |
| PUT | `/api/notifications/preferences/v2` | User | Patch any subset of v2 fields |
| GET | `/api/notifications/subscriptions` | User | List per-brand subscriptions joined with brand metadata |
| PUT | `/api/notifications/subscriptions/:brandId` | User | Set level (watching\|default\|ignored), optional `snoozed_until` |
| DELETE | `/api/notifications/subscriptions/:brandId` | User | Remove subscription |

### Web Push devices

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/notifications/config` | — | Push config bootstrap (VAPID public key). No auth — nothing user-specific |
| GET | `/api/notifications/devices` | User | Caller's push devices (`push_subscriptions`). Distinct from `/api/notifications/subscriptions` (per-brand watch levels) |
| POST | `/api/notifications/subscribe` | User | Register a PushManager subscription for the caller |
| DELETE | `/api/notifications/subscribe/:id` | User | Remove a push subscription by id |
| DELETE | `/api/notifications/unsubscribe` | User | Remove a push subscription by endpoint URL |
| POST | `/api/notifications/test` | User | Send a test push notification to the caller's devices |

## Trends

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/trends/volume` | Staff | Threat volume over time |
| GET | `/api/trends/types` | Staff | Threat type breakdown |
| GET | `/api/trends/brands` | Staff | Brand trend data |
| GET | `/api/trends/providers` | Staff | Provider trends |
| GET | `/api/trends/tlds` | Staff | TLD trends |
| GET | `/api/trends/compare` | Staff | Compare periods |
| GET | `/api/trends/intelligence` | Staff | Observer intelligence insights |
| GET | `/api/trends/threat-volume` | Staff | Threat volume by type over time window |
| GET | `/api/trends/brand-momentum` | Staff | Brand threat momentum (week-over-week) |
| GET | `/api/trends/provider-momentum` | Staff | Hosting provider momentum (7d/30d) |
| GET | `/api/trends/nexus-active` | Staff | Active accelerating Nexus clusters |

## Insights

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/insights/latest` | Staff | Latest AI insights |

## Signals

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/signals` | User | List signals |
| POST | `/api/signals` | Staff | Create signal |

## Scans

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/scan` | Staff (optional) | Trigger scan — works unauthenticated (rate-limited); a staff Bearer token attributes the scan to the caller |
| GET | `/api/scan/history` | Staff | Scan history |
| POST | `/api/brand-scan` | Staff | Brand exposure scan |
| GET | `/api/brand-scan/history` | Staff | Brand scan history |
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
| GET | `/api/trust-scores` | Staff | Trust score history |
| GET | `/api/social-iocs` | Staff | Social IOCs |

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
| PATCH | `/api/admin/abuse-mailbox/messages/bulk-status` | Super-admin | Bulk triage: `{ ids: string[], status }` — one UPDATE over up to 200 message ids (scoped to the Averrow self-org). Returns `{ requested, updated, status }`; unknown ids are skipped |
| PATCH | `/api/admin/abuse-mailbox/messages/:id/status` | Super-admin | Update message status (new / investigating / resolved / dismissed) — PR-BD |
| GET | `/api/admin/abuse-mailbox/intel` | Super-admin | Aggregated intel summary from `deep_analysis` rows: active campaigns, recent takedown recommendations, top hosting providers, 7d/30d analyzed counts (PR-BD) |
| POST | `/api/admin/abuse-mailbox/run-classifier` | Admin | Run the abuse-mailbox AI classifier over the pending pile (`?limit=&offset=`). Idempotent on retry; parse-failure rows stay `pending` |

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
| GET | `/api/admin/dashboard` | Admin | Tier 2a landing snapshot — ONE KV-cached composite (`admin:dashboard_snapshot:v1`, ~75s TTL) the `/admin` landing reads instead of fanning out to ~6 endpoints. Composes reused, already-cached slices (system-health, budget status+breakdown, feed at-risk, pipeline verdict, email-security). Each slice is independently nullable: a partial source failure degrades that slice to `null` (frontend treats null as "unknown", never "healthy"), never a 500. Additive — underlying endpoints unchanged. Warmed by Navigator Phase B. |
| GET | `/api/admin/pipeline-status` | Admin | Pipeline backlog counts with trend direction, owning agent, last run time. Reads from pre-computed backlog_history + agent_runs — no COUNT queries on threats. 5-min KV cache. |
| GET | `/api/admin/pipeline-status/:id` | Admin | Per-pipeline drill-down detail |
| GET | `/api/admin/metrics/d1-budget` | Admin | `/admin` Cost & Budget tab — D1 read/write budget section |
| GET | `/api/admin/metrics/ai-spend` | Admin | `/admin` Cost & Budget tab — AI spend breakdown. Returns `windows` (24h/7d/30d totals), `by_agent_30d` (legacy top-20-by-cost rows), `by_agent` (per-agent rows for ALL three windows, each with `out_in_ratio` = output/input), `daily_30d` (all-agent daily series), and `cartographer_daily_30d` (cartographer-only daily series). Superset that absorbs the cost-optimization per-agent/out:in/cartographer view. 4 `budget_ledger` scans, 5-min KV cache. |
| GET | `/api/admin/metrics/geo-coverage` | Admin | `/admin` Geo Coverage tab |
| GET | `/api/admin/metrics/feed-failures` | Admin | `/admin` Feeds tab — feed failure rates |
| GET | `/api/admin/health` | Admin | System health |
| GET | `/api/admin/budget/ledger-health` | Admin | Budget ledger fill diagnostic — surfaces per-call-site rows in the last 24h, flags any expected agentId that has not landed a row, and returns BudgetManager.getStatus() so operators can spot-check monthly_spend / throttle_level after the wrapper refactor. |
| GET | `/api/admin/metrics/ai-cost-optimization` | Admin | Measurement endpoint for the AI cost-reduction plan. Returns per-call efficiency metrics (calls, in/out tokens, cost) for the three focus agents (cartographer, analyst, sentinel) across 24h/7d/30d windows, plus cartographer's 30-day daily series + a static lever roster (id, title, target_agent, status, estimated_savings, indicator). No longer powers a UI panel — the standalone Cost Optimization tab was folded into AI Spend (`CostOptimization.tsx` deleted from `averrow-ops`); `/api/admin/metrics/ai-spend` now covers these metrics in-app (see that row above). Endpoint stays live to back the internal CLI route below. 5-min KV cache. |
| GET | `/api/internal/metrics/ai-cost-optimization` | AVERROW_INTERNAL_SECRET | Internal mirror of `/api/admin/metrics/ai-cost-optimization` for programmatic / CLI access (see `scripts/ai-cost-optimization.sh`). |
| GET | `/api/admin/platform-diagnostics` | Super Admin | Comprehensive platform diagnostics for programmatic consumption. Returns enrichment pipeline state (stuck pile, cartographer queue, enriched counts), per-feed failure rates with auto-pause risk, per-agent run counts, backlog trends, AI spend, cron health, stalled agents. Accepts `?hours=N` (default 6, max 48). |
| GET | `/api/internal/platform-diagnostics` | AVERROW_INTERNAL_SECRET | Same as above, accessible via `Authorization: Bearer $AVERROW_INTERNAL_SECRET` for programmatic/CLI access without JWT. |
| GET | `/api/admin/platform-status` | Super Admin | 30-day rolling uptime rollup across three categories (Feeds, Agents, Processing) plus a realtime (last-6h) state for the Home banner. Replaces the static "ALL SYSTEMS OPERATIONAL" lie that hid the 50cb1e4 ingest blackout. Cached 60s in KV; pass `?refresh=1` to bypass. Used by the Home banner and (Phase 3) public status page. |
| GET | `/api/internal/platform-status` | AVERROW_INTERNAL_SECRET | Same as above, accessible via `Authorization: Bearer $AVERROW_INTERNAL_SECRET` for the averrow-mcp server and the (Phase 3) public status page Worker. |
| GET | `/api/admin/notification-delivery-audit` | Super Admin | Per-channel delivery audit for platform_* notifications. Reads `notification_deliveries` (migration 0131) and reports which channels (in_app / push / email) succeeded, failed, or were skipped per notification, plus a `delivery_health` rollup and a `stale` flag for unread platform alerts older than 6h. Built after 50cb1e4 to verify platform alerts actually reach humans. Accepts `?days=N` (default 7, max 30). |
| GET | `/api/internal/notification-delivery-audit` | AVERROW_INTERNAL_SECRET | Same as above for programmatic / MCP access. |
| POST | `/api/admin/integrations/rewrap` | Super Admin | One-shot bulk re-encryption of `org_integrations.config_encrypted` with the current `INTEGRATION_CONFIG_KEY`. Idempotent: legacy plaintext rows are wrapped, already-v1 rows round-trip with a fresh nonce. Returns `{ total, rewrapped, already_v1, errors[] }`. Run once after deploying WS-B #4; safe to re-run. |
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
| POST | `/api/admin/leads/:id/qualified-report` | Super Admin | Generates a sales-qualified Brand Risk Plan for a `scan_leads.id`. Aggregates active threats, infrastructure (hosting providers, countries, campaigns), email security posture, lookalike inventory; calls Haiku for the threat actor briefing + remediation plan; computes ROI projection. Email posture is re-scanned at build time when the cached `email_security_scans` row is older than 14 days (time-boxed, falls back to cached values). Returns `share_url` (token-gated, 30-day TTL), `risk_grade`, `expires_at`. |
| GET | `/qualified-report/:token` | (token only) | Public view of a generated qualified report. Token is a 32-byte URL-safe random id from the generate response; presence + non-expired = access. Returns server-rendered HTML with print-friendly styling. |
| POST | `/api/admin/leads/:id/outreach` | Super Admin | Sends a templated outreach email to the lead's email via Resend (from `sales@averrow.com`). Embeds the most recent qualified-report share URL + risk grade + top 3 key findings. Returns 400 if no active qualified report exists for the lead. Updates `scan_leads.outreach_sent_at` + `outreach_email_id`. |
| POST | `/api/admin/leads/:id/qualified-report/renew` | Super Admin | Renews the most recent qualified report for a `scan_leads.id`: rebuilds the payload with fresh data and re-stamps `expires_at` to 30 days out, **keeping the existing `share_token`** so a link already sent to the prospect stays alive through a long sales cycle. Returns 404 if no report has ever been generated for the lead. Returns `{ report_id, share_url, share_token, expires_at, risk_grade, renewed: true }`. |
| POST | `/api/admin/leads/:id/report-and-outreach` | Super Admin | One-click: generates a fresh qualified report AND emails it to the prospect in a single call (composes the generate + outreach handlers). On generate failure, returns that error and does not send. Otherwise returns the outreach response (`sent_to`, `email_id`, `share_url`). |
| POST | `/api/admin/leads/:id/convert-to-tenant` | Super Admin | Converts a qualified lead into a tenant organization. Creates `organizations` row + adds super_admin as owner-role `org_members` row + correlates/creates brand row + adds to `monitored_brands` for tenant scope. Updates `scan_leads.status='converted'`. Returns `{ org_id, slug, invite_code, brand_id, brand_was_created }`. |
| GET | `/api/internal/system-health` | AVERROW_INTERNAL_SECRET | Internal mirror of `/api/admin/system-health` for MCP server access. |
| GET | `/api/internal/pipeline-status` | AVERROW_INTERNAL_SECRET | Internal mirror of `/api/admin/pipeline-status` for MCP server access. |
| GET | `/api/internal/stats` | AVERROW_INTERNAL_SECRET | Internal mirror of `/api/admin/stats` for MCP server access. |
| GET | `/api/internal/budget/status` | AVERROW_INTERNAL_SECRET | Internal mirror of `/api/admin/budget/status` for MCP server access. |
| GET | `/api/internal/budget/ledger-health` | AVERROW_INTERNAL_SECRET | Internal mirror of `/api/admin/budget/ledger-health` for MCP server access. |
| GET | `/api/internal/agents/:name/health` | AVERROW_INTERNAL_SECRET | Internal mirror of `/api/agents/:name/health` for MCP server access. |
| GET | `/api/admin/users` | Admin | List users (`?q=` name/email search, `?role=`, `?status=`, `limit`/`offset`; `total` respects the active filters). Consumed by the Platform Users admin page (`/admin/platform-users`, Governance → Users tab) |
| PATCH | `/api/admin/users/:id` | Admin | Update user |
| GET | `/api/admin/sessions` | Admin | Active sessions |
| POST | `/api/admin/users/:id/force-logout` | Admin | Force logout user |
| GET | `/api/admin/invites` | `manage_invites` (sales, admin, super_admin) | List invites |
| POST | `/api/admin/invites` | `manage_invites` (sales, admin, super_admin) | Create invite. Handler-level check: only super_admin may invite `admin` / `super_admin` roles. |
| DELETE | `/api/admin/invites/:id` | `manage_invites` (sales, admin, super_admin) | Revoke invite |
| GET | `/api/admin/audit` | Admin | Audit log (filters: `outcome`, `action`, `resource_type`, `window`, `search`, `since`/`until`, `limit`/`offset`). Response includes `stats` (today / failures / denied / unique_actions) and `resource_types`, computed over the FULL filtered set — the UI stat cards and resource-type filter no longer derive from the visible page |
| GET | `/api/admin/audit/export` | Admin | Export audit log |
| GET | `/api/admin/brands` | Admin | List all brands (admin) |
| POST | `/api/admin/brands/bulk-monitor` | Admin | Bulk add brands |
| POST | `/api/admin/brands/bulk-delete` | Admin | Bulk delete brands |
| GET | `/api/admin/sales-leads` | Sales+ | List sales leads (filters: `status`, `pitch_angle`, `identified_by`, `min_score`, `max_score`, `sort`, `limit` (max 500), `offset`) |
| GET | `/api/admin/sales-leads/stats` | Sales+ | Lead statistics |
| GET | `/api/admin/sales-leads/:id` | Sales+ | Get lead detail |
| PATCH | `/api/admin/sales-leads/:id` | Sales+ | Update lead |
| POST | `/api/admin/sales-leads/:id/approve` | Sales+ | Approve lead |
| POST | `/api/admin/sales-leads/:id/send` | Sales+ | Send outreach |
| POST | `/api/admin/sales-leads/:id/respond` | Sales+ | Record response |
| POST | `/api/admin/sales-leads/:id/book` | Sales+ | Book demo |
| POST | `/api/admin/sales-leads/:id/convert` | Sales+ | Convert to customer |
| POST | `/api/admin/sales-leads/:id/decline` | Sales+ | Decline lead |
| DELETE | `/api/admin/sales-leads/:id` | Super Admin | Delete lead (irreversible — also deletes activity log) |
| GET | `/api/admin/sales-leads/:id/activity` | Sales+ | Lead activity log |
| POST | `/api/admin/sales-leads/:id/refresh-firmographics` | Sales+ | Re-run SEC/Wikidata enricher for this lead's brand and copy the refreshed firmographic + buying-signal data onto the lead snapshot. Cheap (no AI). |

"Sales+" = `requireSales` guard (sales, admin, super_admin). Permission-flag auth values (e.g. `manage_invites`, `read_customers`) mean the route is gated via `requirePermission(flag)` per the matrix in `lib/role-permissions.ts`; admin + super_admin always qualify.
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
| POST | `/api/admin/geoip/import-from-r2` | Admin | Kick a GeoIP import workflow from a pre-staged R2 object (`?key=<r2-object-key>&sha256=<hash>`). Returns 202 with the workflow instance id; poll `/api/admin/geoip-status` for progress. |
| POST | `/api/admin/backfill-brand-match` | SuperAdmin | Backfill brand matching |
| POST | `/api/admin/backfill-brand-enrichment` | Admin | Populate brand logo_url, website_url, hq_lat/lng/country via Clearbit + DNS + ipapi (50/call) |
| POST | `/api/admin/backfill-brand-sector` | Admin | Classify brand sector via Haiku + fetch RDAP registrant data (20/call) |
| POST | `/api/admin/backfill-safe-domains` | SuperAdmin | Backfill safe domains |
| POST | `/api/admin/backfill-ai-attribution` | SuperAdmin | Backfill AI attribution |
| POST | `/api/admin/backfill-social-config` | SuperAdmin | Backfill brand social-monitoring config |
| GET | `/api/admin/brand-candidates` | Admin | List brand candidates awaiting promotion |
| POST | `/api/admin/brand-candidates/aggregate` | Admin | Aggregate candidate brands from threat data |
| POST | `/api/admin/brand-candidates/:id/promote` | Admin | Promote a candidate into the brand catalog |
| POST | `/api/admin/brand-candidates/:id/reject` | Admin | Reject a brand candidate |
| POST | `/api/admin/brand-scores/recompute-all` | Admin | Recompute brand scores across the full catalog (same path as the daily `brand_scores` cron) |
| POST | `/api/admin/brand-firmographics/enrich` | Admin | Run the SEC/Wikidata firmographics enricher batch |
| POST | `/api/admin/import-tranco` | SuperAdmin | Import Tranco top sites |
| POST | `/api/admin/honeypot/generate` | SuperAdmin | Generate honeypot sites |
| POST | `/api/admin/cube-backfill` | Admin | Backfill `threat_cube_geo` / `threat_cube_provider` OLAP tables via streaming NDJSON. Query params: `cube=geo\|provider\|brand\|all` (required), `days=1..365` (default 30), `dry_run=true\|false`, `resume_from=<hour_bucket>`. Returns one NDJSON line per hour plus a summary line with `resume_from` if the 25s budget is hit. |
| GET | `/api/admin/system-health` | Super Admin | System health dashboard. KV-cached ~120s (whole payload); threat total/today/week counts via `cachedCount` (`count.threats.total` reuses the canonical 3600s key shared with `/api/admin/stats`; today/week at 300s), 14-day trend via `cachedValue` (300s), reads on a read replica. A `today<=week<=total` clamp is applied at assembly to guard against the independently-expiring counts drifting out of order. Route gate is `requireSuperAdmin` (strict — not satisfied by plain `admin`); the `/api/admin/dashboard` composite reuses this handler and gates its `threat_health` slice to super_admin accordingly (see that row above). |
| GET | `/api/admin/budget/status` | Admin | AI budget status and spend |
| GET | `/api/admin/budget/breakdown` | Admin | Budget breakdown by agent |
| PATCH | `/api/admin/budget/config` | Super Admin | Update AI budget config (monthly cap, throttle thresholds) |
| GET | `/api/admin/organizations` | `read_customers` (analyst, sales, support, admin, super_admin) | List all organizations |
| POST | `/api/admin/organizations` | Super Admin | Create organization |
| GET | `/api/admin/organizations/:orgId` | `read_customers` (analyst, sales, support, admin, super_admin) | Get organization detail |
| PATCH | `/api/admin/organizations/:orgId` | Super Admin | Update organization |
| GET | `/api/admin/organizations/:orgId/abuse-branding` | `read_customers` (analyst, sales, support, admin, super_admin) | Tier 3: abuse-mailbox responder branding for the org — returns `{ stored, resolved, alias }` (stored row, defaults-merged/validated branding the responder would use, and the org's primary inbound alias) |
| PUT | `/api/admin/organizations/:orgId/abuse-branding` | Super Admin | Tier 3: upsert per-org responder branding (from_name / product_name / tagline / accent_color / header_bg_color / logo_url / logo_alt / subject_prefix / website_url / website_label / report_url / report_label / footer_note / enabled). Envelope From stays on Averrow's authenticated domain; only display name + look are branded. Invalid fields degrade to the Averrow default at render time |
| POST | `/api/admin/organizations/:orgId/abuse-alias` | Super Admin | Tier 3: provision (idempotent) the per-tenant `verify-<slug>@averrow.com` inbound abuse alias. Optional `{ slug }` override; reports a collision rather than hijacking an existing alias |
| GET | `/api/admin/brands/search` | Super Admin | Legacy single-entity admin picker for org assignment (`useBrandSearch` → CreateOrg/SuperAdminOrgs pickers). `?q=` substring `LIKE '%q%'` over `brands.name`/`canonical_domain`, `?limit=` (default 10, cap 50); `threat_count` reads the pre-computed `brands.threat_count` column (no `threats` JOIN/`GROUP BY`), on a read-replica session. Returns `{ success: true, data: [{ id, name, canonical_domain, sector, threat_count }] }`. General type-ahead/palette use goes through `/api/search` (see Search section above); this endpoint stays live for the org-assignment call sites. |
| GET | `/api/admin/leads` | Admin | List leads |
| GET | `/api/admin/leads/:id` | Admin | Single `scan_leads` row + live customer intel snapshot for the drill-down. Threats aggregated by `target_brand_id` (indexed); email security (SPF/DMARC/MX) from latest `email_security_scans` by domain; plus `platform_history` — "have we seen this domain before?" (known brand id/name/sector/first_seen/all-time threat count for linking to `/brands/:id`, and the most recent public `assessments` grade/score). All indexed/precomputed reads, no AI, no full-table scans. Returns `{ lead, intel }`; `intel` is best-effort and may be `null` (lead has no domain, or an aggregation hiccup) — the lead itself always returns when it exists. |
| PATCH | `/api/admin/leads/:id` | Admin | Update lead |
| GET | `/api/admin/takedowns` | `manage_takedowns` (analyst, admin, super_admin) | List takedowns across orgs. **`?scope=`** splits the queue into two purpose-scoped Ops surfaces (S2.3): `authorized` (**default**) → `org_id IS NOT NULL` (opted-in customer takedowns, SOC execution view); `prospect` → `org_id IS NULL` (orgless Sparrow drafts, sales/pitch lane); `all` → both. Equality filters: `status`, `org_id`, `severity`, `target_type`, `brand_id` (S2.3 — server-side per-brand pitch view). Plus `search`, `sort` (`priority`\|`newest`\|`brand`), `limit`, `offset`. Response `status_counts` (`GROUP BY status`) is scoped to the active `scope` + any `brand_id` — the stat cards reflect the current surface, not authorized+prospect combined — and the active `scope` is echoed back in the response body. Orgless prospect data stays behind `manage_takedowns`; no tenant/public exposure. |
| GET | `/api/admin/takedowns/integrations` | `manage_takedowns` (analyst, admin, super_admin) | Per-submitter integration health (NetBeacon/GoDaddy/Web Risk/email): configured?, live status, submissions / success rate / last error over `?hours=` window (default 168, max 720) |
| GET | `/api/admin/takedowns/metrics` | `manage_takedowns` (analyst, admin, super_admin) | **Ops-only** takedown-effectiveness metrics (S2.1). Returns `{ overall: { resolution_time (p50/p90/avg hours+days over requests with both `submitted_at` and `resolved_at`), success_rate (**true-removal**: `success_rate_pct` = `taken_down` / (`taken_down`+`refused`+`expired`) via `effective_denominator` — provider-adjudicated outcomes only, `withdrawn`+`other` excluded; `denominator` = all resolved terminals for volume; **includes SOC-initiated `org_id` NULL** takedowns; plus raw taken_down/refused/expired/withdrawn counts), dispatch (secondary — `takedown_submissions.outcome`, submitted+queued vs failed+rejected) }, monthly[] (submitted vs resolved per `%Y-%m`, last 12 months), by_provider[] }`. Read-replica session + `cachedValue` (300s, key `takedowns.metrics.overall`). **Not wired to public/marketing — customer-facing figures gated on owner sign-off (S1.5).** |
| PATCH | `/api/admin/takedowns/:id` | `manage_takedowns` (analyst, admin, super_admin) | Update takedown status |
| POST | `/api/admin/takedowns/:id/submit` | `manage_takedowns` (analyst, admin, super_admin) | **TK2 (S2.2)** — analyst hand-submit. Single-takedown, human-triggered sibling of Sparrow Phase G's auto-submit: dispatches the takedown to its abuse provider via `dispatchSubmission`, inheriting `TAKEDOWN_SEND_MODE` (draft/`queued` under the default non-live mode — no new live-send surface). Re-runs the **full standing/consent gate set** and never bypasses it: owning org (orgless → **422**), org owns the target brand (**403**), `module_key` present (**422**), active signed authorization covering the module via `requireAuthorizationForModule` (**403**), signed monthly cap not spent via `isUnderMonthlyTakedownCap` (**409**). Drops **only** the automation gate — does **not** require `takedown_providers.auto_submit_enabled=1` and does **not** consult the auto/semi_auto policy (the staff user is the decision). Idempotent: only `draft`/`requested` are submittable; already-submitted/terminal or an existing `submitted`/`queued` submission → **409**. Provider dispatch `failed`/`rejected` → **502** (status not advanced, retryable). Success flips `status→submitted`, stamps `submitted_by`, writes an `admin_takedown_submit` audit-log row (WHO), and emits `takedown.status_changed`. Returns `{ takedown_id, status, outcome, submitter_kind, submission_id, provider }`. |
| GET | `/api/admin/pricing/plans` | `view_billing` (sales, billing, admin, super_admin) | List pricing plans |
| GET | `/api/admin/pricing/modules` | `view_billing` (sales, billing, admin, super_admin) | List module prices |
| PATCH | `/api/admin/pricing/plans/:planId` | `edit_pricing` (sales, billing, admin, super_admin) | Update a pricing plan (display name, price, trial days, included modules, Stripe price id, active flag, sort order) |
| PATCH | `/api/admin/pricing/modules/:moduleKey` | `edit_pricing` (sales, billing, admin, super_admin) | Update a module price |
| GET | `/api/admin/customers/:orgId/pricing` | `view_billing` (sales, billing, admin, super_admin) | Customer pricing summary (plan, module prices, active overrides, Stripe linkage) |
| POST | `/api/admin/customers/:orgId/pricing-overrides` | `edit_pricing` (sales, billing, admin, super_admin) | Create a pricing override. Body: `{ override_type: tier_price \| module_price \| discount_percent, reason (required), plan_id?, module_key?, custom_price_cents?, discount_pct?, effective_until? }` |
| PATCH | `/api/admin/customers/:orgId/pricing-overrides/:id` | `edit_pricing` (sales, billing, admin, super_admin) | Revoke a pricing override |
| POST | `/api/admin/discover-social-batch` | Super Admin | Run social discovery batch |
| POST | `/api/admin/pathfinder-enrich` | Super Admin | Pathfinder AI enrichment batch |
| POST | `/api/admin/orgs/:orgId/modules` | Super Admin (handler-enforced) | Activate / suspend a module on an org. Body: `{ module_key, action: activate\|suspend, trial_ends_at?, config_json? }` |
| POST | `/api/admin/orgs/:orgId/sync-plan-modules` | Super Admin (handler-enforced) | "Sync now": align an org's `org_modules` rows with its current `plan_id` (for enterprise/custom-billed orgs that bypass the Stripe webhook path) |
| POST | `/api/admin/orgs/sync-all-plan-modules` | Super Admin (handler-enforced) | Bulk-sync every org with a `plan_id` (companion to the 0164 backfill). Idempotent |
| POST | `/api/admin/orgs/:orgId/takedown-authorization` | Super Admin (handler-enforced) | Record a signed takedown authorization on a tenant's behalf (support-style cases) |
| POST | `/api/admin/push/generate-vapid-keys` | Super Admin | Generate a VAPID key pair for the Web Push backend (bootstrap) |
| GET | `/api/admin/push/config` | Super Admin | Read Web Push config |
| PUT | `/api/admin/push/config` | Super Admin | Update Web Push config |
| POST | `/api/admin/push/test` | Super Admin | Send a test push to the caller |

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
| POST | `/api/orgs/:orgId/transfer-ownership` | Owner (org) | Atomically demote the current owner to `admin` and promote the target member to `owner`. Body: `{ new_owner_user_id }` |
| GET | `/api/orgs/:orgId/invites` | Admin (org) | List outstanding invites |
| DELETE | `/api/orgs/:orgId/invites/:inviteId` | Admin (org) | Revoke an invite |
| POST | `/api/orgs/:orgId/invites/:inviteId/resend` | Admin (org) | Resend an outstanding invite email |
| GET | `/api/orgs/:orgId/brands` | Member | List brands assigned to the org |
| POST | `/api/orgs/:orgId/brands` | Admin (org) | Assign a brand to the org |
| DELETE | `/api/orgs/:orgId/brands/:brandId` | Admin (org) | Unassign a brand |
| GET | `/api/orgs/:orgId/api-keys` | Admin (org) | List API keys |
| POST | `/api/orgs/:orgId/api-keys` | Admin (org) | Create API key |
| DELETE | `/api/orgs/:orgId/api-keys/:keyId` | Admin (org) | Revoke API key |
| GET | `/api/orgs/:orgId/integrations` | Admin (org) | List integrations (SIEM, SOAR, webhook) |
| GET | `/api/orgs/:orgId/integrations/activity` | Admin (org) | Recent data-out deliveries + opened/closed compliance tickets (proof / audit trail) |
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
| POST | `/api/orgs/:orgId/alerts/bulk` | Analyst+ | Bulk triage. Body: `alert_ids` (≤200), plus `status` and/or `assigned_to` (+ optional `notes`). Applies to the org-owned subset only; returns `{ updated }`. |
| PATCH | `/api/orgs/:orgId/alerts/:alertId` | Analyst+ | Triage a tenant signal. Body: `status` (acknowledged/investigating/resolved/false_positive) and/or `assigned_to` (a member user id, or `null` to unassign), `notes`. At least one of status/assigned_to required. `assigned_to` validated as an active org member. |
| GET | `/api/orgs/:orgId/alerts/:alertId` | Member | Single-signal detail for the Intelligence Card (deep-linkable). Same columns + brand JOIN as the list, plus `assigned_to_name`. Org-scoped via `org_brands`; 404 when the signal isn't owned by the org. |
| GET | `/api/orgs/:orgId/audit-log` | Analyst+ | Org-scoped audit trail (who/what/when of automation + human actions). Reads `AUDIT_DB.audit_log` filtered by `json_extract(details,'$.org_id')`; resolves actor names from the main DB; `ip_address`/`user_agent` not exposed. Params: `limit` (≤100), `offset`. Returns `{ data, total }`. |
| GET | `/api/orgs/:orgId/threats` | Member | Org-wide threat records across all org brands. Filters: `brand_id`, `status` (default `active`, or `all`), `severity`, `threat_type`, `q` (domain LIKE), `limit` (≤100), `offset`. Returns `{ data, total, severity_breakdown, type_breakdown }`. Default page is KV-cached 90s. |
| GET | `/api/orgs/:orgId/threats/:threatId` | Member | Single threat record — enrichment/infrastructure (DNS/WHOIS/certs + reputation) backing a threat-sourced signal's Intelligence Card. Same curated columns as the list. Org-scoped via `org_brands`; 404 when not owned/aged out. |
| GET | `/api/orgs/:orgId/investigations` | Member | List the org's investigations/cases. Optional `status` filter (open/monitoring/closed), `limit` (≤100), `offset`. Each row carries `item_count`, `note_count`, resolved `assigned_to_name`/`created_by_name`. Returns `{ data, total, status_breakdown }`. |
| POST | `/api/orgs/:orgId/investigations` | Analyst+ | Open a case. Body: `title` (required), `description`, `severity` (critical/high/medium/low), optional `items[]` (`{item_type, item_id, note?}`) to seed. Returns `{ id }`. |
| GET | `/api/orgs/:orgId/investigations/:investigationId` | Member | Case detail: the investigation + resolved linked `items[]` (label/severity/item_status per alert/threat/takedown) + `notes[]` timeline (with author names). Org-scoped; 404 when not owned. |
| PATCH | `/api/orgs/:orgId/investigations/:investigationId` | Analyst+ | Update a case. Body (any of): `title`, `description`, `status` (open/monitoring/closed — sets/clears `closed_at`), `severity`, `assigned_to` (active org member id, or `null`). |
| POST | `/api/orgs/:orgId/investigations/:investigationId/items` | Analyst+ | Link an item to the case. Body: `item_type` (alert/threat/takedown), `item_id`, `note`. Item ownership verified against the org's brands; `INSERT OR IGNORE` (idempotent). Returns `{ added }`. |
| DELETE | `/api/orgs/:orgId/investigations/:investigationId/items/:itemId` | Analyst+ | Unlink an item (the `:itemId` is the link-row id). |
| POST | `/api/orgs/:orgId/investigations/:investigationId/notes` | Analyst+ | Append a note to the case timeline. Body: `body`. Returns `{ id }`. |
| GET | `/api/orgs/:orgId/brands/:brandId/detail` | Member | Tenant brand detail |
| GET | `/api/orgs/:orgId/brands/:brandId/threats` | Member | Tenant brand threats |
| GET | `/api/orgs/:orgId/brands/:brandId/social-profiles` | Member | Tenant brand social profiles |
| GET | `/api/orgs/:orgId/brands/:brandId/monitoring-config` | Member | Get monitoring config |
| PATCH | `/api/orgs/:orgId/brands/:brandId/monitoring-config` | Admin (org) | Update monitoring config |
| POST | `/api/orgs/:orgId/takedowns` | Member | Create takedown request |
| GET | `/api/orgs/:orgId/takedowns` | Member | List takedown requests |
| GET | `/api/orgs/:orgId/takedowns/:id` | Member | Get takedown detail |
| PATCH | `/api/orgs/:orgId/takedowns/:id` | Admin (org) | Update takedown |
| GET | `/api/orgs/:orgId/takedown-authorization` | Member | Read the org's active takedown authorization |
| POST | `/api/orgs/:orgId/takedown-authorization` | Admin (org) | Sign a takedown authorization (org admin/owner or super_admin) |
| DELETE | `/api/orgs/:orgId/takedown-authorization` | Admin (org) | Revoke the active takedown authorization |

**Authorization `scope` shape** (`scope_json`, validated server-side, normalized on read/write):

```jsonc
{
  "modules": ["domain", "social", "app_store", "trademark", "abuse_mailbox", "threat_actor"],
  "max_takedowns_per_month": 500,            // or null = unlimited
  "escalation": "auto_resubmit_on_pivot",    // | "manual_only"
  "auto_followup_breached_sla_hours": 72,    // or null = off
  "high_risk_requires_per_takedown_approval": true,  // legacy; kept in sync with mode
  // ── automation level (Off / Semi-Auto / Auto) ──
  "mode": "semi_auto",                        // "off" | "semi_auto" | "auto"
  "semi_auto_rules": {                        // applied only when mode === "semi_auto"
    "auto_severities": ["LOW", "MEDIUM"],     // severities that auto-submit
    "auto_target_types": [],                  // [] = any (domain|social_profile|url|email|mobile_app)
    "auto_provider_types": []                 // [] = any (registrar|hosting|social_platform|cdn|email_provider|reporting)
  }
}
```

`mode` is the canonical posture (Sparrow Phase G + `lib/takedown-policy.ts`):
`off` never auto-submits, `auto` submits everything in scope, `semi_auto`
auto-submits only takedowns matching `semi_auto_rules` and holds the rest in
`draft` for human approval (which fires the `takedown_awaiting_approval`
notification). Legacy rows without `mode`/`semi_auto_rules` are backfilled on
read (`high_risk=true → semi_auto`, else `auto`).
| GET | `/api/orgs/:orgId/billing` | Member | Tenant billing summary — same shape as `/api/admin/customers/:orgId/pricing` but scoped to the caller's org |
| POST | `/api/orgs/:orgId/billing/checkout-session` | Org admin | Create a Stripe Checkout session for plan purchase (org-admin+; viewers cannot start a subscription change) |
| POST | `/api/orgs/:orgId/billing/portal-session` | Org admin | Create a Stripe customer-portal session (org-admin+; portal can cancel/change plan/view invoices, so it is not viewer-accessible; requires an existing Stripe customer) |

### Tenant Modules (v3 Phase A)

Module reads are member-gated and additionally check the module is active on the org.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/orgs/:orgId/modules` | Member | List the org's modules + per-module monthly usage |
| GET | `/api/orgs/:orgId/modules/domain` | Member | Domain module summary |
| GET | `/api/orgs/:orgId/modules/domain/brands/:brandId` | Member | Domain module per-brand detail |
| GET | `/api/orgs/:orgId/modules/social` | Member | Social module summary |
| GET | `/api/orgs/:orgId/modules/social/brands/:brandId` | Member | Social module per-brand detail |
| GET | `/api/orgs/:orgId/modules/app-store` | Member | App-store module summary |
| GET | `/api/orgs/:orgId/modules/app-store/brands/:brandId` | Member | App-store module per-brand detail |
| GET | `/api/orgs/:orgId/modules/dark-web` | Member | Dark-web module summary |
| GET | `/api/orgs/:orgId/modules/dark-web/mentions` | Member | Org-wide dark-web mentions list |
| GET | `/api/orgs/:orgId/modules/dark-web/brands/:brandId` | Member | Dark-web module per-brand findings |
| GET | `/api/orgs/:orgId/modules/abuse-mailbox` | Member | Abuse-mailbox module summary |
| GET | `/api/orgs/:orgId/modules/abuse-mailbox/messages` | Member | List the org's abuse-inbox messages |
| GET | `/api/orgs/:orgId/modules/abuse-mailbox/messages/:id` | Member | Abuse-inbox message detail |
| PATCH | `/api/orgs/:orgId/modules/abuse-mailbox/messages/:id/status` | Member | Update message status (new / investigating / resolved / dismissed) |
| GET | `/api/orgs/:orgId/modules/abuse-mailbox/intel` | Member | Aggregated abuse-mailbox intel summary for the org |
| GET | `/api/orgs/:orgId/modules/trademark` | Member | Trademark module summary |
| GET | `/api/orgs/:orgId/modules/trademark/brands/:brandId` | Member | Trademark module per-brand findings |
| POST | `/api/orgs/:orgId/modules/trademark/brands/:brandId/assets` | Org analyst+ | Upload a logo/wordmark image (JSON `{asset_type, asset_name?, content_type, data_base64, registration_*?}`, ≤2 MB). Stores bytes in R2, computes SHA-256, inserts a `trademark_assets` row (phash deferred to Phase 2). |
| GET | `/api/orgs/:orgId/modules/trademark/assets/:assetId/image` | Member | Auth-gated image stream for an uploaded asset (verifies the asset's brand belongs to the org). |
| DELETE | `/api/orgs/:orgId/modules/trademark/assets/:assetId` | Org analyst+ | Retire an asset + delete its R2 object. |
| GET | `/api/orgs/:orgId/modules/threat-actor` | Member | Threat-actor module summary |
| GET | `/api/orgs/:orgId/modules/threat-actor/actors/:actorId` | Member | Threat-actor module actor detail |

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
| POST | `/api/internal/agents/cartographer/main-workflow` | Dispatch the Cartographer main run as a durable Workflow (PR-M manual validation hook) |
| POST | `/api/internal/agents/campaign_hunter/workflow` | Dispatch Campaign Hunter as a durable Workflow (agentic investigation loop). Body: `{ brandName, brandDomain, brandId? }`. Returns `{ triggered, runId, instanceId }`; poll the run via the status endpoint below. |
| GET | `/api/internal/agents/campaign_hunter/status?run_id=...` | Poll a dispatched Campaign Hunter run — returns the `agent_runs` row (`status`, `completed_at`, `records_processed`, `error_message`). The investigation report lands in `agent_outputs` (type `insight`). |
| POST | `/api/internal/briefing/send` | Manually generate and email the daily briefing |
| POST | `/api/internal/cubes/brand-summaries/rebuild` | Out-of-band rebuild of the dark-web + app-store brand summary cubes (idempotent; use when you can't wait for cube_healer's 6-hour tick) |
| POST | `/api/internal/digest/weekly-tenant/run` | Manual trigger for the tenant weekly digest (S4). Optional JSON body: `org_id` (restrict to one org), `force` (bypass KV week-stamp dedup), `ignore_mode` (bypass `TENANT_DIGEST_MODE` for a supervised test send) |
| GET | `/api/internal/geoip-status` | MCP-callable mirror of `/api/admin/geoip-status` (getGeoMmdbStatus: row count, shadow progress, recent attempts) |
| POST | `/api/internal/geoip-refresh` | MCP-callable mirror of `/api/admin/geoip-refresh`. Body `{ "forceReload": true }` bypasses the skip-if-current guard |
| GET | `/api/internal/taxii/discover` | TAXII server discovery helper (`?root_url=&auth_type=&api_key_env=&username=`). Walks api_roots → collections and returns a flat inventory. Used by `scripts/taxii-discover.sh` |
| POST | `/api/internal/notifications/sweep-stale-platform` | Mark `platform_*` notifications older than `?olderThanMinutes` (default 60) as done |
| POST | `/api/internal/auth/mint-service-jwt` | Mint a 90-day service-account JWT for averrow-mcp UI verification tools |
| POST | `/api/internal/auth/mint-ui-preview-jwt` | Mint a SHORT-LIVED, LOW-PRIVILEGE JWT for Claude Code UI inspection. Params: `surface=staff\|tenant` (required); staff `role=auditor\|analyst\|admin` (default **auditor** — read-only global read; never super_admin); tenant `org_id=N` (optional, scopes to a real org); `ttl_minutes=N` (default 60, max 240). Returns `{ jwt, preview_url, expires_at, ttl_seconds, user_id, role, surface, org_id }`. Load `preview_url` (`…/v2/#token=…` or `…/tenant/#token=…`) in a browser to boot the SPA. Dedicated users `claude_ui_staff` / `claude_ui_tenant` (the `auditor` token is stored under a CHECK-valid `analyst` placeholder row; the JWT carries the real `auditor` role). **Kill switch:** `UPDATE users SET status='suspended' WHERE id IN ('claude_ui_staff','claude_ui_tenant');` |
| POST | `/api/internal/dns-queue/reap` | AVERROW_INTERNAL_SECRET. On-demand DNS-queue reaper (normally Navigator-dispatched daily at hour===0). Sweeps stale rows (threat flipped inactive) and attempt-capped/exhausted rows — marking their threats `dns_exhausted_at` and deleting the queue rows. Idempotent + soft-capped; safe to call repeatedly to drain a backlog. |
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
