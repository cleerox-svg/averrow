# AI Agents

Averrow uses a mesh of AI agents plus infrastructure agents (Navigator, Cube Healer) powered by Claude Haiku via the Anthropic API. Agents are defined as modules in `packages/averrow-worker/src/agents/` and orchestrated by the agent runner in `packages/averrow-worker/src/lib/agentRunner.ts`. The registry is `packages/averrow-worker/src/agents/index.ts`.

**Companion docs:**
- [`AGENT_STANDARD.md`](./AGENT_STANDARD.md) — the contract every agent must satisfy (lifecycle, resource declarations, output schemas, per-agent budgets, approval gates, tests).
- [`AGENT_AUDIT.md`](./AGENT_AUDIT.md) — read-only audit findings against the standard. Phase 2 + Phase 3 closed (2026-05-09 refresh); Phase 4 + Phase 5 in progress.
- [`PLATFORM_DATA_DEPENDENCIES.md`](./PLATFORM_DATA_DEPENDENCIES.md) — cross-surface map of which UI / API / notification path reads from which table, the workflow-agent reconciliation rule, and the checklist when adding a new surface that derives agent status.

This doc is the canonical "what does each agent do" reference. For "what's the status of agent X against the standard," consult the audit. For "how do I write a new agent," consult the standard.

## Name map — agent_id ↔ file ↔ UI display name

Agents are referred to by up to three names: the registry `agent_id` (what
`agent_runs`/`agent_configs` store), the file in `src/agents/`, and the display
name/codename shown in the ops UI (`packages/averrow-ops/src/lib/agent-metadata.ts`).
When grepping, use the file name; when querying D1, use the agent_id.

| agent_id | File (`src/agents/`) | UI display name | Codename |
|---|---|---|---|
| sentinel | sentinel.ts | Sentinel | — |
| analyst | analyst.ts | Analyst | **ASTRA** |
| cartographer | cartographer.ts | Cartographer | — |
| navigator | (cron, `src/cron/`) | Navigator | — (historical runs use `fast_tick`) |
| nexus | nexus.ts | NEXUS | — |
| strategist | strategist.ts | Strategist | — |
| observer | observer.ts | Observer | — |
| sparrow | sparrow.ts | Sparrow | — |
| pathfinder | pathfinder.ts | Pathfinder | — |
| flight_control | flightControl.ts | Flight Control | — |
| attributor | attributor.ts | Attributor | — |
| news_watcher | news-watcher.ts | News Watcher | — |
| watchdog | watchdog.ts | Watchdog | — |
| curator | curator.ts | Curator | — |
| cube_healer | cube-healer.ts | Cube Healer | — |
| narrator | narrator.ts | Narrator | — |
| notification_narrator | notification_narrator.ts | Notification Narrator | — |
| social_discovery | socialDiscovery.ts | Social Discovery | — |
| social_monitor | socialMonitor.ts | **Mockingbird** | social_monitor |
| app_store_monitor | appStoreMonitor.ts | App Store Monitor | — |
| dark_web_monitor | darkWebMonitor.ts | Dark Web Monitor | — |
| trademark_monitor | trademarkMonitor.ts | **Herald** | trademark_monitor |
| ct_monitor | ct-monitor.ts | **Watchtower** | ct_monitor |
| executive_monitor | executiveMonitor.ts | **Doppelganger** | executive_monitor |
| auto_seeder | auto-seeder.ts | **Recon** | auto_seeder |
| seed_strategist | seed-strategist.ts | Seed Strategist | — |
| enricher | enricher.ts | Enricher | — |
| geoip_refresh | geoip-refresh.ts | GeoIP Refresh | — |
| campaign_hunter | campaign-hunter.ts | Campaign Hunter | — |
| evidence_assembler | evidence-assembler.ts | Evidence Assembler | — |
| abuse_mailbox_classifier | abuseMailboxClassifier.ts | **Sifter** | abuse_mailbox_classifier |
| brand_enricher | brand-enricher.ts | Brand Enricher | — |
| lookalike_scanner | lookalike-scanner.ts | Lookalike Scanner | — |
| trustbot | trustbot.ts | TrustBot | — |
| *retired (status flip 2026-05-14, files + routes intact):* admin_classify, brand_analysis, brand_deep_scan, brand_report, geo_campaign_assessment, honeypot_generator, public_trust_check, qualified_report, scan_report, social_ai_assessor, url_scan | hyphenated file names | plain names | — |

## Agent Infrastructure

### Agent Runner

The agent runner (`packages/averrow-worker/src/lib/agentRunner.ts`) provides the execution framework. Each agent implements the `AgentModule` interface:

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

All agents use Claude Haiku via the direct Anthropic API. The AI client is in `packages/averrow-worker/src/lib/haiku.ts` and provides specialized functions:

- `inferBrand()` — Brand identification from domain/URL patterns
- `classifyThreat()` — Threat classification and severity scoring
- `generateInsight()` — Intelligence narrative generation
- `generateCampaignName()` — Campaign naming from infrastructure patterns
- `scoreProvider()` — Hosting provider reputation scoring
- `checkCostGuard()` — API cost control for non-critical agents

### Agent Registry

Agents are registered in `packages/averrow-worker/src/agents/index.ts`. The registry maps agent names to modules for the scheduler and API.

### Cost Guard

Non-critical agents (Observer, Strategist, Seed Strategist) check a cost guard before making API calls. This prevents runaway Anthropic API costs by tracking daily token usage.

### Operator Surfaces

Two operator-facing pages render the mesh, switchable in real time via the [`VersionToggle('agents')`](../packages/averrow-ops/src/components/ui/VersionToggle.tsx) in the page header. The toggle persists per-device in `localStorage` (`averrow.agents-version`) and the Sidebar / MobileNav "Agents" link follows whichever version is active.

| Surface | Path | Purpose |
|---|---|---|
| **Agents (v2)** | `/agents` | Established Monitor / History / Config tabbed view. Wide per-agent detail panels. Default for the `'agents'` surface. |
| **Agents (v3 preview)** | `/agents-v3` | Next-gen layout — supervisor section at top, workers grouped by category, click-to-expand details, **Network View** mind-map at the bottom. Opt-in via toggle until v3 reaches feature parity. |

**`/agents-v3` surfaces (per `AGENT_AUDIT.md §8`):**

- **Supervisor section** — Flight Control rendered as a first-class concept above the worker grid (`SUPERVISOR_AGENT_IDS`, currently just `flight_control`). New supervisors land by adding their id to the constant.
- **Worker grouping** — agents bucket into 5 sections by `AGENT_METADATA.category`: Intelligence, Response, Platform Ops, Synchronous AI, Meta.
- **Connectivity chips** — every card shows ← upstream / → downstream chips encoded from the `TRIGGER_CHAIN` constant in [`AgentsV3.tsx`](../packages/averrow-ops/src/features/agents-v3/AgentsV3.tsx). Source of truth for the chain itself is [§ Agent trigger chain in `CLAUDE.md`](../CLAUDE.md#6-agent-architecture-rules).
- **Failure-pattern badge** — derived from existing `Agent` payload fields (`circuit_state` / `last_run_status` / `error_count_24h` ratio). Worst-first match: tripped circuit > failing > high error rate > paused. Card variant flips to `critical` for the worst signals.
- **24h activity sparkline** — `agent.activity` array rendered via `<ActivitySparkline />`, color-flips to `var(--sev-high)` when a failure pattern is active.
- **Click-to-expand detail panel** — fetches `useAgentDetail` + `useAgentHealth` lazily on selection. Renders 7d run/error sparklines, lifetime stats (total/success/failures), last error in a sev-bordered code block, and the last 5 outputs with summary + type + relative time + severity dot.
- **Compliance chips** — read real signals: `Registered ✓` (entry in `AGENT_METADATA`), `Metadata ✓` (subtitle present), `Schema ✗` (Phase 4), `Budget ✗` (§11). Honest 2/4 reflects current Phase 2/3 progress.
- **Decommission heuristic** — flags any agent whose `last_run_at` is older than 14 days. Surface count appears in the top "Failure Patterns" stat card.

**Network View ([`AgentNetworkView.tsx`](../packages/averrow-ops/src/features/agents-v3/components/AgentNetworkView.tsx)):**

Pure-SVG interactive mind-map of the trigger chain. No new dependencies — flips with `[data-theme]` for free via CSS-var colors.

| Visual | Meaning |
|---|---|
| Solid arrowed edge | Trigger-chain edge (sentinel → cartographer, etc.) |
| Dashed muted line from Flight Control | Supervision relationship |
| Pulsing amber edge + amber arrowhead | Upstream agent's `last_run_at` within last 10 minutes — **work in flight** |
| Red ring around node | `circuit_state='tripped'` or `last_run_status='failed'` |
| Animated amber halo | Selected node |

Clicking a node selects it in the parent `AgentsV3` `selectedAgent` state — the matching grid card's detail panel opens above the network. The 1-hop subgraph stays full opacity; non-neighbours fade to 0.20.

Sync agents (handler-driven, no inter-agent edges) and the ops cluster (`cube_healer`, `navigator`, `enricher`, `geoip_refresh`) are intentionally omitted from the view — they have nothing meaningful to draw edges to. They remain visible in the worker-grid above.

---

## Agent Reference

### Sentinel

| Property | Value |
|----------|-------|
| **File** | `packages/averrow-worker/src/agents/sentinel.ts` |
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
| **File** | `packages/averrow-worker/src/agents/analyst.ts` |
| **Trigger** | Scheduled — every hourly tick (dispatched via `ctx.waitUntil`) |
| **Purpose** | Brand attribution for threats that rule-based detection missed |

The Analyst processes threats that have no `target_brand_id` assigned. It uses Claude Haiku to infer which brand is being targeted from domain and URL patterns, supplementing the rule-based detection in `packages/averrow-worker/src/lib/brandDetect.ts`.

- Loads the top 100 known brands for context
- Filters against the safe domain allowlist (`packages/averrow-worker/src/lib/safeDomains.ts`)
- Runs brand-threat correlation via `packages/averrow-worker/src/brand-threat-correlator.ts`
- Processes up to 30 unattributed threats per run

**Outputs** (`agent_outputs`): writes `type='insight'` rows for actionable narratives —
"Active Phishing + No DMARC", "AI-Generated Threat Detected", "Risk Score Spike",
"External Validation" — and one `type='diagnostic'` per-run summary. Insight rows
surface via `/api/insights/latest` → Home "Latest Intel" section. (Pre-2026-05-16
audit, insights were `type='classification'` and never reached any consumer.)

**Inputs:** Threats with `target_brand_id IS NULL` and a non-null `malicious_domain`
**Outputs:** Updated `target_brand_id` on threat records; `agent_outputs` entries

---

### Observer

| Property | Value |
|----------|-------|
| **File** | `packages/averrow-worker/src/agents/observer.ts` |
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
| **File** | `packages/averrow-worker/src/agents/strategist.ts` |
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
| **File** | `packages/averrow-worker/src/agents/cartographer.ts` |
| **Trigger** | Scheduled — every hourly tick (dispatched as `CartographerBackfillWorkflow`) |
| **Purpose** | Infrastructure mapping and hosting provider reputation scoring |

The Cartographer operates in two phases:

1. **Geo enrichment** — Enriches threats missing geographic data (IP geolocation via `packages/averrow-worker/src/lib/geoip.ts`)
2. **Provider scoring** — Uses Claude Haiku to score the top 50 hosting providers based on threat volume, response times, and trends

Also runs email security scans for monitored brands via `packages/averrow-worker/src/email-security.ts`.

**Inputs:** Threats missing `country_code`; hosting providers with `total_threat_count > 0`
**Outputs:** Enriched threat records (`threats.registrar`, `registration_date` populated via IANA RDAP bootstrap — switched from rdap.org in PR-C of the 2026-05-16 audit because rdap.org returns HTTP 403 to CF Workers); provider reputation scores (`hosting_providers.reputation_score`); `agent_outputs` entries (`type='insight'` for providers with reputation <70 OR repeat-offender ≥3 campaigns, `type='diagnostic'` for per-run stats); `provider_threat_stats` rows (today / 7d / 30d / all-time, written by `aggregateProviderStats` and read by `GET /api/providers/stats`)

**AI cost gate (2026-05-16 audit):** Cartographer skips Haiku scoring for providers
with fewer than 5 active threats AND no campaign history — those produce flat 90-100
heuristic scores that nobody triages. Saves ~40% of cartographer's daily AI spend
(~$1.50/day at current threat volume) without losing signal on providers operators
actually act on. The full Haiku payload (`risk_factors`, `response_assessment`) now
surfaces via `/api/insights/latest` → Home "Latest Intel" section; previously
written to `agent_outputs(type='score')` with zero readers.

---

### Pathfinder

| Property | Value |
|----------|-------|
| **File** | `packages/averrow-worker/src/agents/pathfinder.ts` |
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
| **File** | `packages/averrow-worker/src/agents/sparrow.ts` |
| **Trigger** | Scheduled — every 6 hours (hours 0/6/12/18, via `ctx.waitUntil`) |
| **Purpose** | Takedown automation — drafts and submits takedown requests for active phishing infrastructure |

Sparrow identifies active threats with high confidence and drafts takedown notices routed to hosting provider abuse desks, registrars, and brand-protection platforms.

**Outbound email (S1, 2026-06):** Phase G dispatches through
`lib/takedown-submitters/`. When `TAKEDOWN_SEND_MODE='live'` (wrangler var,
default `'draft'`), the email-send submitter delivers the abuse report via
Resend from `takedowns@averrow.com` (Reply-To routes into the abuse-mailbox
pipeline, migration 0214) and Phase H follow-ups send the same way. In draft
mode behavior is the historical queued-draft flow for manual ops send.
Gates, all required: org entitlement (`org_modules`) + signed
`takedown_authorizations` covering the module + provider
`auto_submit_enabled=1` + the signed `scope_json.max_takedowns_per_month`
(enforced in Phase G; cap exhaustion leaves drafts and fires a
`takedown_monthly_cap_reached` tenant notification once per org per month).
Kill switch: flip the var back to `'draft'`.

**Inputs:** Active threats with resolved hosting/registrar attribution
**Outputs:** Takedown submissions tracked in `takedowns` table; `agent_outputs` entries

---

### Nexus

| Property | Value |
|----------|-------|
| **Workflow** | `packages/averrow-worker/src/workflows/nexusRun.ts` (class `NexusWorkflow`, binding `NEXUS_RUN`) |
| **Agent module (fallback)** | `packages/averrow-worker/src/agents/nexus.ts` (manual trigger only at `/api/internal/agents/nexus/run`) |
| **Trigger** | Scheduled — every 4 hours (hours 0/4/8/12/16/20). Cron at `hour % 4 === 0` calls `dispatchWorkflow()` in `lib/workflow-dispatch.ts`, which has KV cooldown on `WorkflowInternalError` + last-dispatch stamp watched by FC supervisor. |
| **Purpose** | Infrastructure cluster detection — the operations layer |

Nexus correlates shared infrastructure into `infrastructure_clusters` rows that represent distinct threat actor operations, via a 6-lane precedence pipeline (most-specific first — first lane to claim a threat wins): cert-serial → cert-SAN → per-IP fan-out → /24 subnet → registrar cohort → ASN (mops up leftovers). The cert lanes run first because shared certificate identity is near-conclusive same-operator evidence; the ASN pass runs last even though it's the oldest lane. Pivot detection emits immediate events for Observer.

**Connected-components post-pass (S2.4 / D5a):** after all six lanes finish, `lib/cluster-components.ts`'s `groupClusterComponents()` runs as a pure-SQL, no-AI post-pass that groups the per-key `infrastructure_clusters` rows a single operator spans (e.g. one cert-serial cluster + one per-IP cluster) into a transitive component, stamping `infrastructure_clusters.component_id`. Edges are **specific-evidence only** — cert-serial / cert-SAN / per-IP clusters may bridge; ASN / /24 / registrar clusters are receive-only leaves and can never connect two bridges (the over-merge trap). A hub-fan-out exclusion (>150 brands) and a 25-cluster component-size cap both fail safe toward under-merge. `component_id` is derived deterministically from the minimum bridge-cluster id, so it's stable run-over-run and identical whether Nexus ran via the agent-module fallback or the `NEXUS_RUN` workflow. Wired identically into both `agents/nexus.ts` and `workflows/nexusRun.ts`. Purely additive: it does not touch `threats.cluster_id` stamping or `lib/cluster-attribution-inherit.ts`, and does not widen the `asns` array the Attributor's `asns.length>=3` auto-Haiku gate reads.

**Infrastructure-movement pivot (S2.4 / D5b):** a second post-pass, `lib/cluster-components.ts`'s sibling `lib/cluster-infra-movement.ts`'s `detectClusterInfraMovement()`, diffs each **bridge-kind** cluster's (cert-serial / cert-SAN / per-IP only — same parity rationale as D5a) current infra set (IPs/ASNs/cert-serials, from member threats) against its stored `infrastructure_clusters.infra_fingerprint` and emits a SECOND `pivot_detected` trigger (`payload_json.kind='infra_movement'`, same event_type/target_agent as the existing dormancy trigger — no new dispatch wiring) when a cluster gains new infra. Flood-controlled: requires a prior fingerprint snapshot, confidence > 40 + hub exclusion, growth thresholds (≥1 new ASN / ≥3 new IPs / ≥2 new serials), 24h per-cluster cooldown, per-run cap of 5, and an over-cap skip (>256 distinct elements in any dimension). Wired identically into both `agents/nexus.ts` and `workflows/nexusRun.ts`. Additive, no AI — does not touch `threats.cluster_id` or the dormancy signal. Migration `0241`.

**Inputs:** Enriched threats, certificates, providers
**Outputs:** `infrastructure_clusters` rows; `infrastructure_clusters.component_id` (D5a post-pass); `infrastructure_clusters.infra_fingerprint` / `infra_fingerprint_at` / `last_movement_pivot_at` (D5b post-pass); `pivot_detected` event (kind `dormancy` or `infra_movement`). (`cluster_detected` is declared in the event-type union but never emitted anywhere in code — see CLAUDE.md §6.)

---

### Attributor

| Property | Value |
|----------|-------|
| **File** | `packages/averrow-worker/src/agents/attributor.ts` |
| **Trigger** | Scheduled — every 4 hours at `hour % 4 === 1` (one tick after Nexus) |
| **Purpose** | Classifies Nexus infrastructure clusters by responsible threat actor |

Attributor (codename `ATTRIBUTOR`) is Phase C of the Threat Actors rebuild. For each active `infrastructure_clusters` row that doesn't yet have an `actor_id`, it summarizes the cluster's distinguishing signals (ASNs, countries, attack types, top targeted brands, agent notes) and asks Haiku for the canonical APT / cybercrime group name — or `unknown` if the signals are too generic.

For resolved clusters: upserts the actor in `threat_actors` (`source='nexus'`), caches the cluster→actor mapping on `infrastructure_clusters.actor_id`, and writes a `threat_attributions` row (`source='nexus'`) for every threat in the cluster. The unified attribution table means the Threat Actors page reads one shape regardless of source (OTX pulses, Nexus clusters, news/RSS — Phase D).

For unresolved clusters: stamps `attribution_attempted_at = now()` so the agent doesn't re-pay the AI cost for at least 7 days (configurable via `RETRY_COOLDOWN_DAYS`).

**Bounded:** at most 25 clusters per run (`CLUSTER_BATCH`), prioritizing by `threat_count DESC, last_seen DESC`. Worst-case cost: 150 Haiku calls/day at 6 runs.

**Inputs:** `infrastructure_clusters` (where `actor_id IS NULL`), `threats`
**Outputs:** `threat_actors` upserts, `threat_attributions` rows, `infrastructure_clusters.actor_id` writes

---

### News Watcher (`news_watcher`)

| Property | Value |
|----------|-------|
| **File** | `packages/averrow-worker/src/agents/news-watcher.ts` |
| **Trigger** | Scheduled — every 6 hours at `hour % 6 === 2` |
| **Purpose** | Ingest threat-intel RSS feeds; extract actors + geopolitical context |

News Watcher is Phase D of the Threat Actors rebuild. Polls a configured set of public threat-intel RSS / Atom feeds (CISA advisories, Microsoft Threat Intelligence blog, Mandiant / Google Cloud blog), dedups by article URL via the `news_articles` table, and asks Haiku to extract per-article structured intel: named threat actors, target countries (ISO-2), target sectors, severity, and whether the article describes geopolitical / state-sponsored activity.

For each new article:

1. **Insert** a `news_articles` row (idempotent on `article_url`) with the extraction status (`ok` / `no_actors` / `failed`) and the JSON output.
2. **Upsert** each extracted actor in `threat_actors` (`source='news'`) — bumps `last_seen` on existing rows, creates new rows for first-seen names.
3. **When `is_geopolitical` is true**, create or update a `geopolitical_campaigns` row keyed by a stable hash of the campaign label (or sorted actor names). Subsequent articles dedup-append to the row's `threat_actors`, `target_countries`, and `target_sectors` JSON arrays.

Bounded: at most 30 new articles per run (`ARTICLES_PER_RUN`). Most cycles see ≤ 5 truly new articles thanks to URL dedup, so the cap rarely bites.

**Inputs:** `news_articles` (read for dedup), three external RSS endpoints
**Outputs:** `news_articles` rows, `threat_actors` upserts, `geopolitical_campaigns` upserts

---

### Narrator

| Property | Value |
|----------|-------|
| **File** | `packages/averrow-worker/src/agents/narrator.ts` |
| **Trigger** | Scheduled — daily at 06:00 UTC (via `executeAgent`, after Observer briefing) |
| **Purpose** | Multi-signal threat narrative generation per brand |

Narrator correlates threats, email security posture, social impersonation, lookalike domains, and suspicious CT certificates into a coherent attack narrative. Generates a narrative only when a brand has ≥2 distinct signal types. Limits to 5 narratives per run for cost control. High-severity narratives also create alerts.

**Inputs:** Per-brand signals from `threats`, `brands.email_security_*`, `social_monitor_results`, `lookalike_domains`, `ct_certificates`
**Outputs:** `threat_narratives` rows; high/critical severity also creates `alerts` rows

---

### Notification Narrator

| Property | Value |
|----------|-------|
| **File** | `packages/averrow-worker/src/agents/notification_narrator.ts` |
| **Trigger** | Scheduled — daily at 13:00 UTC (via `executeAgent`, inside the hourly orchestrator's `hour === 13` gate) |
| **Purpose** | Per-user daily digest envelope builder (Q5b backlog) |

Notification Narrator queries each active user's last-24h notifications above their `digest_severity_floor`, then emits a single `notification_digest` envelope row to the user's inbox. The envelope's `metadata.notification_ids[]` lists the underlying rows so the UI can deep-link. When the AI cost guard allows, Haiku writes a 1–3 sentence narrative summary; otherwise the agent falls back to a static count line.

**Inputs:** `notification_preferences_v2`, `notifications` (last 24h), `users`
**Outputs:** `notifications` rows of type `notification_digest` (via `createNotification` helper)

Note: the daily platform-ops *briefing* (below) no longer shares this
`hour === 13` gate — it moved to its own dedicated cron. The two are
unrelated beyond firing in the same hour.

---

### Daily Briefing (`daily_briefing`) — handler, not an `AgentModule`

| Property | Value |
|----------|-------|
| **File** | `packages/averrow-worker/src/handlers/briefing.ts` |
| **Trigger** | Scheduled — dedicated cron `13 13 * * *` (`generateAndEmailBriefing`, `cron/orchestrator.ts`), plus on-demand via `POST /api/briefings/generate` (`handleGenerateBriefing`) and `POST /api/internal/briefing/send` |
| **Purpose** | 12-section Platform Operations Briefing (feed health, enrichment pipeline, agent activity, new threats, spam trap, honeypot, brand coverage, geopolitical campaigns) |

Not registered as an `AgentModule` (no entry in `src/agents/*.ts` or
the name map above) — it's a handler dispatched from a dedicated cron
branch and two HTTP routes, not from the agent mesh. As of the Tier 2b
instrumentation pass, it participates in the agent-run contract via a
`withBriefingRun` wrapper shared by all three call sites: an
`agent_runs` row (`agent_id='daily_briefing'`, running → success/failed,
`error_message` on failure) plus a telemetry `agent_events` row
(`briefing_generated`, `target_agent=NULL` — no downstream dispatch,
operator traceability only). `fetchComprehensiveBriefing` is pure
SQL — no AI call in the briefing path. See `CLAUDE.md §6` for the
cron-relocation history (previously gated at `hour === 13` inside the
hourly mesh; moved to its own invocation after that budget was
exhausted before the `threat_briefings` INSERT could land).

**Inputs:** `threats`, `feed_status`/`feed_pull_history`, `agent_runs`,
`agent_outputs` (flight_control diagnostic), `social_mentions`,
`app_store_listings`, `dark_web_mentions`, `seed_addresses`/
`spam_trap_captures`, `honeypot_visits`, `brands`/`monitored_brands`,
`geopolitical_campaigns`/`geopolitical_campaign_links`
**Outputs:** `threat_briefings` row; `agent_runs` + `agent_events`
(`briefing_generated`) instrumentation; briefing email via Resend

---

### Trustbot

| Property | Value |
|----------|-------|
| **File** | `packages/averrow-worker/src/agents/trustbot.ts` |
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
| **File** | `packages/averrow-worker/src/agents/seed-strategist.ts` |
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
| **File** | `packages/averrow-worker/src/agents/cube-healer.ts` |
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
| **Herald** (`trademark_monitor`) | Hourly tick | Phase 1 trademark monitoring — seeds brand marks + unifies wordmark misuse across social / app-store / domain signals (no external cost). See docs/TRADEMARK_MONITORING.md |
| **Recon** (`auto_seeder`) | Weekly (Sun 05:07 UTC) | Plants spam-trap addresses into harvester channels and tracks per-location yield |
| **Lookalike Scanner** (`lookalike_scanner`) | Hourly | Cron-driven scanner — DNS / HTTP / MX checks + Haiku assessment of newly-registered typosquat candidates |
| **Watchtower** (`ct_monitor`) | Hourly (`18 * * * *`) | Certificate Transparency monitor — polls crt.sh for newly-issued certs impersonating tenant-monitored brands and raises alerts on suspicious issuances. No AI/external cost beyond crt.sh HTTP. Wraps the `scanners/ct-monitor.pollCertificates` sweep in the standard runner so every run writes `agent_runs` (start + completion) + an `agent_outputs` diagnostic. Dedicated cron decouples it from the analyst inline-await that was starving it to ~9/24 runs. |
| **Doppelganger** (`executive_monitor`) | Every 6h (`26 */6 * * *`) | Executive social-impersonation monitor — iterates the active `org_executives` registry, permutes each exec's name into candidate handles, HEAD-checks the watched social platforms, and raises `executive_impersonation` alerts on non-official matches. 100% deterministic (permutation + HEAD + Levenshtein — no AI, `budget.monthlyTokenCap: 0`). Thin AgentModule (`agents/executiveMonitor.ts`) delegating to the batch (`scanners/executive-monitor-batch.runExecutiveMonitorBatch`) which sits on top of the pure detector (`scanners/executive-monitor.runExecutiveMonitorForExec`). Bounded at `EXEC_BATCH_LIMIT=10` execs/run with a KV rotation cursor; alerts dedup on (brand, executive_id, platform, handle) inside the type's `-6h` window; the exec's own official handle is never alerted. Dedicated cron gives it its own Worker budget (same pattern as PR-E/F/Q/T); `executeAgent` writes `agent_runs` + `agent_events` + a diagnostic `agent_outputs`. Approval-gate row grandfathered in migration 0246. |
| **Enricher** (`enricher`) | Hourly | Domain geo, brand logo / HQ, brand sector / RDAP enrichment — runs every hourly tick |
| **Sifter** (`abuse_mailbox_classifier`) | Hourly (`17 * * * *`, only when pending > 0) | Triages forwarded abuse-report emails — Haiku-classifies phishing / malware / spam / benign, computes severity, promotes confirmed threats, runs Sonnet deep analysis + emails reporters a determination on HIGH/CRITICAL. Delegates to `lib/abuse-mailbox-classifier.runAbuseClassifierBackfill`. Dispatched via `executeAgent` so runs land in `agent_runs` + `agent_events`. See docs/ABUSE_MAILBOX.md. |
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

## Agentic Agents

The platform's first **real agent** — distinct from the single-shot batch
classifiers above. Where every other agent gathers context with SQL and makes
one model call per row, an agentic agent runs a **multi-turn tool-use loop**:
the model decides which tool to call next, reads the result, and pivots until
it calls a terminal tool. The existing deterministic pipeline becomes the
agent's tool substrate. See `docs/AGENTIC_DEEP_SCAN_SPEC.md`.

### Campaign Hunter (`campaign_hunter`)

- **Surface:** `trigger: "api"` — `POST /api/internal/agents/campaign_hunter/run`.
- **Loop:** `lib/agent-loop.ts` — generic manual tool-use loop (hard turn cap,
  tool-result threading, audit trail, injectable model call + durable-step seam
  for the Phase 2 Workflow runtime).
- **Tools (`lib/hunter-tools.ts`):** four read-only tools over the existing
  substrate — `brand_overview`, `query_brand_threats`, `provider_history`,
  `scan_lookalikes` — plus a terminal `submit_report` (strict schema that
  doubles as the loop terminator). Inputs are Zod-validated; all queries are
  prepared statements.
- **Driver model:** `claude-sonnet-4-6` (cost/quality balance for tool use).
- **Output:** a structured verdict (`active_campaign` / `isolated_threats` /
  `no_significant_threat`) with confidence, findings, and the full reasoning
  trail, persisted to `agent_outputs` as an `insight`.
- **Guardrails:** `costGuard: "enforced"` (global throttle), per-turn
  `checkAgentBudget`, 12-turn hard cap, read-only tools, `agent_configs.enabled`
  kill-switch.
- **Runtimes:** the inline agent module (`POST /api/internal/agents/campaign_hunter/run`)
  and a durable **Cloudflare Workflow** (`CampaignHunterWorkflow`, dispatched via
  `POST /api/internal/agents/campaign_hunter/workflow`, polled via
  `…/campaign_hunter/status?run_id=`). Both share the same core
  (`resolveHunterBrand` + `runHuntAndSummarize`); the Workflow wraps each model
  turn in `step.do()` so an investigation checkpoints and survives a worker
  recycle. The deterministic idempotency key makes any step replay free.
- **Still Phase 2-pending:** rewiring the customer "AI DEEP SCAN" button to the
  async Workflow path, live dns/whois lookup tools, and a scored eval harness.

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
   addresses so Cartographer can geo-enrich them (200 domains / 8s batch).
   Reads candidates from the dedicated `DNS_QUEUE_DB` (D1: `trust-radar-dns-queue`)
   when bound; falls back to the `threats` table when unbound. After the
   PR-4 cleanup (May 18), state mutations (`attempted_resolve_at`,
   `enrichment_attempts`) live exclusively on `dns_queue`; the threats table
   still owns the resolved `ip_address` deliverable but no longer carries
   per-attempt state. The split moved this workload off the main DB's read
   budget — 39× per-call reduction (500 rows vs 19,553) since dns_queue is
   a focused ~17K-row working set vs the 380K-row threats table.
2. **DNS-queue reconcile** — `lib/dns-queue-reconciler.ts` enqueues NEW threat
   candidates into `dns_queue` using cursor-paginated reads from the main DB.
   KV cursor at `reconciler:dns_queue:cursor` tracks position by `created_at`;
   each tick reads only the rows added since the last cursor (typically ~37
   per 5-min tick), advances cursor to MAX(created_at) observed, and persists.
   `INSERT OR IGNORE` absorbs the deliberate cursor overlap (`>=` not `>`)
   that prevents skipping rows with identical timestamps. Bounded at 500
   candidates read per tick. PR-BI (2026-05-19) replaced the pre-PR-BI
   set-diff reconciler that scanned ~83K rows on both sides every tick —
   total reconciler reads dropped from ~15M/day to ~10.7K/day (99.4%
   reduction). Skips cleanly when `DNS_QUEUE_DB` is unbound. Drift between
   queue and threats is surfaced by FC via `platform_dns_queue_drift`;
   reconciler cursor lag is surfaced via `platform_dns_queue_stalled`.
3. **DNS-queue reap (daily, hour===0)** — `lib/dns-queue-reaper.ts` sweeps
   stale rows whose underlying threat flipped to inactive after enqueue.
   Since the reconciler only ADDS rows (cursor pagination), the reaper
   handles the slow-leak removal path that dns-backfill's per-domain
   DELETE-on-resolve doesn't catch. Bounded ~17K reads per daily run.
   Writes `reconciler:dns_queue:reaper_last_run` + `:reaper_last_delta`
   KV stamps. Stalled reaper (>36h since last run) is surfaced via
   `platform_dns_queue_reaper_stalled` (medium severity — drain unaffected,
   the queue just accumulates ghost rows).
4. Drain stale pending `agent_events` (housekeeping)
5. Rebuild current + previous hour for all 5 cube tables (10 cube builds)
6. Pre-warm KV caches for Observatory, Dashboard, Agents, Operations pages

Navigator finds the path (IP addresses); Cartographer maps the terrain (lat/lng,
country, provider).

### Cloudflare Workflows

Heavy agents are dispatched as durable Workflows instead of running inline in the cron handler:
- **CartographerBackfillWorkflow** — dispatched by orchestrator for Cartographer enrichment
- **NexusWorkflow** — dispatched by orchestrator for NEXUS clustering

This prevents long-running agents from blocking the cron mesh or hitting the 30s Worker CPU limit.
