// ─── Canonical Agent Metadata ──────────────────────────────────────────
//
// Single source of truth for agent presentation across all views:
// Monitor, Config, History, Flight Control mesh badges.
//
// Status data (job counts, last run, errors) still comes from the
// useAgents() hook — only PRESENTATION lives here.

export type AgentId =
  | 'flight_control'
  | 'sentinel'
  | 'navigator'
  | 'analyst'
  | 'cartographer'
  | 'observer'
  | 'nexus'
  | 'attributor'
  | 'news_watcher'
  | 'sparrow'
  | 'strategist'
  | 'pathfinder'
  | 'curator'
  | 'watchdog'
  | 'cube_healer'
  | 'narrator'
  | 'notification_narrator'
  | 'social_discovery'
  | 'social_monitor'
  | 'app_store_monitor'
  | 'dark_web_monitor'
  | 'trademark_monitor'
  | 'auto_seeder'
  | 'seed_strategist'
  | 'enricher'
  | 'geoip_refresh'
  | 'public_trust_check'
  | 'qualified_report'
  | 'brand_analysis'
  | 'brand_report'
  | 'brand_deep_scan'
  | 'honeypot_generator'
  | 'brand_enricher'
  | 'lookalike_scanner'
  | 'ct_monitor'
  | 'admin_classify'
  | 'url_scan'
  | 'scan_report'
  | 'social_ai_assessor'
  | 'geo_campaign_assessment'
  | 'evidence_assembler'
  | 'campaign_hunter'
  | 'abuse_mailbox_classifier'
  | 'executive_monitor';

export interface AgentMetadata {
  id: AgentId;
  displayName: string;
  codename: string | null;
  subtitle: string;
  color: string;
  category: 'orchestration' | 'intelligence' | 'response' | 'ops' | 'meta' | 'sync';
  pipelinePosition: number;
}

export const AGENT_METADATA: Record<AgentId, AgentMetadata> = {
  flight_control: {
    id: 'flight_control',
    displayName: 'Flight Control',
    codename: null,
    subtitle: 'Autonomous supervisor — parallel scaling, stall recovery, token budget enforcement',
    color: '#22D3EE',
    category: 'orchestration',
    pipelinePosition: 0,
  },
  sentinel: {
    id: 'sentinel',
    displayName: 'Sentinel',
    codename: null,
    subtitle: 'Certificate & Domain Surveillance',
    color: '#C83C3C',
    category: 'intelligence',
    pipelinePosition: 1,
  },
  navigator: {
    id: 'navigator',
    displayName: 'Navigator',
    codename: null,
    subtitle: 'DNS resolution — independent 5-min cron',
    color: '#38BDF8',
    category: 'intelligence',
    pipelinePosition: 2,
  },
  cartographer: {
    id: 'cartographer',
    displayName: 'Cartographer',
    codename: null,
    subtitle: 'Geo Enrichment & Infrastructure Mapping',
    color: '#78A0C8',
    category: 'intelligence',
    pipelinePosition: 3,
  },
  nexus: {
    id: 'nexus',
    displayName: 'NEXUS',
    codename: null,
    subtitle: 'Infrastructure correlation — clusters threats by ASN, subnet, and temporal patterns',
    color: '#00D4FF',
    category: 'intelligence',
    pipelinePosition: 4,
  },
  attributor: {
    id: 'attributor',
    displayName: 'Attributor',
    codename: null,
    subtitle: 'Classifies NEXUS clusters by responsible threat actor — Haiku names the APT/cybercrime group',
    color: '#9333ea',
    category: 'intelligence',
    pipelinePosition: 11,
  },
  news_watcher: {
    id: 'news_watcher',
    displayName: 'News Watcher',
    codename: null,
    subtitle: 'Polls threat-intel RSS feeds (CISA, Mandiant, Microsoft) — extracts actors + geopolitical context via Haiku',
    color: '#3CB878',
    category: 'intelligence',
    pipelinePosition: 38,
  },
  analyst: {
    id: 'analyst',
    displayName: 'Analyst',
    codename: 'ASTRA',
    subtitle: 'Threat Classification & Brand Matching',
    color: '#FB923C',
    category: 'intelligence',
    pipelinePosition: 5,
  },
  observer: {
    id: 'observer',
    displayName: 'Observer',
    codename: null,
    subtitle: 'Strategic Intel & Daily Briefings',
    color: '#A78BFA',
    category: 'intelligence',
    pipelinePosition: 6,
  },
  sparrow: {
    id: 'sparrow',
    displayName: 'Sparrow',
    codename: null,
    subtitle: 'Automated Takedown Agent',
    color: '#4ADE80',
    category: 'response',
    pipelinePosition: 7,
  },
  abuse_mailbox_classifier: {
    id: 'abuse_mailbox_classifier',
    displayName: 'Sifter',
    codename: null,
    subtitle: 'Abuse-report triage — classifies forwarded phishing/malware and promotes confirmed threats',
    color: '#0A8AB5',
    category: 'response',
    pipelinePosition: 41,
  },
  strategist: {
    id: 'strategist',
    displayName: 'Strategist',
    codename: null,
    subtitle: 'Campaign Correlation & Clustering Intelligence',
    color: '#FB7185',
    category: 'intelligence',
    pipelinePosition: 8,
  },
  pathfinder: {
    id: 'pathfinder',
    displayName: 'Pathfinder',
    codename: null,
    subtitle: 'Sales Intelligence & Lead Generation',
    color: '#F97316',
    category: 'ops',
    pipelinePosition: 9,
  },
  curator: {
    id: 'curator',
    displayName: 'Curator',
    codename: null,
    subtitle: 'Email security scanning + false-positive cleanup + social profile discovery — weekly hygiene + data quality',
    color: '#2DD4BF',
    category: 'ops',
    pipelinePosition: 10,
  },
  // architect — RETIRED 2026-04-29 (Phase 2.2 of agent audit, no runs since 2026-04-11).
  watchdog: {
    id: 'watchdog',
    displayName: 'Watchdog',
    codename: null,
    subtitle: 'Social-mention threat classifier — Haiku-classifies unclassified mentions, escalates high/critical findings to threats',
    color: '#60A5FA',
    category: 'intelligence',
    pipelinePosition: 12,
  },
  cube_healer: {
    id: 'cube_healer',
    displayName: 'Cube Healer',
    codename: null,
    subtitle: 'OLAP cube maintenance — periodic 30-day rebuild + brand summaries',
    color: '#0EA5E9',
    category: 'ops',
    pipelinePosition: 13,
  },
  narrator: {
    id: 'narrator',
    displayName: 'Narrator',
    codename: null,
    subtitle: 'Threat narrative generation — AI-written briefings for active brands',
    color: '#A855F7',
    category: 'intelligence',
    pipelinePosition: 14,
  },
  social_discovery: {
    id: 'social_discovery',
    displayName: 'Social Discovery',
    codename: null,
    subtitle: 'Discovers brand-owned social handles before monitoring them',
    color: '#EC4899',
    category: 'intelligence',
    pipelinePosition: 15,
  },
  social_monitor: {
    id: 'social_monitor',
    displayName: 'Mockingbird',
    codename: 'social_monitor',
    subtitle: 'Catches social impersonators by their mimicry — Twitter/LinkedIn/Instagram/TikTok/GitHub/YouTube',
    color: '#3CB878',
    category: 'intelligence',
    pipelinePosition: 16,
  },
  app_store_monitor: {
    id: 'app_store_monitor',
    displayName: 'App Store Monitor',
    codename: null,
    subtitle: 'iOS App Store impersonation scanner — bundle ID + name similarity',
    color: '#FBBF24',
    category: 'intelligence',
    pipelinePosition: 17,
  },
  dark_web_monitor: {
    id: 'dark_web_monitor',
    displayName: 'Dark Web Monitor',
    codename: null,
    subtitle: 'Pastebin and breach archive monitoring for brand mentions',
    color: '#94A3B8',
    category: 'intelligence',
    pipelinePosition: 18,
  },
  trademark_monitor: {
    id: 'trademark_monitor',
    displayName: 'Herald',
    codename: 'trademark_monitor',
    subtitle: 'Unifies brand wordmark misuse across social, app-store, and domain signals (Phase 1, no external cost)',
    color: '#E5A832',
    category: 'intelligence',
    pipelinePosition: 39,
  },
  auto_seeder: {
    id: 'auto_seeder',
    displayName: 'Recon',
    codename: 'auto_seeder',
    subtitle: 'Spam-trap seeding agent — plants honeypot addresses into harvester channels and tracks per-location yield',
    color: '#10B981',
    category: 'intelligence',
    pipelinePosition: 19,
  },
  seed_strategist: {
    id: 'seed_strategist',
    displayName: 'Seed Strategist',
    codename: 'seed_strategist',
    subtitle: 'AI plans spam-trap seeding strategy — coverage gaps, channel expansion, retire low-yield addresses',
    color: '#06B6D4',
    category: 'intelligence',
    pipelinePosition: 20,
  },
  enricher: {
    id: 'enricher',
    displayName: 'Enricher',
    codename: 'enricher',
    subtitle: 'Domain geo, brand logo/HQ, and brand sector/RDAP enrichment — runs every hourly tick',
    color: '#22D3EE',
    category: 'ops',
    pipelinePosition: 21,
  },
  geoip_refresh: {
    id: 'geoip_refresh',
    displayName: 'GeoIP Refresh',
    codename: 'geoip_refresh',
    subtitle: 'Loads MaxMind GeoLite2 ranges into the dedicated GEOIP_DB — third-tier geo provider for Cartographer',
    color: '#10b981',
    category: 'ops',
    pipelinePosition: 37,
  },
  public_trust_check: {
    id: 'public_trust_check',
    displayName: 'Public Trust Check',
    codename: 'public_trust_check',
    subtitle: 'Synchronous AI — anonymous /api/v1/public/assess homepage trust-score lookups (Haiku, prompt-injection-hardened)',
    color: '#A855F7',
    category: 'sync',
    pipelinePosition: 22,
  },
  qualified_report: {
    id: 'qualified_report',
    displayName: 'Qualified Report',
    codename: 'qualified_report',
    subtitle: 'Synchronous AI — admin-triggered customer-facing brand risk reports (narrative + remediation plan, Haiku × 2)',
    color: '#FB7185',
    category: 'sync',
    pipelinePosition: 23,
  },
  brand_analysis: {
    id: 'brand_analysis',
    displayName: 'Brand Analysis',
    codename: 'brand_analysis',
    subtitle: 'Synchronous AI — per-brand threat assessments for the brand detail page (Haiku, structured JSON)',
    color: '#FB923C',
    category: 'sync',
    pipelinePosition: 24,
  },
  brand_report: {
    id: 'brand_report',
    displayName: 'Brand Report',
    codename: 'brand_report',
    subtitle: 'Synchronous AI — per-brand exposure report content (executive summary + recommendations, Haiku × 2)',
    color: '#FBBF24',
    category: 'sync',
    pipelinePosition: 25,
  },
  brand_deep_scan: {
    id: 'brand_deep_scan',
    displayName: 'Brand Deep Scan',
    codename: 'brand_deep_scan',
    subtitle: 'Synchronous AI — batch Y/N classification of unlinked threat URLs against a brand identity (one run per request, up to 200 internal calls)',
    color: '#FCD34D',
    category: 'sync',
    pipelinePosition: 26,
  },
  honeypot_generator: {
    id: 'honeypot_generator',
    displayName: 'Honeypot Generator',
    codename: 'honeypot_generator',
    subtitle: 'Synchronous AI — renders complete honeypot trap websites (index + contact + team pages with embedded trap mailtos, Haiku × 3)',
    color: '#F472B6',
    category: 'sync',
    pipelinePosition: 27,
  },
  brand_enricher: {
    id: 'brand_enricher',
    displayName: 'Brand Enricher',
    codename: 'brand_enricher',
    subtitle: 'Synchronous AI — classifies brands into a fixed sector taxonomy (finance / tech / ecommerce / …, Haiku, 20-token bounded reply)',
    color: '#A78BFA',
    category: 'sync',
    pipelinePosition: 28,
  },
  lookalike_scanner: {
    id: 'lookalike_scanner',
    displayName: 'Lookalike Scanner',
    codename: 'lookalike_scanner',
    subtitle: 'Cron-driven scanner — DNS/HTTP/MX checks + Haiku AI assessment of newly-registered typosquat candidates',
    color: '#F59E0B',
    category: 'intelligence',
    pipelinePosition: 29,
  },
  admin_classify: {
    id: 'admin_classify',
    displayName: 'Admin Classify',
    codename: 'admin_classify',
    subtitle: 'Synchronous AI — admin-triggered backfill that Haiku-classifies threats with NULL confidence_score (batch, up to 200 calls per run, rule-based fallback)',
    color: '#FB923C',
    category: 'sync',
    pipelinePosition: 30,
  },
  url_scan: {
    id: 'url_scan',
    displayName: 'URL Scan',
    codename: 'url_scan',
    subtitle: 'Synchronous AI — public URL scan insight generator (Haiku, structured JSON, 10s timeout)',
    color: '#0A8AB5',
    category: 'sync',
    pipelinePosition: 31,
  },
  scan_report: {
    id: 'scan_report',
    displayName: 'Scan Report',
    codename: 'scan_report',
    subtitle: 'Synchronous AI — executive narrative for the public Brand Exposure Report (Haiku, 512-token bounded prose)',
    color: '#A78BFA',
    category: 'sync',
    pipelinePosition: 32,
  },
  social_ai_assessor: {
    id: 'social_ai_assessor',
    displayName: 'Social AI Assessor',
    codename: 'social_ai_assessor',
    subtitle: 'Synchronous AI — Haiku classifies social profiles for brand impersonation (called by both the Mockingbird scanner and on-demand reassessment from the brand detail page)',
    color: '#3CB878',
    category: 'sync',
    pipelinePosition: 33,
  },
  geo_campaign_assessment: {
    id: 'geo_campaign_assessment',
    displayName: 'Geo Campaign Assessment',
    codename: 'geo_campaign_assessment',
    subtitle: 'Synchronous AI — 4-paragraph executive intel assessment of an active geopolitical cyber campaign (Haiku, 1024-token bounded prose)',
    color: '#FB7185',
    category: 'sync',
    pipelinePosition: 34,
  },
  evidence_assembler: {
    id: 'evidence_assembler',
    displayName: 'Evidence Assembler',
    codename: 'evidence_assembler',
    subtitle: 'Synchronous AI — generates structured takedown evidence packages from a takedown + collected intel (called by Sparrow per-tick + admin manual trigger)',
    color: '#4ADE80',
    category: 'sync',
    pipelinePosition: 35,
  },
  notification_narrator: {
    id: 'notification_narrator',
    displayName: 'Notification Narrator',
    codename: 'notification_narrator',
    subtitle: 'Daily per-user digest builder — bundles 24h of notifications into a single digest envelope with optional Haiku narrative',
    color: '#A8C878',
    category: 'intelligence',
    pipelinePosition: 36,
  },
  campaign_hunter: {
    id: 'campaign_hunter',
    displayName: 'Campaign Hunter',
    codename: 'campaign_hunter',
    subtitle: 'Agentic investigation — multi-turn tool-use loop that decides its own next step to determine whether a brand is the target of a coordinated campaign (the platform’s first non-batch agent)',
    color: '#A855F7',
    category: 'sync',
    pipelinePosition: 40,
  },
  ct_monitor: {
    id: 'ct_monitor',
    displayName: 'Watchtower',
    codename: 'ct_monitor',
    subtitle: 'Certificate Transparency monitor — polls crt.sh for newly-issued certs impersonating tenant-monitored brands and raises alerts on suspicious issuances',
    color: '#0A8AB5',
    category: 'intelligence',
    pipelinePosition: 42,
  },
  executive_monitor: {
    id: 'executive_monitor',
    displayName: 'Doppelganger',
    codename: 'executive_monitor',
    subtitle: 'Executive social-impersonation monitor — permutes each registered executive\'s name, HEAD-checks the watched platforms, and raises executive_impersonation alerts on non-official matches',
    color: '#C83C3C',
    category: 'intelligence',
    pipelinePosition: 43,
  },
};

/** All agents sorted by pipelinePosition. */
export const AGENT_LIST: AgentMetadata[] = Object.values(AGENT_METADATA).sort(
  (a, b) => a.pipelinePosition - b.pipelinePosition,
);

/** All agent ids sorted by pipelinePosition (convenience for loops/filters). */
export const AGENT_IDS: AgentId[] = AGENT_LIST.map((a) => a.id);

/** Lookup by string id — returns null for unknown agents. */
export function getAgentMetadata(id: string): AgentMetadata | null {
  return AGENT_METADATA[id as AgentId] ?? null;
}
