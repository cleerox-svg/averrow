# API Reference

Complete reference for the Averrow API. All authenticated endpoints require a `Bearer` token in the `Authorization` header. Base URL: `https://acerrow.com`

## Authentication

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/auth/login` | — | Initiate Google OAuth login |
| GET | `/api/auth/invite` | — | Accept invite via token. An invite never changes an existing staff account's role: acceptance by an account where any matching row (Google sub or case-insensitive email) is staff with a role different from the invite's is refused (redirect to the error page, audited `invite_accept_refused_staff_role_change`, invite stays pending) — staff role changes go through `PATCH /api/admin/users/:id` only. Same-role re-acceptance works. An existing non-staff account whose role an invite changes (client → staff) gets `forced_logout:<id>` stamped (revoking pre-acceptance tokens, not the new session). The role write is pinned to the role read at lookup; a concurrent change refuses the acceptance. No tenant staff is also enforced in SQL against interleaving writes: a staff-role write matches 0 rows if the account gained an active customer org membership after the pre-check (refused, audited `invite_accept_refused_org_member`), and an org invite's `org_members` insert matches 0 rows if the account became staff after the pre-check (refused, audited `invite_accept_refused_staff_account`, no session issued). A refused acceptance leaves the invite pending. |
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
| POST | `/api/scan/public` | Public domain scan (rate-limited). New scans store no requester IP, city or coordinates: the `scans` row records the requester's **country only**, from Cloudflare's `request.cf.country` (`geo_country_code` + English `geo_country`; `XX`/`T1`/absent → null). No third-party geolocation lookup (the ipapi.co call was removed in PR-E, 2026-10). |
| POST | `/api/scan/report` | Generate brand exposure report |
| POST | `/api/brand-scan/public` | Public brand exposure scan |
| GET | `/api/brand-scan/public/:id` | Get public scan results |
| GET | `/api/stats/public` | Public platform statistics |
| POST | `/api/contact` | Contact form submission (unauthenticated). JSON body `{ name, email, message` (all required)`, company?, companySize?, interest?, company_website? }`. `company_website` is a **honeypot** — real users never fill it; a non-empty value is silently accepted (200) but never persisted. Per-IP rate-limited (5/hr → 429). `companySize` persists to `contact_submissions.company_size` (migration 0262). |
| POST | `/api/track` | Marketing analytics beacon (unauthenticated). JSON body `{ type: 'pageview'\|'click'\|'cta', page: string (starts with `/`, ≤255), ref?: string, ctaId?: string (≤64) }`. Referrer is classified server-side for AI-chat referral detection. Rate-limited per-IP (120/hr). Always responds **204** (invalid body → 400); insert runs via `ctx.waitUntil`. Raw IP is never stored (salted, truncated SHA-256 visitor hash). |
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
| POST | `/api/v1/public/assess` | Domain assessment (rate-limited by `CF-Connecting-IP` in KV only; the requester IP is not stored in `assessments` — PR-E, 2026-10) |
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
| GET | `/api/dashboard/top-brands` | Staff | Top targeted brands. Only the frozen legacy SPA (`public/app.js`) calls it; not pre-warmed |
| GET | `/api/dashboard/providers` | Staff | Provider summary |
| GET | `/api/dashboard/stats` | Staff | Legacy v1 scan aggregates, platform-wide counts only: `total_signals`, `processed`, `avg_trust`, `active_alerts`, `queue_depth`, `dead_letters`, `duplicates`, `stored`. No UI calls it any more. Was unauthenticated before 2026-10 (the docs wrongly said "User"). |
| GET | `/api/dashboard/sources` | Staff | Legacy v1 scan source mix, `[{ name, count, percentage }]` by scan source (`station-alpha/beta/gamma`). Aggregates only. No UI calls it any more. Was unauthenticated before 2026-10. |
| GET | `/api/dashboard/trend` | Staff | Legacy v1 scan volume and quality for the last 2h, `[{ time, count, quality }]`. Aggregates only. No UI calls it any more. Was unauthenticated before 2026-10. |
| GET | `/api/dashboard/brand-admin` | Staff | Brand-scoped admin dashboard |

## Observatory

Staff-only (`requireStaff` — analyst, sales, support, billing, auditor, admin, super_admin; `client` → 403, no token → 401). These routes were public until 2026-10: `/live` and `/arcs` carry targeted brand names and `/brand-arcs` accepted any `brand_id`, which exposed which customer brands were under attack. No public, marketing or tenant surface calls them; tenants use the org-scoped `/api/orgs/:orgId/*` routes. Navigator pre-warms the `observatory_*` KV keys by calling the handlers directly; those keys only ever back this staff audience. `source_feed` absent, empty (`source_feed=`, what the ops client sends for "All Sources") and `all` are equivalent — no filter, one `…:all` cache key; `feeds` = everything except `spam_trap`, `spam_trap` = spam trap only, any other value = that exact feed.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/observatory/nodes` | Staff | Geo hotspot clusters from `threat_cube_geo` (`?period=24h\|7d\|30d`, `?source_feed=`) |
| GET | `/api/observatory/arcs` | Staff | Country-to-brand attack corridors from `threat_cube_arcs`. Includes `brand_name` per arc |
| GET | `/api/observatory/live` | Staff | Most recent active geolocated threats (`?limit=` up to 50), including malicious domain/URL and `target_brand` name |
| GET | `/api/observatory/brand-arcs` | Staff | Arcs targeting one brand (`?brand_id=` required, `?period=`) |
| GET | `/api/observatory/stats` | Staff | Observatory summary stats (`threats_mapped`, `threats_total`, `geo_coverage_pct`, `countries`, `active_campaigns`, `brands_monitored`) |
| GET | `/api/observatory/heatmap` | Staff | Global threat heatmap points (lat/lng/severity/threat_type) |
| GET | `/api/observatory/operations` | Staff | Active NEXUS clusters feed. No current ops/tenant caller (the Observatory side panel reads `/api/v1/operations?status=active`); not pre-warmed |

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
| GET | `/api/admin/agents/attribution-backlog` | Admin | Infrastructure clusters with no attributed actor (dismissed rows excluded), sorted by threat count. `?q=` searches name/ASNs/countries; `limit`/`offset` paginate; totals include a `dismissed` count. KV cached 60s (key `attribution-backlog:v3`). Each item carries `actor_hint` (boolean): true when the cluster's free text mentions a known `threat_actors` name/alias; hinted clusters are stably sorted to the top of the returned page (threat_count order kept within each group). Ordering hint only — nothing is attributed from it. Powers the Admin "Attribution Backlog" queue. |
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
| POST | `/api/briefings/generate` | Admin | Generate new briefing ("Run Briefing Now") and email it. `requireAdmin` (admin + super_admin); analyst/sales/support/billing/auditor get 403. Rate-limited 5/min per user. |

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
| GET | `/api/providers/:id` | Staff | Get provider detail |
| GET | `/api/providers/:id/threats` | Staff | Provider's threats |
| GET | `/api/providers/:id/brands` | Staff | Brands affected by provider |
| GET | `/api/providers/:id/timeline` | Staff | Provider timeline |
| GET | `/api/providers/:id/locations` | Staff | Provider locations |
| GET | `/api/providers/:id/clusters` | Staff | Infrastructure clusters on this provider (distinct from the cross-provider `/api/providers/clusters`) |

### Provider Endpoints v2

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/providers/v2` | Staff | Providers list with pre-computed columns (replaces v1 JOIN-based query). Query: `limit` (≤100, default 50), `offset`, `q`, `country`, `status` (`active`\|`accelerating`\|`pivot`\|`quiet`), `cluster_id`, `sort` (`active_threats` default \| `trend_7d` \| `trend_30d` \| `cooling`; unknown values fall back to `active_threats`). `sort=cooling` returns only providers whose last-7d new-threat count (`trend_7d`) is below their 30-day weekly average (`trend_30d × 7/30`, requires `trend_30d > 0`), ordered by `cooling_delta_7d` ascending (biggest drop first). Every row carries `cooling_delta_7d` = `ROUND(trend_7d − trend_30d × 7/30, 1)`. `trend_7d` / `trend_30d` are always non-negative counts (single writer `lib/provider-trends.ts`, refreshed every 4h by NEXUS; providers with no threats in the 30d window are zeroed, so they drop out of Cooling). Response `{ success, data, meta: { total, limit, offset } }`; KV 5 min, key encodes every param incl. `sort`. Replaces the retired `/api/providers/movers` "falling" list. |
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

> **Response columns are an explicit allowlist, not `SELECT *`.** Both response
> paths that return a whole `lookalike_domains` row — the `GET` list and the
> `PATCH` echo — select the columns named in `LOOKALIKE_LIST_COLUMNS`
> (`handlers/lookalikeDomains.ts`). **A new column on the table does NOT appear
> in this payload until it is added there**, and `test/lookalike-list-columns.test.ts`
> fails until it is. That is deliberate: under the previous `SELECT *` every
> column reached every staff caller with no review step, which is how
> `page_evidence` (verbatim attacker page content) and `page_exfil_sink` (a live
> C2 host) became part of the payload without anyone choosing to publish them.
> Adding a column means editing the allowlist AND the expected set in that test;
> if the tenant surface must not see it, confirm it is also absent from the
> tenant SELECT in `handlers/tenantDomainModule.ts`.

> **Page-content analysis fields (S2.4 / D6, migration 0243, additive).** The
> `GET /api/lookalikes/:brandId` rows now also carry the
> deterministic page-phishing verdict written by the `lookalike_scanner` cron
> (`22 * * * *`): `page_fetched_at`, `page_http_status`, `page_phishing_score`
> (0–100), `page_signals` (JSON array of fired signal keys, e.g.
> `["credential_form","offdomain_form_exfil"]`), and `page_content_hash`
> (SHA-256 of the fetched HTML). All are `null` until the SSRF-safe fetcher
> (`lib/page-fetch.ts`) first analyzes the domain. No new endpoint; response is
> a superset of the prior shape. A credential-form-off-domain page escalates the
> row's `threat_level` (and the linked alert's severity) MEDIUM→HIGH/CRITICAL.

> **`baseline_established_at` (migration 0267, additive) IS the first-contact
> discriminator.** Records when the scanner FIRST established this row's
> registration/MX/web baseline, which is not the same fact as `first_seen` (when
> the domain was observed to *appear*). A seeded row starts `registered = 0` by
> INSERT default, so on first contact `registered 0 → 1` says only "it
> resolves", never "it was just registered". Both columns may legitimately be
> set on one row (a baselined squat that lapses and is re-registered produces a
> real transition), so `first_seen IS NULL AND baseline_established_at IS NOT
> NULL` is how to ask "registered before we were watching". Staff-visible via
> `LOOKALIKE_LIST_COLUMNS`; absent from the tenant SELECT (crawl coverage is
> pipeline detail, same product call as `page_last_outcome`).
>
> **This column, not `last_checked`, is what the checker reads.** 0267 as first
> written called it "a RECORD of the decision, never its input" and left
> `last_checked IS NULL` as the discriminator — which gave `last_checked` three
> simultaneous jobs (last success, dueness, first contact), so every scheduling
> write was also a reclassification. That is how this endpoint's rescan came to
> *forge* first contact, and why it needed a `CASE` to work around a column it
> was not trying to affect. The discriminator now lives on a column nothing but
> the single-write `CASE` in the per-check UPDATE can reach, so no scheduling
> operation can forge it. 0267 carries a one-time
> `UPDATE ... SET baseline_established_at = last_checked WHERE
> baseline_established_at IS NULL AND last_checked IS NOT NULL` so pre-existing
> rows are not all misread as first contact on the first tick after deploy.

> **`lookalike_domain_active` alerts: a HIGH/CRITICAL floor and FOUR producers.**
> No alert row is created below HIGH — everything else is still persisted
> (`threat_level`, `ai_assessment`, the page columns), so the row is unchanged
> and only the notification is withheld. This *removed* previously-created
> MEDIUM alerts on genuine `registered 0 → 1` transitions; the floor is defined
> once in `lib/lookalike-alert-policy.ts` and shared. **Four** files file this
> alert type, across **five** configured sources (this paragraph said "three"
> and the policy module said a fourth was "a contradiction in terms" while
> `phantom-matcher.ts` — already in the repo — was filing it):
> **(1)** the registration checker (`scanners/lookalike-domains.ts`);
> **(2)** the page-analysis pass (`scanners/lookalike-page-analysis.ts`), only
> for a registered row with NO linked alert whose page clears the phishing bar,
> bounded per run and carrying `details.discovered_by = 'page_analysis'`;
> **(3)** the claim-time backfill (`lib/alert-backfill.ts`, reached from brand
> claim / lead conversion), which also imports the floor, files only for
> `registered = 1` rows, derives its severity from the row's already-composited
> `threat_level` rather than a hardcoded `medium`, and marks its output
> `details.discovered_by = 'claim_backfill'` — there is no backfill exemption
> from the floor; and **(4)** the phantom-hit matcher
> (`lib/phantom-matcher.ts`), from two of its three `SOURCE_CONFIG` entries
> (`nrd` and `lookalike`; the `ct` entry files `ct_certificate_issued` through
> the same call). Producer 4 is the **one documented exemption** from the
> floor: it files at `low` via `PHANTOM_MATCH_ALERT_SEVERITY`, imported from
> the policy module rather than hardcoded. Its bound is why that is
> affordable — **at most one alert per `phantom_domains` row, ever** (the
> guarded `WHERE id = ? AND status = 'predicted'` claim runs *before*
> `createAlert`), over a population written only by the manual-trigger
> `phantom_enumerator`. Applying the floor would instead either delete the
> phantom lane's only output or force a `high` severity that contradicts what
> a phantom hit means (W2.3 spec §6.1/§6.2).

> **`last_check_failed_at` (migration 0268, additive).** The DNS-check cooldown
> for an attempt that produced NO answer (resolver timeout / non-ok DoH
> response), as distinct from `last_checked`, which now means strictly "when a
> check last SUCCEEDED". `checkDomain` (`lib/domain-checker.ts`) returns a
> `resolved` flag for this, and an unresolved check writes no registration state
> at all — a transient failure can no longer flip `registered` 1 → 0 and make
> the next success read as a registration event. `last_checked` is deliberately
> NOT advanced on failure, because a failed attempt is not an observation. Since
> migration 0269 this column is a pure HISTORICAL RECORD: it is still written,
> but no selection predicate reads it — the backoff it used to express now lives
> in `check_due_at` / `check_attempts`, and
> `test/lookalike-sql-statements.test.ts` asserts that neither it nor
> `last_checked` appears in any cohort query's `WHERE`. Staff-visible via
> `LOOKALIKE_LIST_COLUMNS`; absent from the tenant SELECT.

> **Per-probe `answered` flags, and per-field writes (`lib/domain-checker.ts`).**
> `resolved` is scoped to `registered` **and nothing else** — a *seen* A record
> short-circuits it, so `resolved: true` is compatible with an MX probe that
> timed out, an A probe that timed out, and a web probe that was never
> attempted. `DomainCheckResult` therefore carries `aAnswered` / `mxAnswered` /
> `webAnswered` alongside it, and a caller that PERSISTS a field must not write
> one whose flag is false. The web probe had **no** flag at all: both HEAD
> attempts ended in a bare `catch {}`, so a 3 s timeout, a TCP reset, a TLS
> failure and a tarpit were indistinguishable from "serves nothing" and were
> written as `has_web = 0`. A 403/404/redirect **does** count as answered (the
> `fetch` resolved); only connection-level failure does not.
> `checkLookalikeBatch`'s per-check UPDATE now gates `resolves_to`, `has_mx`
> and `has_web` on their own flags via bound `CASE WHEN ? = 1 THEN ? ELSE
> <column> END` arms, so an unanswered probe keeps the last answering probe's
> value. This matters beyond data quality: both page-analysis cohorts require
> `has_web = 1 AND resolves_to IS NOT NULL`, and the page pass is the only
> producer that can still alert on a row whose `registered === 0` one-shot has
> already fired — so erasing either column on a blip removed the row's last
> path to an alert. `registered` itself is still written unconditionally,
> because that branch only runs when `resolved` is true.

> **`check_due_at` + `check_attempts` (migration 0269, additive) — the
> checker's own schedule.** `check_due_at` is when a row may next be selected;
> `check_attempts` is the consecutive failed-attempt count that drives the
> jittered backoff ladder in `lib/backoff.ts` (1 h / 4 h / 12 h / 24 h, capped
> at 48 h). Past 8 consecutive failures the row is **PARKED**: `check_due_at =
> NULL`, which drops it out of both partial cohort indexes entirely, so a
> permanently-unanswerable domain costs zero reads structurally instead of being
> re-admitted every 24 h forever. A parked row reads as `check_due_at = NULL`
> with a non-zero `check_attempts`, is counted by Flight Control's
> `backlog.lookalike_parked`, and has THREE ways back: the bounded un-park
> sweep described below, the rescan endpoint, and any successful check (which
> resets `check_attempts`). `check_attempts` is written as a BOUND value, not
> `check_attempts + 1` — the caller already derives it to pick the ladder step,
> and the two derivations diverged on every throw past the success path (which
> resets the column to 0), pinning the counter at a fixed point the ladder could
> never terminate on. Three stamps now coexist on this table and they are NOT
> interchangeable: `page_fetched_at` is the page pass's cooldown (written on
> both outcomes), `last_checked` means strictly "when a check last SUCCEEDED",
> and `check_due_at` is the DNS schedule. Migration 0269's header records why
> page analysis was deliberately left alone. Both columns are staff-visible via
> `LOOKALIKE_LIST_COLUMNS`; absent from the tenant SELECT.

> **The un-park sweep — a park is a long cadence, not a terminal state.** Four
> writers touch `check_due_at` and three of them require the row to have been
> SELECTED, which a parked row is not, so the only exit used to be the MANUAL
> per-brand rescan. A row parked before its first successful observation also
> still carries `registered = 0 / has_web = 0 / resolves_to NULL`, making it
> invisible to BOTH page-analysis cohorts as well. The checker's own tick now
> re-admits the OLDEST parked rows (bounded per run) before selecting, at
> `check_due_at = datetime('now')` — the latest possible due time, so they sort
> behind every genuinely overdue row and consume only slack capacity. The
> cadence self-throttles on `last_check_failed_at` (written only by the failure
> path, hence frozen on a parked row), and `check_attempts` is deliberately NOT
> reset: a still-dead row is probed ONCE and re-parks, rather than replaying the
> whole ladder every window. Bounds live in `lib/lookalike-budget.ts`.

> **`ai_claimed_at` (migration 0269, additive) — the Haiku lifetime gate's
> claim token.** The once-per-row-per-lifetime AI call was gated on a READ of
> the SELECT snapshot (`ai_assessment IS NULL`), so two concurrent runs over the
> same first-contact row — which repeated "Scan now" presses produce — could
> each read NULL and each spend. It is now a guarded claim (`UPDATE ... WHERE
> id = ? AND ai_assessment IS NULL AND (ai_claimed_at IS NULL OR ai_claimed_at
> <= datetime('now','-1 hour'))`), released whenever the pass produced no
> assessment. A DEDICATED column rather than a sentinel in `ai_assessment`,
> because a worker killed mid-call would leave that sentinel behind, the gate
> would never fire again, and both infrastructure boosts are MEDIUM-only — so a
> mail+web row would sit at LOW forever and never clear the HIGH alert floor.
> Staleness is keyed on this column precisely because nothing else writes it
> (`updated_at` is refreshed by the success path before the claim is attempted,
> so a stale claim keyed on it could never be detected as stale). Staff-visible
> via `LOOKALIKE_LIST_COLUMNS`; absent from the tenant SELECT.

> **`bimi_first_seen_at` (migration 0269, additive) — presence only, never
> absence.** Stamped when a BIMI record is OBSERVED on a lookalike domain, and
> never written to mean "there is none": `checkBIMIExists` catches its own
> errors and returns `false`, so absence and lookup-failure are the same value
> at the call site. The BEC lane is now **recurring** rather than
> first-contact-only — every due check of a `registered = 1 AND has_mx = 1` row
> whose `bimi_first_seen_at IS NULL` spends one DNS TXT lookup, bounded by a
> per-run cap — so a squat that publishes BIMI months after we baselined it is
> no longer invisible forever. **The cadence that buys is ~47 days post-seed,
> not 24 h**: `+24 hours` is what a row's next due time is set to after a
> success, while how often a row is REACHED is the population over the
> throughput — ~56,040 rows against 50 rows/tick x 24 ticks = 1,200 checks/day.
> Still a strict improvement on "once per row, ever". A standalone BEC SELECT
> would be faster but needs its OWN cooldown column first: `check_due_at` only
> advances when the DNS lane selects the row, and a BIMI pass that finds no
> record writes nothing, so a standalone query ordered by it would re-serve the
> same top rows every tick. The column doubles as the lane's idempotency
> token: the fixed-HIGH `typosquat_bimi` alert is filed only after a guarded
> `UPDATE ... WHERE id = ? AND bimi_first_seen_at IS NULL` reports one changed
> row, and the claim is RELEASED on every path that does not file — a thrown
> `createAlert` **and a missing brand row**, which originally took neither
> branch (`if (brand)` was simply skipped, nothing threw) and left the row
> permanently marked BIMI-recorded with no alert in existence. A release that
> itself fails is counted on the agent diagnostic, because it is the one
> remaining path to a silently and permanently lost finding. That alert's id is
> deliberately **not** written to `alert_id` — `raiseUnalertedPhishingPageAlert`
> keys on `alert_id IS NULL`, so one parked there would permanently suppress the
> row's phishing-page alert. Find it instead as
> `alerts.source_type = 'lookalike_scanner' AND source_id = <lookalike id> AND
> alert_type = 'typosquat_bimi'`.

> **Transitions the checker now detects.** The per-row SELECT used to carry only
> `registered`, so the sole detectable transition was `registered 0 → 1` — and
> since `registered` is monotone in practice, every capability in the checker
> (the alert, the Haiku call, the BIMI probe, the compositor) was reachable
> exactly ONCE per row. It now also reads `has_mx` / `has_web` / `threat_level`
> / `ai_assessment` / `alert_id` / `bimi_first_seen_at` / `takedown_id`, and
> dispatches on the observed transition. An MX or web APPEARANCE on an
> already-registered row re-opens the compositor and the BIMI lane but files no
> alert of its own — with one bounded exception: when the gain COMPLETES the
> mail+web pair the row is the same operational shape first contact alerts on,
> so an alert may be filed if the row carries none yet and the composed level
> clears the HIGH floor. An answered `registered 1 → 0` is persisted, never
> downgrades `threat_level` (`agents/sparrow.ts` reads it for takedown
> eligibility and priority), and stamps the linked takedown
> `verification_status = 'down'` + `last_verified_at` reusing Sparrow's Phase F
> contract. A `resolves_to` change is recorded and is never a trigger. A probe
> that did not ANSWER cannot mint any transition: the classifier is fed the
> stored value wherever the per-probe flag is false. Haiku runs only when
> mail+web is present AND `ai_assessment IS NULL`, so at most once per row per
> lifetime, under a per-run cap — a deliberate narrowing from "every observed
> 0 → 1", with the deterministic page pass covering the web lane instead. A
> capped or failed call leaves the row CLAIMABLE but is retried on the row's
> next TRANSITION rather than its next due pass: `compositeAndPersist` is
> reached only from first contact, a registration gain or an mx/web gain, so a
> stable baselined row yields `none` forever.
>
> **A `registration_gained` after a lapse re-alerts, by design.** That branch
> passes `allowAlert: true` unconditionally — unlike the mx/web path, which
> bounds itself on `alert_id IS NULL` — so a domain cycling registered → lapsed
> → re-registered files one alert per cycle and `alert_id` points at the most
> recent. A re-registration is typically a NEW registrant, which is the thing
> this platform exists to notice. "One alert per row per lifetime" is therefore
> true of the MX/WEB path, not of the row. `first_seen` is NOT re-stamped (its
> `AND first_seen IS NULL` guard is genuinely lifetime-scoped).
>
> **A BIMI-publishing squat is raised to HIGH regardless of a Haiku veto.** The
> BIMI boost used to be MEDIUM-only like the mail+web boost, which produced an
> incoherent row: a Haiku-vetoed LOW row that publishes BIMI kept
> `threat_level = 'LOW'` while a fixed-HIGH `typosquat_bimi` alert was filed
> about it — and `agents/sparrow.ts` gates takedown eligibility on
> `threat_level IN ('HIGH','CRITICAL')`, so the strongest email signal the
> scanner finds could never reach the takedown queue. Filing a HIGH alert IS the
> assertion that the row is HIGH, so the level follows the alert, monotonically
> (it never lowers a CRITICAL a page verdict established). The Haiku veto over
> the deterministic **mail+web** signal is unchanged.

> **`POST /api/lookalikes/:brandId/scan` is a priority ENQUEUE, brand-scoped,
> small-budgeted and ROW-BOUNDED.** It sets `check_due_at =
> '1970-01-01 00:00:00'` and `check_attempts = 0` on up to
> `LOOKALIKE_RESCAN_ENQUEUE_LIMIT` (100) of the brand's rows — parked rows
> first, then the most overdue — and clears `last_check_failed_at`. The epoch is
> earlier than any stamp the system can produce, so those rows sort ahead of
> everything in their cohort. **The bound is a safety property, not a
> performance one**: both cohort selectors are `ORDER BY check_due_at ASC` over
> a GLOBAL, cross-tenant queue drained 50 rows a tick, so the previous
> un-capped `WHERE brand_id = ?` let an org-scoped staff member scripting this
> endpoint pin an unbounded number of their own rows to the head of that queue
> and starve every other tenant's detection latency indefinitely. The statement
> additionally SKIPS rows already at the epoch, which is what makes the bound
> hold over time rather than per call: repeated presses re-stamp nothing until
> the previous batch has drained, so one brand can hold at most 100 rows at the
> queue head at any instant. A brand with more than 100 rows gets the rest on a
> later press. `domains_queued` is therefore the number actually enqueued, which
> may be fewer than the brand's row count. It touches `last_checked` not at all, so first contact
> is structurally unforgeable from here — which is what the previous two forms
> of this handler (`last_checked = NULL`, then a `CASE` writing
> `datetime('now','-25 hours')`) existed to work around. The inline run is now
> **brand-scoped and small-budgeted** (10 rows, 3 Haiku calls, 5 BIMI lookups,
> 2 page fetches) instead of awaiting the GLOBAL `checkLookalikeBatch`, which
> was up to 100 DoH queries, 50 HEAD probes, 50 Haiku calls and 10 page fetches
> per button press against rows belonging to brands the caller never asked
> about. The response adds `domains_checked_inline` alongside the unchanged
> `domains_queued`; the remainder drains on the next cron ticks from the front
> of the queue.

## App Store Impersonation Monitoring

iOS App Store impersonation scanner (Google Play + 3rd-party Android
stores planned). Findings are upserted into `app_store_listings` and
classified rule-based first; ambiguous rows are re-assessed by Haiku.
HIGH/CRITICAL impersonation findings create `alerts` rows of type
`app_store_impersonation` and fire an `alert.created` webhook.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/appstore/overview` | Staff | Cross-brand app-store dashboard: one row per monitored brand with severity-bucketed counts and schedule info. Every staff role (`isPlatformStaff`, PR-F) sees every monitored brand. |
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
| GET | `/api/darkweb/overview` | Staff | Cross-brand dashboard: one row per monitored brand with severity-bucketed counts and schedule info. Every staff role (`isPlatformStaff`, PR-F) sees every monitored brand; a non-staff org caller would see its `org_brands` subset. |
| GET | `/api/darkweb/mentions` | Staff | Cross-brand mentions list (org-scope aware) |
| GET | `/api/darkweb/mentions/:brandId` | Staff | List mentions + schedule for a brand. Filters: `source`, `classification`, `severity`, `match_type`, `status`, `limit`, `offset`. |
| POST | `/api/darkweb/scan/:brandId` | Staff | Trigger an immediate scan + AI drain for this brand. |
| PATCH | `/api/darkweb/:id` | Staff | Update a mention's `classification` or `status` (manual override, wins over AI/system). |
| GET | `/api/trademarks/overview` | Staff | Cross-brand trademark rollup: per-brand active asset count + finding counts (total/confirmed/likely/unknown/high_critical) + cross-brand totals. Every staff role (`isPlatformStaff`, PR-F) sees all brands with trademark data; a non-staff org caller would see its `org_brands` subset. Default page KV-cached 120s. Data from the Phase 1 correlation scanner (`scanners/trademark-monitor.ts`). |

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
| GET | `/api/alerts` | Staff | List alerts. **Platform-wide for staff** (PR-C): every staff role (incl. `auditor`) sees every alert — no per-user filter (`getOrgScope` is null for `isPlatformStaff`). Query: `status`, `severity`, `alert_type`, `brand_id`, `search`, `limit` (≤200, default 100), `offset`. Ordered by severity (`critical` → `high` → `medium` → `low` → other, case-insensitive) then `created_at DESC`. Returns `{success, data: Alert[], total}`; rows are `alerts.*` (incl. the staff-only `staff_assigned_to`, `staff_assigned_at`, `staff_notes` — migration 0275) plus `brand_name`, `brand_domain`, `assigned_to_name`/`assigned_to_email` (the CUSTOMER's own assignee), `staff_assigned_to_name`/`staff_assigned_to_email` (the Averrow staff assignee), `saas_technique_{id,name,phase,phase_label,severity}`. |
| GET | `/api/alerts/stats` | Staff | Alert statistics, platform-wide for staff. `{total, new_count, acknowledged, resolved, dismissed, auto_dismissed, critical, high, medium, low}` (all numbers, 0 when empty). `dismissed` counts every `false_positive` row; `auto_dismissed` is the subset whose `resolution_notes` carry the `auto:` stamp (rule triage + AI judge). The former unbounded `by_brand[]` was removed (unused). KV-cached 60s per scope segment (`alerts_stats:global` for staff); dropped by ops alert mutations (`/api/alerts*`) only — tenant actions, auto-triage and fan-out don't invalidate, the 60s TTL bounds staleness there. |
| GET | `/api/alerts/triage-summary` | Staff | Bell-row triage counts, platform-wide for staff. Returns `{success, data: {new_count, critical_count, top}}` — `new_count` = `status='new'` alerts, `critical_count` = those with `severity='critical'` (same predicate as `/api/intel/critical-banner`'s `open_critical_alerts`), `top` = the most severe then newest `status='new'` alert as `{id, title, severity, brand_id, brand_name, alert_type, created_at}` or `null` when none. KV-cached 60s under `alerts_triage:<scopeCacheSegment>` (`alerts_triage:global` for staff); an ops alert mutation (PATCH / bulk on `/api/alerts*`) deletes it so counts drop immediately; other alert writers rely on the 60s TTL. |
| GET | `/api/alerts/:id` | Staff | Get alert detail (any alert, platform-wide for staff). Same columns and joins as the list rows (`assigned_to_name`/`_email`, `staff_assigned_to_name`/`_email`, `staff_notes`, `saas_technique_*`), so a deep-linked alert shows both owners. 404 when absent. |
| PATCH | `/api/alerts/:id` | `edit_alerts` (super_admin, admin, analyst, support) | Triage a signal. Body (at least one): `status` (`new`/`acknowledged`/`investigating`/`resolved`/`false_positive` — shared column, **visible to the customer**), `staff_assigned_to` (users.id of an ACTIVE platform-staff user, or `null` to release; stamps `staff_assigned_at`; 400 otherwise), `notes` (string ≤4000 or `null` → `staff_notes`, internal — never written to the customer-visible `resolution_notes`). `assigned_to` → 400: it is the customer's own assignee and staff never write it. The customer sees a staff claim as the assignee label "Averrow SOC" (see `/api/orgs/:orgId/alerts`). Acts on any alert (platform-wide). sales/billing/auditor/client → 403. Writes `audit_log` `alert_update` (actor `user_id`, `previous_status`/`new_status`, `staff_notes` truncated to 500, `previous_staff_assigned_to`/`staff_assigned_to`). |
| POST | `/api/alerts/bulk-acknowledge` | `edit_alerts` | Bulk acknowledge `status='new'` alerts, platform-wide. Body: `{alert_ids: string[]}` (≤90 distinct; more → 400 — D1's 100-bind limit) or `{brand_id}`. At most 90 alerts per call (most severe, newest first); brand calls return `remaining` (still-new alerts on the brand) — repeat until 0. Returns `{success, data: {updated, alert_ids, remaining}}` (`remaining` is 0 for the ids form). Writes `audit_log` `alert_bulk_acknowledge` with `requested_ids` + `affected_ids`. 403 for sales/billing/auditor/client. |
| POST | `/api/alerts/bulk-takedown` | `edit_alerts` + `manage_takedowns` (super_admin, admin, analyst) | Bulk create draft takedown requests from alerts and acknowledge them, platform-wide. Body: `{alert_ids}` (≤90; more → 400) or `{brand_id}`. Only alerts with status `new`/`acknowledged` and no existing takedown (`takedown_requests.source_type='alert'`, `source_id`=alert id) are eligible; at most 90 per call. Inserts + acknowledge run in one atomic `env.DB.batch`. Returns `{success, data: {takedowns_created, alerts_acknowledged, alert_ids, remaining}}` (`remaining` for brand calls); 404 when no eligible alerts. Writes `audit_log` `alert_bulk_takedown` with `affected_ids`. Known issue: `target_type`/`target_platform` are hardcoded `social_profile`/`tiktok` and `target_value` is the alert title. Needs both flags because it creates `takedown_requests`: support (has `edit_alerts`, lacks `manage_takedowns`) → 403 `Forbidden: requires 'manage_takedowns' permission`; sales/billing/auditor/client → 403. |
| POST | `/api/admin/alerts/backfill-triage?limit=500&offset=0&threshold=0.5` | Admin | Auto-triage pass over `new` alerts. Dispatches by alert family: threat-sourced (VT/GSB/GreyNoise/SecLookup clean), social_impersonation (handle in official_handles or score < threshold), app_store_impersonation (developer in official_apps OR developer name normalizes to brand name OR score < threshold). Returns `{scanned, dismissed, kept, no_threat, by_type}`. **Use `offset` to advance through the queue across calls** — without it, batches with 0 dismissals will re-scan the same alerts forever. |
| POST | `/api/admin/brand-links/cleanup?mode=dry_run&run_id=…&cursor=0&limit=500[&confirm=…]` | Super Admin | One batch of the brand-link cleanup (`lib/brand-link-cleanup.ts`). Re-validates existing `threats.target_brand_id` links against the current matcher (`lib/brandDetect.ts`) → **keep** (stamps `brand_match_method` if NULL), **relink** (new matcher picks another brand) or **clear**. Scope: only links the pre-#1727 fuzzy matcher would itself have produced are changed; links from brand-scoped detectors (`typosquat_scanner`, `numbered_variant_scan`, `ct_logs`, `nrd_hagezi`, `spam_trap`, `abuse_mailbox`) and links the old matcher could not have made (Analyst AI inference) are kept and counted in `kept_protected`. Modes: `dry_run` (default, writes nothing); `apply` (requires `confirm=apply-brand-link-cleanup`; each relink/clear logs the original brand + method to `brand_link_cleanup_log` (migration 0271) in the same atomic batch as an UPDATE guarded on the old brand, only when that UPDATE applies); `undo` (requires `confirm=undo-brand-link-cleanup`; restores the `run_id`'s logged links only where the threat still holds the cleanup's value, stamps `undone_at`); `reconcile` (one brand-counter recompute — run once after apply/undo). `run_id` `[A-Za-z0-9_.:-]{1,64}` (default `manual`) groups a run; the actor (`user:<id>` here, `internal` on the internal route) is stored per log row and every apply/undo batch writes `audit_log` (`brand_links.cleanup.<mode>`). Rowid keyset: loop on `next_cursor` until `done` (driver: `scripts/brand-link-cleanup.sh`). `limit` 1–2000 (default 500). Returns `{mode, run_id, scanned, keep, relink, clear, keep_by_method, kept_protected, by_reason, removed_by_brand, added_by_brand, alerts_affected, changed, skipped, next_cursor, done, reconciled?}`. After apply/undo, rebuild cube history older than 30 days with `scripts/cube-backfill.sh`. |
| POST | `/api/admin/alerts/run-ai-judge?limit=50&offset=0` | Admin | Tier 3 — runs Haiku second-opinion on `new` alerts that haven't been AI-judged yet (`ai_assessment IS NULL`). Stamps verdict + reasoning into `ai_assessment`. Auto-dismisses only when verdict='likely_safe' AND confidence >= 90. Returns `{scanned, judged, dismissed, kept, failed, by_verdict}`. ~$0.001 per alert. Idempotent. |
| POST | `/api/admin/notifications/cleanup-dismissed?lookback_hours=168&window_minutes=15&limit=1000` | Admin | Sweeps `notifications` for unread rows correlating (by `brand_id` + ±`window_minutes` of `created_at`) to recently auto-dismissed alerts (`resolution_notes LIKE 'auto:%'`). Marks matched notifications as `read`. Heuristic by design — alerts and notifications are not FK-linked. Returns `{alerts_checked, notifications_cleared}`. Idempotent. |
| POST | `/api/admin/phantom-domains/match?limit=500&source=all&full=0` | Super Admin | W2.3 phantom-squat MATCHER post-pass (spec §7). Set-based join of `phantom_domains` (status='predicted') against `nrd_domains`/`ct_certificates`/`lookalike_domains`; on a hit flips the phantom predicted→registered (guarded `WHERE status='predicted'` — fires **at most once**) and raises **at most one** `low`-severity alert reusing `lookalike_domain_active` (nrd/lookalike) or `ct_certificate_issued` (ct). **Never inserts threats. Never runs inline in a feed pull.** Tolerates the NX2 tier gate (`createAlert`→null leaves the flip standing with `alert_id` NULL). Incremental per-source KV cursor (`phantom_matcher:{nrd,ct,lookalike}:cursor`); `full=1` ignores + does not advance the cursor (catch-up sweep). `source` ∈ `nrd`\|`ct`\|`lookalike`\|`all`. `limit` capped at 5000 (default 500), per source. Idempotent — safe to re-run. Returns `{full, limit, by_source: {nrd, ct, lookalike: {scanned, matched, alerted, cursor_before, cursor_after}}, total: {scanned, matched, alerted}}`. |
| POST | `/api/admin/phishing-signals/backfill?limit=500&offset=0&dry_run=1` | Admin | Deterministic (zero-AI) phase-1 campaign-polymorphism writer. Reads bounded `spam_trap_captures`, measures each via the pure core (`lib/phishing-pattern-signals.ts`), and upserts `phishing_pattern_signals` (`ON CONFLICT(capture_id) DO UPDATE`, idempotent). **`dry_run` defaults to on** — returns corpus stats only (candidate count, preview-length distribution, `threat_id→campaign_id` availability, members-per-group breakdown) and writes nothing; pass `dry_run=0` for a real write. Real run returns `{scanned, written, updated, skipped_below_floor, by_key_kind}`. `limit` capped at 1000. Never writes `ai_generated_probability` (stays NULL until the campaign-level judge exists). |
| POST | `/api/admin/phishing-signals/rollup?limit=500&offset=0&dry_run=1` | Admin | Phase-1 campaign-grain rollup (W1.6). Reads `phishing_pattern_signals` grouped by `campaign_key` (non-NULL only), joins `spam_trap_captures`/`brands` for `captured_at`/`from_domain`/`subject` (computes `subject_slot_hash` via the same Stage-A slotting as the per-capture writer), calls the pure `aggregateCampaign`, and upserts `campaign_pattern_stats` (`ON CONFLICT(campaign_key) DO UPDATE`, recompute-from-scratch idempotent). Also re-stamps the authoritative `template_detected` on every member of each processed group. Groups below `MIN_CAMPAIGN_MEMBERS` (5) produce **no row** (skipped, not a junk row). **`limit`/`offset` paginate over campaign GROUPS, not captures.** **`dry_run` defaults to on** — computes the would-be counts and writes nothing; pass `dry_run=0` for a real write. Returns `{dry_run, limit, offset, groups_scanned, stats_written, groups_skipped_below_floor, members_restamped, min_campaign_members, by_regime}`. `limit` capped at 1000. `campaign_pattern_stats` carries no `ai_generated_probability` column (spec §0.2 rule 1). |
| POST | `/api/admin/velocity/backfill?limit=500&offset=0&dry_run=1` | Admin | Deterministic (zero-AI) weaponization-velocity backfill (rec 5, v1). Reads a bounded page of `threats` rows carrying `domain_created_at`, runs the pure `decideWeaponizationVelocity` (`lib/velocity-signatures.ts`) per row — the whole-hours `first_seen − domain_created_at` delta bucketed into `weaponization_flag` (`very_fast` ≤24h / `fast` ≤72h / `normal` >72h / NULL when not computable) — and stamps `threats.weaponization_hours` + `threats.weaponization_flag` via single-row PK `UPDATE` (no `ON CONFLICT`; immutable inputs ⇒ byte-identical re-runs). Per-row arithmetic only — no JOIN, no GROUP BY over `threats`. **Metadata/evidence ONLY — never gates alert-triage / alert-ai-judge (doctrine §3.1).** **`dry_run` defaults to on** — returns `{total_threats, candidates_total, already_stamped, scanned, would_write, by_flag}` and writes nothing; pass `dry_run=0` for a real write, which returns `{scanned, written, by_flag}`. Not-computable rows (missing/garbage/pre-1985-sentinel/negative-delta) are left NULL (distinct from `normal`). Idempotent — advance `offset` across calls until `scanned < limit`. `limit` capped at 1000. **Operator note (VELOCITY_DARK_2026-09): there is NO cron — this endpoint is the only dispatcher, so the columns stay 100% NULL until someone sweeps.** To check whether a sweep is owed without an admin JWT, read `velocity.coverage` on `GET /api/internal/platform-diagnostics`: `stamped_pct_of_candidates === 0` means it has never run, and `unstamped_candidates` is the remaining work. `candidate_pct` is the ceiling — only rows carrying `domain_created_at` are computable, and the sole producer of that column is the `virustotal` feed (free tier, ~240 domains/day), so the computable set is a low-single-digit % of `threats`. Cost note: `domain_created_at` is unindexed, so each `offset` page walks the threats PK; a full sweep at `limit=1000` costs roughly (candidates ÷ 1000) × `COUNT(*) threats` rows read — budget it against `d1_budget_state.pct_of_daily_budget` before starting. |

#### `lookalike_domain_active` — `details` page evidence

When the lookalike scanner's inline page analysis ran and scored the
page, `alerts.details` (returned by `GET /api/alerts` and
`GET /api/alerts/:id`) additionally carries the page evidence that
produced the verdict (Lane 3 Phase 3, §9 step 16 — producer:
`scanners/lookalike-domains.ts` `buildPageEvidenceDetails`):

`page_signals` (`string[]`, fired scored-signal keys), `page_score`
(`number`, 0-100), `page_anti_bot_wall` (`string | null`),
`page_ai_signals` (`string[]`, fired **shadow** keys), `page_score_delta`
(`number`, shadow-only — **never added to `page_score`**).

**All five keys are absent** when page analysis did not run (domain has
no web server, inline per-tick budget exhausted) or failed (SSRF block,
non-HTML/oversize body, network error). Consumers must treat absence as
*not analyzed*, distinct from an analyzed-and-clean page (`page_score: 0`
with empty arrays).

Keys only, by design: `page_evidence` (matched literals), `page_exfil_sink`
and `page_exfil_sink_id` are **not** carried, because alert details reach
customer surfaces and email digests and those three are attacker-controlled
free text. They remain on `lookalike_domains` for staff
(`GET /api/lookalikes/:brandId`). Descriptive only — the alert's
`severity` is unchanged, and none of these fields is read by
`createAlert`'s auto-triage dispatch.

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
| GET | `/api/notifications/subscriptions` | User | List per-brand subscriptions joined with brand metadata. For `client` users, rows on brands no org they actively belong to owns are omitted |
| PUT | `/api/notifications/subscriptions/:brandId` | User + brand access | Set level (watching\|default\|ignored), optional `snoozed_until`. **Org-ownership required:** staff (any non-`client` role) may watch any brand; a `client` only a brand in `org_brands` for an org where they are an active `org_members` row — otherwise `403` (also `403`, not `404`, for an unknown id, so ids can't be enumerated). Tenant-audience fan-out applies the same rule to recipients (`lib/brand-subscription-access.ts`) |
| DELETE | `/api/notifications/subscriptions/:brandId` | User | Remove the caller's own subscription (no brand-access check — always allowed so stale rows can be cleaned up) |

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

## Signals

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/signals` | Staff | List the latest scans as signals (`?limit=` max 50, `?offset=`). Reads the **global** `scans` table — every user's scans plus anonymous homepage scans — so it is staff-only (`requireStaff`, auditor included): no token → 401, tenant `client` → 403. Was unauthenticated until 2026-10 despite this row saying `User`; no first-party UI calls it. |
| POST | `/api/signals` | Staff | Create signal |

## Scans

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/scan` | Staff (optional) | Trigger scan — works unauthenticated (rate-limited); a staff Bearer token attributes the scan to the caller. Same storage rule as `/api/scan/public`: country only, from `request.cf.country`; no IP, city or coordinates, no third-party geolocation. `/api/heatmap` (the scan-submitter heatmap) was removed in PR-E and now 404s. |
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
| GET | `/api/threat-actors` | Staff | List threat actors (KV cached, read replicas, parallel count+list) |
| GET | `/api/threat-actors/stats` | Staff | Threat actor statistics (KV cached, read replicas, parallel 6-query aggregation) |
| GET | `/api/threat-actors/:id` | Staff | Get threat actor detail with infrastructure + targets |
| GET | `/api/threat-actors/by-brand/:brandId` | Staff | Threat actors targeting a specific brand |
| GET | `/api/threat-actors/:id/threats` | Staff | Threats linked to actor via `threat_attributions` (Phase B — OTX/NEXUS/news) **OR** known ASN infrastructure |

All five `/api/threat-actors*` routes are `requireStaff` (analyst+, including the read-only `auditor` seat); a tenant `client` gets 403. They are cross-tenant (`/:id/threats` spans all brands, `/by-brand/:brandId` accepts any brand id). Tenants use the org-scoped `/api/orgs/:orgId/modules/threat-actor` routes instead.

## Intel

_Retired in PR-D (2026-10), no client after the Home views were removed in #1756: `GET /api/intel/hotlist`, `GET /api/insights/latest`, `GET /api/providers/movers`, `GET /api/providers/worst`, `GET /api/providers/improving` (all now 404; the frozen legacy `public/app.js` still references three of them)._

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/intel/multi-feed-consensus` | Staff | IPs flagged by ≥4 distinct `source_feed` values among active threats (placeholder IPs `''`/`0.0.0.0` excluded), top 50 by `feed_count` then `threat_count`. Response `{ success, data: [{ ip_address, feed_count, feeds: string[] (sorted), threat_count, brand_count, last_seen }], total }`. `cachedValue` 6h TTL (key `intel.multi_feed_consensus.v1`) — the query is effectively a full `threats` scan, so ≤4 D1 executions/day. The one lane kept from the retired `/api/intel/hotlist`. |
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
| POST | `/api/admin/abuse-mailbox/run-classifier` | Admin | Drain the abuse-mailbox pile in cron order: deterministic rules pass (newest first), then the AI classifier (`?limit=&offset=`; offset applies to the AI pass). Idempotent on retry; parse-failure rows stay `pending`; emails only via the atomic determination claim. Response: AI-pass fields at top level plus `rules` and `ai` objects |

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
| GET | `/api/admin/marketing-analytics` | Admin | Marketing page analytics + AI visibility. `?hours=` clamps to 1..168 (default 24). Returns `MarketingVisibility`: `windowHours`, `humanViews`, `aiCrawlerViews`, `otherBotViews`, `aiReferralSessions`, `ctaClicks`, `contactSubs`, `topPages[]` (`{page, views}`), `aiCrawlerBreakdown[]` (`{crawler_name, hits}`), `aiReferralBySource[]` (`{ai_source, sessions}`). Shares `fetchMarketingVisibility` with the daily briefing (Section 9). |
| GET | `/api/admin/health` | Admin | System health |
| GET | `/api/admin/budget/ledger-health` | Admin | Budget ledger fill diagnostic — surfaces per-call-site rows in the last 24h, flags any expected agentId that has not landed a row, and returns BudgetManager.getStatus() so operators can spot-check monthly_spend / throttle_level after the wrapper refactor. |
| GET | `/api/admin/metrics/ai-cost-optimization` | Admin | Measurement endpoint for the AI cost-reduction plan. Returns per-call efficiency metrics (calls, in/out tokens, cost) for the three focus agents (cartographer, analyst, sentinel) across 24h/7d/30d windows, plus cartographer's 30-day daily series + a static lever roster (id, title, target_agent, status, estimated_savings, indicator). No longer powers a UI panel — the standalone Cost Optimization tab was folded into AI Spend (`CostOptimization.tsx` deleted from `averrow-ops`); `/api/admin/metrics/ai-spend` now covers these metrics in-app (see that row above). Endpoint stays live to back the internal CLI route below. 5-min KV cache. |
| GET | `/api/internal/metrics/ai-cost-optimization` | AVERROW_INTERNAL_SECRET | Internal mirror of `/api/admin/metrics/ai-cost-optimization` for programmatic / CLI access (see `scripts/ai-cost-optimization.sh`). |
| GET | `/api/admin/platform-diagnostics` | Super Admin | Comprehensive platform diagnostics for programmatic consumption. Returns enrichment pipeline state (stuck pile, cartographer queue, enriched counts), per-feed failure rates with auto-pause risk, per-agent run counts, backlog trends, AI spend, cron health, stalled agents. Accepts `?hours=N` (default 6, floored at 1, max 168). `velocity.coverage` (endpoint_version 10) splits the NULL-derived `not_computable` bucket into `no_registration_date` (inherently not computable) vs `unstamped_candidates` (`POST /api/admin/velocity/backfill` hasn't swept them) — `stamped_pct_of_candidates === 0` means the backfill has never run. `page_analysis` (endpoint_version 11) adds the Lane 3 Phase 1 shadow-mode blocks `ai_build` (per-signal firing rates, `class_a_cap_hits`, `escalations_any` / `escalations_attributable`, `persisted_delta_drift`), `exfil` (sink-host mix + distinct bot/webhook ids — host and non-secret id only, never a full sink URL) and `generator` (weight-zero builder mix), plus `page_analysis.truncated` which flags that the single bounded pass over `lookalike_domains` hit its row cap and every count below it is a lower bound. `ai_health` is the "is AI actually working" block (distinct from `ai_spend_24h`, which is cost only): `last_ledger_row_at`, `hours_since_last_call`, `window_hours`, `per_agent[]` (`attempted` / `succeeded` / `skipped` / `last_run_at` / `first_failure_kind` / `first_error`, over the `?hours=` window, counter-instrumented agents only) and `agents_all_failing[]`. |
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
| PATCH | `/api/admin/users/:id` | Admin | Update user. 400 when changing a non-staff user to a staff role (anything but `client`) while they hold an active `org_members` row — no tenant-affiliated staff (PR-F); the lead-conversion placeholder owner row (`provisioned_by='lead_conversion'`) is ignored only while its user is staff, and status-only / same-role PATCHes never 400. 403 unless the caller is `super_admin` when the requested role OR the target's current role is `admin`/`super_admin` (covers status changes of those accounts too); self role change is 400. A staff → `client` change deactivates the user's active lead-conversion placeholder rows in the same D1 batch (audited `lead_conversion_placeholder_removed`). Any actual role change sets `forced_logout:<id>` in KV, revoking the user's live tokens; if that KV write fails the role change still stands and the response is 200 with `revocation_pending: true` + `warning` (audited `user_role_change_revocation_failed`) — re-run force-logout. 409 when the user's role changed between the handler's read and its write (retry). A non-staff → staff change also re-checks the org-membership rule in the write itself: a membership added after the pre-check → 409 (audited `user_role_change_refused_org_member`). |
| GET | `/api/admin/sessions` | Admin | Active sessions |
| POST | `/api/admin/users/:id/force-logout` | Admin | Force logout user |
| GET | `/api/admin/invites` | `manage_invites` (sales, admin, super_admin) | List **staff** invites (`org_id IS NULL`; `?status=`, `limit`/`offset`). Org invites are listed per org via `GET /api/orgs/:orgId/invites`. |
| POST | `/api/admin/invites` | `manage_invites` (sales, admin, super_admin) | Create invite. Handler-level check: only super_admin may invite `admin` / `super_admin` roles. |
| DELETE | `/api/admin/invites/:id` | `manage_invites` (sales, admin, super_admin) | Revoke a **staff** invite (`org_id IS NULL`). An org invite id is 404 here: org invites are revoked via `DELETE /api/orgs/:orgId/invites/:inviteId`, which applies the owner-seat rule. |
| GET | `/api/admin/audit` | Staff, `view_audit` (admin, super_admin, analyst, auditor) | Audit log (filters: `outcome`, `action`, `resource_type`, `window`, `search`, `since`/`until`, `limit`/`offset`). Response includes `stats` (today / failures / denied / unique_actions) and `resource_types`, computed over the FULL filtered set — the UI stat cards and resource-type filter no longer derive from the visible page |
| GET | `/api/admin/audit/export` | Staff, `view_audit` (admin, super_admin, analyst, auditor) | Export audit log |
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
| POST | `/api/admin/backfill-brand-enrichment` | Admin | Populate brand logo_url, website_url, hq_lat/lng/country via Clearbit + DNS + ipinfo.io (50/call) |
| POST | `/api/admin/backfill-brand-sector` | Admin | Classify brand sector via Haiku + fetch RDAP registrant data (20/call) |
| POST | `/api/admin/backfill-safe-domains` | SuperAdmin | Backfill safe domains |
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
| GET | `/api/admin/organizations` | `read_customers` (analyst, sales, support, auditor, admin, super_admin) | List all organizations, each row with `member_count` + `brand_count`. Response is the public org projection (`toPublicOrg`, `lib/org-public.ts`): `id, name, slug, plan, plan_id, status, billing_status, trial_ends_at, max_brands, max_members, sso_provider, created_at, updated_at` plus `has_webhook` (bool) and `webhook_url_redacted` (scheme + registrable domain only, e.g. `https://…slack.com/…`). Never returns `webhook_secret`, the full `webhook_url`, `sso_config_json`, `invite_code` or Stripe ids |
| POST | `/api/admin/organizations` | Super Admin | Create organization. Returns the public org projection (see list row) plus `invite` |
| GET | `/api/admin/organizations/:orgId` | `read_customers` (analyst, sales, support, auditor, admin, super_admin) | Get organization detail with `members` + `brands`. Response is the public org projection (`toPublicOrg`, `lib/org-public.ts`): `id, name, slug, plan, plan_id, status, billing_status, trial_ends_at, max_brands, max_members, sso_provider, created_at, updated_at` plus `has_webhook` (bool) and `webhook_url_redacted` (scheme + registrable domain only, e.g. `https://…slack.com/…`). Never returns `webhook_secret`, the full `webhook_url`, `sso_config_json`, `invite_code` or Stripe ids |
| PATCH | `/api/admin/organizations/:orgId` | Super Admin | Update organization. Returns the public org projection (see list row) |
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
| POST | `/api/admin/push/test` | Super Admin | Send a test push to the caller; `data` is the dispatch result `{ sent, expired, failed, configured, subscriptions }` (`configured: false` = push disabled / VAPID incomplete; `subscriptions` = caller's device count) |

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
| POST | `/api/orgs/:orgId/invite` | Admin (org) | Invite a user to the organization. `org_role: 'owner'` is 403 unless the caller is a platform `super_admin` or an active owner of this org (checked against `org_members`, not the JWT claim). |
| DELETE | `/api/orgs/:orgId/members/:userId` | Admin (org) | Remove a member. Removing an owner is 403 unless the caller is a platform `super_admin` or an active owner of this org; removing the org's last active owner is 409 (transfer ownership first). 409 when the member's role changed after it was read (retry). |
| PATCH | `/api/orgs/:orgId/members/:userId` | Admin (org) | Update a member role. Setting or changing an `owner` seat follows the same 403 rule as invite/remove; demoting the last active owner is 409; 409 when the member's role changed after it was read (retry). Promoting a non-placeholder member to `owner` deactivates the org's active lead-conversion placeholder rows in the same batch (audited `lead_conversion_placeholder_removed`, also when the role write then 409s). Setting the lead-conversion placeholder row to any role but `owner` is 409 (it can only be replaced or removed). |
| POST | `/api/orgs/:orgId/transfer-ownership` | Owner (org) | Atomically promote the target member to `owner` and demote the transferring owner to `admin`. Caller must hold an active `owner` row in this org (read from `org_members`, not the JWT claim) or be `super_admin`; the transferring owner is the caller's own row, or for a `super_admin` without one, the oldest non-placeholder active owner (else the placeholder). 409 when the target or the transferring owner is no longer active/owner at write time (nothing changes). Transferring TO the lead-conversion placeholder row is 400. The org's active placeholder rows are deactivated in the same batch (audited `lead_conversion_placeholder_removed`, also when the transfer then 409s). Body: `{ new_owner_user_id }` |
| GET | `/api/orgs/:orgId/invites` | Admin (org) | List outstanding invites |
| DELETE | `/api/orgs/:orgId/invites/:inviteId` | Admin (org) | Revoke an invite. An `org_role: 'owner'` invite needs the owner-seat rule (platform `super_admin` or an active owner of this org), else 403. |
| POST | `/api/orgs/:orgId/invites/:inviteId/resend` | Admin (org) | Resend an outstanding invite email (rotates the token, extends expiry). An `org_role: 'owner'` invite needs the owner-seat rule, else 403. |
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
| GET | `/api/orgs/:orgId/webhook` | Admin (org) | Get webhook config — the only read that returns the full `webhook_url` (the org's own admins edit it). Returns `has_secret`, never the secret |
| PATCH | `/api/orgs/:orgId/webhook` | Admin (org) | Update webhook. On first set (no existing secret) returns the newly generated `webhook_secret` once. Audit-log `details.webhook_url` is redacted to scheme + registrable domain |
| POST | `/api/orgs/:orgId/webhook/regenerate-secret` | Owner (org) | Rotate webhook HMAC secret; returns the new `webhook_secret` once |
| POST | `/api/orgs/:orgId/webhook/test` | Admin (org) | Send a test webhook delivery |
| GET | `/api/orgs/:orgId/dashboard` | Member | Tenant-scoped dashboard |
| GET | `/api/orgs/:orgId/alerts` | Member | Tenant alerts list. Staff-only columns (`staff_*`) are stripped; rows add `handled_by_averrow` (bool — Averrow staff hold the alert) and `assigned_to_name` = the org's own assignee, else "Averrow SOC" when staff hold it (staff are never named). |
| POST | `/api/orgs/:orgId/alerts/bulk` | Analyst+ | Bulk triage. Body: `alert_ids` (≤200), plus `status` and/or `assigned_to` (+ optional `notes`). Applies to the org-owned subset only; returns `{ updated }`. |
| PATCH | `/api/orgs/:orgId/alerts/:alertId` | Analyst+ | Triage a tenant signal. Body: `status` (acknowledged/investigating/resolved/false_positive) and/or `assigned_to` (a member user id, or `null` to unassign), `notes`. At least one of status/assigned_to required. `assigned_to` validated as an active org member. |
| GET | `/api/orgs/:orgId/alerts/:alertId` | Member | Single-signal detail for the Intelligence Card (deep-linkable). Same columns + brand JOIN as the list, plus `assigned_to_name` and `handled_by_averrow` (same staff-field stripping and "Averrow SOC" label as the list). Org-scoped via `org_brands`; 404 when the signal isn't owned by the org. |
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
| GET | `/api/orgs/:orgId/executives` | Member | Executive identity registry (EXEC_IMPERSONATION_2026-07 Stage 1) — list the org's registered executives. Optional `brand_id` filter. Each row carries parsed `official_handles` (platform→handle) + `watch_platforms` (array). Returns `{ data, total }`. |
| POST | `/api/orgs/:orgId/executives` | Admin (org) | Register an executive. Body: `brand_id` (required, must belong to the org), `full_name` (required), `title`, `official_handles` (object platform→handle), `watch_platforms` (array of the 6 social-monitor platform keys; defaults to all), `status` (active/paused). Returns `{ id }`. |
| GET | `/api/orgs/:orgId/executives/:execId` | Member | Executive detail (parsed JSON columns). Org-scoped; 404 when not owned. |
| PATCH / PUT | `/api/orgs/:orgId/executives/:execId` | Admin (org) | Update an executive (partial). Body (any of): `brand_id` (re-validated against org ownership), `full_name`, `title`, `official_handles`, `watch_platforms`, `status`. |
| DELETE | `/api/orgs/:orgId/executives/:execId` | Admin (org) | Hard-delete an executive (customer PII). Org-scoped; 404 when not owned. |
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
| GET | `/api/orgs/:orgId/modules/domain/brands/:brandId` | Member | Domain module per-brand detail — lookalike rows (incl. page-analysis evidence, see below), CT certs, malicious-domain threats |
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

#### `GET /api/orgs/:orgId/modules/domain/brands/:brandId` — lookalike row shape

Each element of `data.lookalikes` carries the registration fields
(`id`, `brand_id`, `domain`, `permutation_type`, `registered`,
`resolves_to`, `has_mx`, `has_web`, `first_seen`, `last_checked`,
`threat_level`, `ai_assessment`, `status`, `created_at`) plus the
deterministic page-content analysis evidence below (Lane 3 Phase 3,
`docs/LANE3_AI_BUILD_ARTIFACTS_SPEC.md` §3.5 / §9 step 15). Producer:
`scanners/lookalike-page-analysis.ts` via `lib/page-phishing-scorer.ts`
— **zero AI**.

| Field | Type | Notes |
|---|---|---|
| `page_fetched_at` | `string \| null` | Last fetch attempt. **`null` = never scanned** — the renderer must distinguish this from *checked and clean* (score `0`, empty `page_signals`). |
| `page_http_status` | `number \| null` | Status of that fetch; set even when the fetch was blocked/non-HTML. |
| `page_phishing_score` | `number \| null` | 0-100 deterministic score. |
| `page_signals` | `string \| null` | JSON array of fired scored-signal keys (closed vocabulary — `SIGNAL_WEIGHTS`). |
| `page_anti_bot_wall` | `string \| null` | `turnstile` \| `recaptcha` \| `hcaptcha` \| `cf_challenge` \| `js_challenge`. |
| `page_ai_signals` | `string \| null` | JSON array of fired **shadow** signal keys (closed vocabulary — `ShadowSignalKey`). |
| `page_score_delta` | `number \| null` | Shadow-only would-be contribution. **Never added to `page_phishing_score`**; it moves no verdict, triage or escalation. |
| `page_generator` | `string \| null` | `<meta name="generator">` — grouping dimension, weight 0. |
| `page_exfil_sink` | `string \| null` | Covert credential-exfil sink host. **Attacker-controlled** — see the security note below. |
| `page_exfil_sink_id` | `string \| null` | Telegram bot id / Discord webhook id from that sink (pivot key). |

**Security — `page_exfil_sink` must be defanged at every render site.**
It is an attacker-controlled hostname (bounded to 253 chars at the
extractor). Render it defanged (e.g. `api[.]telegram[.]org`) and
**never as a clickable link or auto-linkified value**, in the SPA or in
any CSV/email export: a click issues a live request to attacker C2 from
the viewer's corporate network.

**`page_evidence` is deliberately NOT exposed on this endpoint.** It
stores a matched literal lifted verbatim from attacker-controlled page
content — the one page field with no closed vocabulary — so it stays
staff-only, present in the staff endpoint's column allowlist
(`LOOKALIKE_LIST_COLUMNS`) and absent from the tenant SELECT. A test
pins that asymmetry from both sides
(`test/lookalike-list-columns.test.ts`).

Phase 3 is **surfacing only**: it renders what Phase 1 already computes
and persists (migration `0264`) and promotes nothing. The shadow fields
remain excluded from scoring, alert triage and threat-level escalation.

## Internal Endpoints

All internal endpoints require `Authorization: Bearer $AVERROW_INTERNAL_SECRET`. They are used by the MCP server, CLI scripts, and platform diagnostics without a user JWT.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/debug/run-enrichment` | Manually trigger the enrichment pipeline |
| POST | `/api/internal/agents/cartographer/run` | Trigger Cartographer agent inline |
| POST | `/api/internal/agents/nexus/run` | Trigger NEXUS agent inline |
| POST | `/api/internal/agents/executive_monitor/run` | Trigger the executive social-impersonation monitor (Doppelganger) inline — manual trigger / fallback for the `26 */6 * * *` cron |
| POST | `/api/internal/agents/phantom_enumerator/run` | Trigger the phantom-domain enumerator (Phantom) inline — enumerates each monitored brand's LLM-hallucination domain surface into `phantom_domains` at status='predicted' (no cron; manual/on-demand only). Never creates threats or alerts. |
| POST | `/api/internal/phantom-domains/match?limit=500&source=all&full=0` | Internal-secret variant of `POST /api/admin/phantom-domains/match` (W2.3 matcher post-pass) for MCP / cron dispatch. Same params + `{full, limit, by_source, total}` response shape. Idempotent set-based join; flips predicted→registered (at most once) and raises at most one `low` alert (`lookalike_domain_active`/`ct_certificate_issued`). Never inserts threats; never inline in a feed pull. |
| POST | `/api/internal/brand-links/cleanup?mode=dry_run&run_id=…&cursor=0&limit=500[&confirm=…]` | Internal-secret variant of `POST /api/admin/brand-links/cleanup` for `scripts/brand-link-cleanup.sh`. Same params, modes (`dry_run`/`apply`/`undo`/`reconcile`) and response shape; actor recorded as `internal`. |
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

No WebSocket routes are currently mounted.

`/ws/threats` was removed (2026-10 appsec fix): it upgraded into the
`ThreatPushHub` Durable Object with **no** auth check (this table wrongly
listed it as `User`), no client ever connected to it, and nothing ever
broadcast through the hub. It now returns the catch-all 404. The
`ThreatPushHub` class and `THREAT_PUSH_HUB` binding remain in
`wrangler.toml` (DO class removal needs a `deleted_classes` migration tag).
Any future `/ws/*` route must be mounted behind a staff guard — pinned by
`packages/averrow-worker/test/ws-threats-route.test.ts`.

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
