# AI Agents

Trust Radar uses a mesh of AI agents plus infrastructure agents (Navigator, Cube Healer) powered by Claude Haiku via the Anthropic API. Agents are defined as modules in `packages/trust-radar/src/agents/` and orchestrated by the agent runner in `packages/trust-radar/src/lib/agentRunner.ts`. The registry is `packages/trust-radar/src/agents/index.ts`.

## Agent Infrastructure

### Agent Runner

The agent runner (`packages/trust-radar/src/lib/agentRunner.ts`) provides the execution framework. Each agent implements the `AgentModule` interface:

```typescript
interface AgentModule {
  name: string;
  displayName: string;
  description: string;
  color: string;
  trigger: "scheduled" | "event" | "manual";
  requiresApproval: boolean;
  execute(ctx: AgentContext): Promise<AgentResult>;
}
```

### AI Client

All agents use Claude Haiku via the direct Anthropic API. The AI client is in `packages/trust-radar/src/lib/haiku.ts` and provides specialized functions:

- `inferBrand()` — Brand identification from domain/URL patterns
- `classifyThreat()` — Threat classification and severity scoring
- `generateInsight()` — Intelligence narrative generation
- `generateCampaignName()` — Campaign naming from infrastructure patterns
- `scoreProvider()` — Hosting provider reputation scoring
- `checkCostGuard()` — API cost control for non-critical agents

### Agent Registry

Agents are registered in `packages/trust-radar/src/agents/index.ts`. The registry maps agent names to modules for the scheduler and API.

### Cost Guard

Non-critical agents (Observer, Strategist, Seed Strategist) check a cost guard before making API calls. This prevents runaway Anthropic API costs by tracking daily token usage.

---

## Agent Reference

### Sentinel

| Property | Value |
|----------|-------|
| **File** | `packages/trust-radar/src/agents/sentinel.ts` |
| **Trigger** | Hourly tick — event-dispatched when the feed scan ingests new threats |
| **Purpose** | Classify new threats, assign confidence scores and severity |

The Sentinel runs on every feed ingestion cycle. It processes newly ingested threats that lack classification:

- **AI classification** — Sends threat domain/URL to Claude Haiku for threat type classification and severity assignment
- **Homoglyph detection** — Detects Unicode/visual lookalike characters in domains (Cyrillic 'a', '0' for 'o', etc.)
- **Brand squatting detection** — Identifies domains containing brand keywords (e.g., `paypal-verify.com`)
- **Confidence scoring** — Assigns 0-100 confidence scores based on source quality and threat type
- **Fallback** — Uses rule-based classification when Haiku is unavailable

**Inputs:** Unclassified threats from the `threats` table
**Outputs:** Updated threat records with `severity`, `confidence_score`, and `threat_type`

---

### Analyst

| Property | Value |
|----------|-------|
| **File** | `packages/trust-radar/src/agents/analyst.ts` |
| **Trigger** | Scheduled — every hourly tick (dispatched via `ctx.waitUntil`) |
| **Purpose** | Brand attribution for threats that rule-based detection missed |

The Analyst processes threats that have no `target_brand_id` assigned. It uses Claude Haiku to infer which brand is being targeted from domain and URL patterns, supplementing the rule-based detection in `packages/trust-radar/src/lib/brandDetect.ts`.

- Loads the top 100 known brands for context
- Filters against the safe domain allowlist (`packages/trust-radar/src/lib/safeDomains.ts`)
- Runs brand-threat correlation via `packages/trust-radar/src/brand-threat-correlator.ts`
- Processes up to 30 unattributed threats per run

**Inputs:** Threats with `target_brand_id IS NULL` and a non-null `malicious_domain`
**Outputs:** Updated `target_brand_id` on threat records; `agent_outputs` entries

---

### Observer

| Property | Value |
|----------|-------|
| **File** | `packages/trust-radar/src/agents/observer.ts` |
| **Trigger** | Scheduled — daily at 00:00 UTC (inline await on the hourly mesh) |
| **Purpose** | Generate intelligence briefings from trend analysis |

The Observer synthesizes threat data from the last 24 hours into human-readable intelligence briefings. It gathers:

- Threat volume and severity distribution
- Top targeted brands (with IDs for dashboard linking)
- Top hosting providers
- Recent agent outputs from other agents
- Feed health status

This context is sent to Claude Haiku, which generates 3-5 professional intelligence briefing items. Briefings are stored as `agent_outputs` and surfaced in the HUD and insights panel. Creates user notifications for critical findings.

**Inputs:** Aggregated threat statistics, brand targeting patterns, provider data
**Outputs:** Intelligence briefing entries in `agent_outputs`; user notifications

---

### Strategist

| Property | Value |
|----------|-------|
| **File** | `packages/trust-radar/src/agents/strategist.ts` |
| **Trigger** | Scheduled — every 6 hours (hours 0/6/12/18, via `ctx.waitUntil`) |
| **Purpose** | Campaign correlation and clustering |

The Strategist identifies coordinated threat campaigns by correlating shared infrastructure:

- **IP clustering** — Groups threats sharing the same IP address (3+ threats threshold)
- **ASN clustering** — Groups threats from the same autonomous system
- **Registrar clustering** — Identifies bulk domain registrations
- **Timing analysis** — Detects threats registered in close temporal proximity

When clusters are found, Claude Haiku generates descriptive campaign names. New campaigns are created in the `campaigns` table, and threats are linked via `campaign_id`.

**Inputs:** Uncampaigned active threats with shared infrastructure indicators
**Outputs:** New/updated `campaigns` records; linked threats; `agent_outputs` entries

---

### Cartographer

| Property | Value |
|----------|-------|
| **File** | `packages/trust-radar/src/agents/cartographer.ts` |
| **Trigger** | Scheduled — every hourly tick (dispatched as `CartographerBackfillWorkflow`) |
| **Purpose** | Infrastructure mapping and hosting provider reputation scoring |

The Cartographer operates in two phases:

1. **Geo enrichment** — Enriches threats missing geographic data (IP geolocation via `packages/trust-radar/src/lib/geoip.ts`)
2. **Provider scoring** — Uses Claude Haiku to score the top 50 hosting providers based on threat volume, response times, and trends

Also runs email security scans for monitored brands via `packages/trust-radar/src/email-security.ts`.

**Inputs:** Threats missing `country_code`; hosting providers with `total_threat_count > 0`
**Outputs:** Enriched threat records; provider reputation scores; `agent_outputs` entries

---

### Pathfinder

| Property | Value |
|----------|-------|
| **File** | `packages/trust-radar/src/agents/pathfinder.ts` |
| **Trigger** | Scheduled — daily at 03:00 UTC (KV throttle enforces ≤1 run per 7 days) |
| **Purpose** | Sales intelligence and lead generation |

Pathfinder (formerly "Prospector") implements a three-stage pipeline:

1. **Prospect identification** — Scores brands from platform data (threat count, email security grade, phishing URLs, spam trap catches) to identify high-value sales prospects
2. **Company research** — Uses Claude Haiku to research the company and identify security leadership contacts
3. **Outreach generation** — Generates personalized outreach email drafts with two subject/body variants

Processes up to 5 prospects per run. Results are stored in the `sales_leads` table with pipeline status tracking (identified, researched, drafted, approved, sent, responded, booked, converted, declined).

**Inputs:** Brand data with threat metrics, email security scores
**Outputs:** `sales_leads` records with research and outreach drafts

---

### Sparrow

| Property | Value |
|----------|-------|
| **File** | `packages/trust-radar/src/agents/sparrow.ts` |
| **Trigger** | Scheduled — every 6 hours (hours 0/6/12/18, via `ctx.waitUntil`) |
| **Purpose** | Takedown automation — drafts and submits takedown requests for active phishing infrastructure |

Sparrow identifies active threats with high confidence and drafts takedown notices routed to hosting provider abuse desks, registrars, and brand-protection platforms.

**Inputs:** Active threats with resolved hosting/registrar attribution
**Outputs:** Takedown submissions tracked in `takedowns` table; `agent_outputs` entries

---

### Nexus

| Property | Value |
|----------|-------|
| **File** | `packages/trust-radar/src/agents/nexus.ts` |
| **Trigger** | Scheduled — every 4 hours (hours 0/4/8/12/16/20, dispatched as `NexusWorkflow`) |
| **Purpose** | Infrastructure cluster detection — the operations layer |

Nexus correlates shared infrastructure (IPs, ASNs, certificates, registrars, naming patterns) into `infrastructure_clusters` rows that represent distinct threat actor operations. Pivot detection emits immediate events for Observer.

**Inputs:** Enriched threats, certificates, providers
**Outputs:** `infrastructure_clusters` rows; `pivot_detected` / `cluster_detected` events

---

### Attributor

| Property | Value |
|----------|-------|
| **File** | `packages/trust-radar/src/agents/attributor.ts` |
| **Trigger** | Scheduled — every 4 hours at `hour % 4 === 1` (one tick after Nexus) |
| **Purpose** | Classifies Nexus infrastructure clusters by responsible threat actor |

Attributor (codename `ATTRIBUTOR`) is Phase C of the Threat Actors rebuild. For each active `infrastructure_clusters` row that doesn't yet have an `actor_id`, it summarizes the cluster's distinguishing signals (ASNs, countries, attack types, top targeted brands, agent notes) and asks Haiku for the canonical APT / cybercrime group name — or `unknown` if the signals are too generic.

For resolved clusters: upserts the actor in `threat_actors` (`source='nexus'`), caches the cluster→actor mapping on `infrastructure_clusters.actor_id`, and writes a `threat_attributions` row (`source='nexus'`) for every threat in the cluster. The unified attribution table means the Threat Actors page reads one shape regardless of source (OTX pulses, Nexus clusters, news/RSS — Phase D).

For unresolved clusters: stamps `attribution_attempted_at = now()` so the agent doesn't re-pay the AI cost for at least 7 days (configurable via `RETRY_COOLDOWN_DAYS`).

**Bounded:** at most 25 clusters per run (`CLUSTER_BATCH`), prioritizing by `threat_count DESC, last_seen DESC`. Worst-case cost: 150 Haiku calls/day at 6 runs.

**Inputs:** `infrastructure_clusters` (where `actor_id IS NULL`), `threats`
**Outputs:** `threat_actors` upserts, `threat_attributions` rows, `infrastructure_clusters.actor_id` writes

---

### Narrator

| Property | Value |
|----------|-------|
| **File** | `packages/trust-radar/src/agents/narrator.ts` |
| **Trigger** | Scheduled — daily at 06:00 UTC (via `executeAgent`, after Observer briefing) |
| **Purpose** | Multi-signal threat narrative generation per brand |

Narrator correlates threats, email security posture, social impersonation, lookalike domains, and suspicious CT certificates into a coherent attack narrative. Generates a narrative only when a brand has ≥2 distinct signal types. Limits to 5 narratives per run for cost control. High-severity narratives also create alerts.

**Inputs:** Per-brand signals from `threats`, `brands.email_security_*`, `social_monitor_results`, `lookalike_domains`, `ct_certificates`
**Outputs:** `threat_narratives` rows; high/critical severity also creates `alerts` rows

---

### Notification Narrator

| Property | Value |
|----------|-------|
| **File** | `packages/trust-radar/src/agents/notification_narrator.ts` |
| **Trigger** | Scheduled — daily at 13:00 UTC (via `executeAgent`, alongside the legacy briefing email cron) |
| **Purpose** | Per-user daily digest envelope builder (Q5b backlog) |

Notification Narrator queries each active user's last-24h notifications above their `digest_severity_floor`, then emits a single `notification_digest` envelope row to the user's inbox. The envelope's `metadata.notification_ids[]` lists the underlying rows so the UI can deep-link. When the AI cost guard allows, Haiku writes a 1–3 sentence narrative summary; otherwise the agent falls back to a static count line.

**Inputs:** `notification_preferences_v2`, `notifications` (last 24h), `users`
**Outputs:** `notifications` rows of type `notification_digest` (via `createNotification` helper)

---

### Trustbot

| Property | Value |
|----------|-------|
| **File** | `packages/trust-radar/src/agents/trustbot.ts` |
| **Trigger** | Manual — on user request via `/api/trustbot/chat` |
| **Purpose** | Interactive AI threat intelligence copilot |

Trustbot is a conversational agent that answers questions about threats, IOCs, and platform status. It is not a scheduled agent -- it runs on demand via the chat API endpoint.

Based on query keywords, Trustbot automatically gathers relevant context:

- Threat statistics (when query mentions "threat", "overview", "status")
- Domain lookups (when query contains a domain pattern)
- IP lookups (when query contains an IP address)
- Brand information (when query mentions "brand")

Context is sent to Claude Haiku along with the user's question for a contextual response.

**Inputs:** User query string + auto-gathered DB context
**Outputs:** AI-generated response with supporting data

---

### Seed Strategist

| Property | Value |
|----------|-------|
| **File** | `packages/trust-radar/src/agents/seed-strategist.ts` |
| **Trigger** | Scheduled — daily at 6am UTC |
| **Purpose** | Spam trap seeding strategy and coverage optimization |

The Seed Strategist analyzes spam trap performance and identifies coverage gaps:

- Gathers 7-day trap capture metrics (by channel: generic, brand, spider, paste, honeypot)
- Identifies brands with high threat counts but no trap catches
- Uses Claude Haiku to recommend new seeding campaigns
- Auto-creates campaigns and seed addresses based on AI recommendations

**Inputs:** Spam trap capture statistics; brand threat data; existing campaign performance
**Outputs:** New seeding campaigns; seed addresses; `agent_outputs` entries

---

### Cube Healer

| Property | Value |
|----------|-------|
| **File** | `packages/trust-radar/src/agents/cube-healer.ts` |
| **Trigger** | Scheduled — every 6 hours (`12 */6 * * *`) |
| **Purpose** | Retroactive drift remediation for OLAP cube tables |

The Cube Healer performs a full 30-day bulk rebuild of all three OLAP cube tables (`threat_cube_geo`, `threat_cube_provider`, `threat_cube_brand`) via `INSERT OR REPLACE ... SELECT ... GROUP BY`. This bounds drift from Cartographer's retroactive enrichment to ≤6 hours.

- **Scope** — Excludes the current partial hour (Navigator's territory). The previous hour overlap is intentional and safe because `INSERT OR REPLACE` is idempotent.
- **Status semantics** — All cubes succeed → `success`; some fail → `partial`; first cube throws → `failed`
- **agent_runs lifecycle** — Inserts a `partial` row at start (crash-safe), updates to final status on completion

**Inputs:** Raw `threats` table (30-day window, active status)
**Outputs:** Rebuilt rows in `threat_cube_geo`, `threat_cube_provider`, `threat_cube_brand`

---

## Surveillance & Discovery Agents

These cron-driven scanners feed the threat mesh. Each delegates to a scanner module in `src/scanners/` or a dedicated lib helper; they're registered as `AgentModule`s so FC supervision, circuit breakers, and `agent_runs` lifecycle apply uniformly.

| Agent | Cadence | Purpose |
|---|---|---|
| **Curator** | Event-driven | Platform hygiene — email security scanning, safe-domain cleanup, social-profile discovery |
| **Watchdog** | Event-driven | Social-mention threat classifier — Haiku-classifies unclassified mentions, escalates high/critical findings |
| **Mockingbird** (`social_monitor`) | Every 6h | Catches social impersonators across Twitter / LinkedIn / Instagram / TikTok / GitHub / YouTube |
| **Outrider** (`social_discovery`) | Every 6h | Discovers brand-owned social handles before Mockingbird monitors them |
| **Marshal** (`app_store_monitor`) | Every 6h | iOS App Store impersonation scanner — bundle-ID + name similarity |
| **Sounder** (`dark_web_monitor`) | Every 6h | Pastebin / breach-archive monitoring for brand mentions |
| **Recon** (`auto_seeder`) | Weekly (Sun 05:07 UTC) | Plants spam-trap addresses into harvester channels and tracks per-location yield |
| **Lookalike Scanner** (`lookalike_scanner`) | Hourly | Cron-driven scanner — DNS / HTTP / MX checks + Haiku assessment of newly-registered typosquat candidates |
| **Enricher** (`enricher`) | Hourly | Domain geo, brand logo / HQ, brand sector / RDAP enrichment — runs every hourly tick |
| **GeoIP Refresh** (`geoip_refresh`) | Weekly (Sun 02:00 UTC) | Polls MaxMind for new GeoLite2-City releases and re-imports only when the `.sha256` fingerprint differs from the last loaded version. Most polls are no-ops; on a new release the `GeoipRefreshWorkflow` streams the ZIP via HTTP Range, decompresses + chunk-inserts to `GEOIP_DB`, and atomically swaps in the new data. Zero R2/CLI dependency — fully in-Worker. Cartographer Phase 0.5 falls through to ip-api/ipinfo when the table isn't yet populated. **Self-healing:** four layers per AGENT_STANDARD §15 — (A) workflow's `try/catch` around step orchestration marks `geo_ip_refresh_log` failed if any step throws; (B) agent's pre-dispatch idempotency check force-fails stuck rows >60min and refuses dispatch when a young workflow is in flight (unless `forceReload`); (C) Flight Control supervisor catches anything that escapes A+B, emits `platform_geoip_refresh_stalled` notification with the standard dedup pattern; (D) MaxMind 429 cooldown stamps a 24h KV key on quota exhaustion so subsequent dispatches don't burn additional download budget. |

---

## Synchronous AI Agents

The Phase 3 sync-agent class (AGENT_STANDARD §2). Each is HTTP-handler-driven (`trigger: "api"`) — invoked via `runSyncAgent()` from a route handler instead of dispatched on a cron. Lifecycle is identical (one `agent_runs` row per call, AI calls land in `budget_ledger` under the agent's id) but the call path is request → handler → `runSyncAgent` → AI → response. All 13 are Haiku-backed with input/output schemas (Zod) and deterministic fallbacks.

| Agent | Surface | Description |
|---|---|---|
| **Public Trust Check** (`public_trust_check`) | `POST /api/v1/public/assess` | Anonymous homepage trust-score lookups (prompt-injection-hardened) |
| **Qualified Report** (`qualified_report`) | Admin-triggered | Customer-facing brand risk reports (narrative + remediation, Haiku × 2) |
| **Brand Analysis** (`brand_analysis`) | Brand detail page | Per-brand threat assessment (structured JSON) |
| **Brand Report** (`brand_report`) | Per-brand exposure report | Executive summary + recommendations (Haiku × 2) |
| **Brand Deep Scan** (`brand_deep_scan`) | Per-request batch | Y/N classification of unlinked threat URLs against a brand identity (up to 200 internal calls) |
| **Honeypot Generator** (`honeypot_generator`) | Spam-trap renderer | Renders complete honeypot trap websites with embedded mailtos (Haiku × 3) |
| **Brand Enricher** (`brand_enricher`) | Brand registration | Classifies brands into a fixed sector taxonomy (20-token bounded reply) |
| **Admin Classify** (`admin_classify`) | Admin backfill | Haiku classifies threats with `NULL` confidence_score (batch, up to 200 calls per run, rule-based fallback) |
| **URL Scan** (`url_scan`) | Public URL scan endpoint | Generates short security insights with structured JSON output |
| **Scan Report** (`scan_report`) | Brand exposure report | Executive narrative for the public Brand Exposure Report (512-token bounded prose) |
| **Social AI Assessor** (`social_ai_assessor`) | Mockingbird + brand detail | Haiku classifies social profiles for brand impersonation (called by both the scanner and on-demand reassessment) |
| **Geo Campaign Assessment** (`geo_campaign_assessment`) | Geopolitical campaign page | 4-paragraph executive intel assessment (1024-token bounded prose) |
| **Evidence Assembler** (`evidence_assembler`) | Sparrow + admin manual | Generates structured takedown evidence packages from a takedown + collected intel |

---

## Agent Scheduling Summary

The hourly mesh cron is `7 * * * *`. All time gates below use hour-only checks on `event.scheduledTime.getUTCHours()` — never minute gates (see `CLAUDE.md §6 — Cron-audit rule`).

| Agent | Frequency | Dispatch | Cost Guard | Approval Required |
|-------|-----------|----------|------------|-------------------|
| Sentinel | Hourly tick when feed ingest produces `totalNew > 0` | Inline await | No | No |
| Analyst | Every hourly tick | `ctx.waitUntil` | No | No |
| Cartographer | Every hourly tick | `CartographerBackfillWorkflow` | No | No |
| Strategist | Every 6 hours (hours 0/6/12/18) | `ctx.waitUntil` | Yes | No |
| Nexus | Every 4 hours (hours 0/4/8/12/16/20) | `NexusWorkflow` | No | No |
| Sparrow | Every 6 hours (hours 0/6/12/18) | `ctx.waitUntil` | No | No |
| Observer | Daily at 00:00 UTC | Inline await | Yes | No |
| Pathfinder | Daily at 03:00 UTC (KV throttle to 7 days) | Inline await | No | No |
| Seed Strategist | Daily at 06:00 UTC (inside Observer briefing job) | Inline await | Yes | No |
| Narrator | Daily at 06:00 UTC (after Observer briefing) | `executeAgent` | Yes | No |
| Trustbot | On demand (`/api/trustbot/chat`) | Manual | No | No |
| Cube Healer | Every 6 hours (`12 */6 * * *`) | Dedicated cron | No | No |
| Navigator | Every 5 minutes (`*/5 * * * *`) | Dedicated cron | No | No |
| Flight Control | Every hourly tick (first) | Inline await | No | No |

---

## Infrastructure Agents

In addition to the AI-powered agents above, two infrastructure agents maintain the OLAP cube layer:

### Navigator (`src/cron/navigator.ts`)

Runs every 5 minutes on its own cron. Independent of Flight Control's dispatch —
FC monitors Navigator's health but does not manage it. Previously known as
`fast_tick`; historical `agent_runs` rows use `agent_id='fast_tick'` and new
runs write `agent_id='navigator'`. Not an AI agent — pure SQL. Responsibilities:

1. **DNS resolution** (primary mission) — resolve malicious domains to IP
   addresses so Cartographer can geo-enrich them (200 domains / 8s batch)
2. Drain stale pending `agent_events` (housekeeping)
3. Rebuild current + previous hour for all 3 cube tables (6 cube builds)
4. Pre-warm KV caches for Observatory, Dashboard, Agents, Operations pages

Navigator finds the path (IP addresses); Cartographer maps the terrain (lat/lng,
country, provider).

### Cloudflare Workflows

Heavy agents are dispatched as durable Workflows instead of running inline in the cron handler:
- **CartographerBackfillWorkflow** — dispatched by orchestrator for Cartographer enrichment
- **NexusWorkflow** — dispatched by orchestrator for NEXUS clustering

This prevents long-running agents from blocking the cron mesh or hitting the 30s Worker CPU limit.
