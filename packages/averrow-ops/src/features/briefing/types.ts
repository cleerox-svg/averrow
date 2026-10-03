// Ops briefing payload. Mirrors `ComprehensiveBriefing` (and the
// `MarketingVisibility` it embeds) from
// packages/averrow-worker/src/handlers/briefing.ts and
// packages/averrow-worker/src/lib/marketing-analytics.ts. Keep in sync with
// the worker; the worker is the source of truth.
//
// Older stored rows predate newer sections (appstore/darkweb capabilities,
// geopoliticalCampaigns, marketingVisibility), so the renderer treats every
// section defensively even though the type marks them required.

export interface MarketingVisibility {
  windowHours: number;
  humanViews: number;
  aiCrawlerViews: number;
  otherBotViews: number;
  aiReferralSessions: number;
  ctaClicks: number;
  contactSubs: number;
  topPages: Array<{ page: string; views: number }>;
  aiCrawlerBreakdown: Array<{ crawler_name: string; hits: number }>;
  aiReferralBySource: Array<{ ai_source: string; sessions: number }>;
}

export interface PlatformOverview {
  totalThreats: number;
  last24h: number;
  last12h: number;
  avgPerHour: number;
  brandsMonitored: number;
  brandsClassified: number;
  todayCount: number;
  yesterdayCount: number;
}

export interface GeopoliticalCampaign {
  name: string;
  status: string;
  conflict: string;
  start_date: string;
  briefing_priority: string;
  total_threats: number;
  new_24h: number;
  brands_hit: number;
  threat_actors: string;
  notes: string | null;
}

export interface ComprehensiveBriefing {
  platformOverview: PlatformOverview;
  newThreats: {
    bySeverity: Array<{ severity: string; count: number }>;
    bySource: Array<{ source_feed: string; count: number }>;
    notable: Array<{
      malicious_domain: string;
      type: string;
      severity: string;
      source_feed: string;
      first_seen: string;
    }>;
  };
  feedProduction: Array<{ feed_name: string; runs: number; ingested: number }>;
  feedHealth: {
    feeds: Array<{
      feed_name: string;
      health_status: string;
      last_successful_pull: string | null;
      last_error: string | null;
    }>;
    summary: Array<{ health_status: string; count: number }>;
    staleFeeds: Array<{ feed_name: string; last_successful_pull: string | null }>;
    degradedFeeds: Array<{ feed_name: string; last_error: string | null }>;
  };
  enrichment: {
    surbl_checked: number;
    surbl_hits: number;
    vt_checked: number;
    vt_hits: number;
    gsb_checked: number;
    gsb_hits: number;
    dbl_checked: number;
    dbl_hits: number;
    abuse_checked: number;
    abuse_hits: number;
    gn_checked: number;
    sec_checked: number;
  };
  flightController: {
    summary: string | null;
    created_at: string | null;
  };
  agentActivity: Array<{ agent_id: string; runs: number; last_run: string }>;
  newCapabilities: {
    typosquat_total: number;
    typosquat_new: number;
    social_total: number;
    social_new: number;
    certstream: number;
    appstore_total: number;
    appstore_new: number;
    darkweb_total: number;
    darkweb_new: number;
  };
  spamTrap: {
    totalSeeds: number;
    totalCaptures: number;
    captures12h: number;
    latestCaptures: Array<{
      trap_address: string;
      from_address: string;
      subject: string;
      category: string;
      severity: string;
      captured_at: string;
    }>;
    seedingSources: Array<{
      seeded_location: string;
      seeds: number;
      catches: number;
    }>;
  };
  honeypot: {
    totalVisits: number;
    botVisits: number;
    humanVisits: number;
    visits12h: number;
    pageBreakdown: Array<{ page: string; visits: number; bots: number }>;
    /** True distinct-page count; pageBreakdown is capped at top-20 by visits. */
    pageBreakdownTotal: number;
    recentBots: Array<{
      page: string;
      bot_name: string;
      country: string;
      visited_at: string;
    }>;
    suspiciousHumans: Array<{
      page: string;
      country: string;
      visited_at: string;
      asn: string | null;
      reason: 'bait' | 'probe';
    }>;
  };
  marketingVisibility: MarketingVisibility;
  topTargetedBrands: Array<{ name: string; threats_24h: number }>;
  brandCoverage: Array<{ sector: string; brands: number }>;
  geopoliticalCampaigns: GeopoliticalCampaign[];
  generatedAt: string;
  statusBadge: 'OPERATIONAL' | 'DEGRADED';
}

/** A `threat_briefings` row as `/api/briefings/latest` returns it. */
export interface BriefingRow {
  id: number;
  type: string;
  report_date: string;
  report_data: string | ComprehensiveBriefing;
  generated_at: string;
  trigger: string;
  emailed: number;
}
