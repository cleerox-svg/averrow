// Realistic fixtures for the Network view: an /api/agents payload (all 44
// registered ids), an /api/feeds/overview payload and a last-hour
// /api/agents/timeline payload. Used by the tests and the screenshot harness.

import type { Agent } from '@/hooks/useAgents';
import type { FeedOverview } from '@/hooks/useFeeds';
import type {
  AgentTimeline, TimelineEvent, TimelinePull, TimelineRun, TimelineStatus,
} from '@/hooks/useAgentTimeline';
import { AGENT_METADATA, type AgentId } from '@/lib/agent-metadata';

/** Server time of the fixture timeline. Everything is relative to it. */
export const FIXTURE_NOW = '2026-11-15T06:12:30.000Z';
const NOW_MS = Date.parse(FIXTURE_NOW);
const iso = (minutesAgo: number, sec = 0) => new Date(NOW_MS - minutesAgo * 60_000 - sec * 1000).toISOString();

export const RETIRED_IDS: readonly string[] = [
  'admin_classify', 'brand_analysis', 'brand_deep_scan', 'brand_report', 'geo_campaign_assessment',
  'honeypot_generator', 'public_trust_check', 'qualified_report', 'scan_report', 'social_ai_assessor',
];

export function makeAgent(name: string, over: Partial<Agent> = {}): Agent {
  const meta = AGENT_METADATA[name as AgentId];
  return {
    agent_id: name,
    name,
    display_name: meta?.displayName ?? name,
    description: meta?.subtitle ?? '',
    color: meta?.color ?? '#888888',
    status: 'active',
    schedule: 'hourly',
    jobs_24h: 24,
    outputs_24h: 10,
    error_count_24h: 0,
    activity: [],
    recent_ticks: [],
    last_run_at: iso(8),
    last_run_status: 'success',
    last_run_duration_ms: 4_000,
    last_run_error: null,
    last_output_at: null,
    avg_duration_ms: 4_000,
    circuit_enabled: 1,
    circuit_state: 'closed',
    paused_reason: null,
    consecutive_failures: 0,
    consecutive_failure_threshold: 5,
    paused_at: null,
    paused_after_n_failures: null,
    lifecycle: RETIRED_IDS.includes(name) ? 'retired' : 'active',
    ...over,
  };
}

/** Every registered agent id (incl. flight_control), once (what /api/agents returns after PR 1). */
export const AGENTS_FIXTURE: Agent[] = (Object.keys(AGENT_METADATA) as AgentId[]).map((id) => makeAgent(id, {
  ...(id === 'attributor' ? { last_run_status: 'failed', last_run_error: 'D1 DB is overloaded' } : {}),
}));

export function makeFeed(feed_name: string, feed_type?: FeedOverview['feed_type'], over: Partial<FeedOverview> = {}): FeedOverview {
  return {
    feed_name, display_name: feed_name, description: null, source_url: null, enabled: 1,
    schedule_cron: '7 * * * *', batch_size: null, rate_limit: null, filters: null, retry_count: null,
    retry_delay_seconds: null, paused_reason: null, consecutive_failure_threshold: null,
    consecutive_failures: 0, last_error: null, total_pulls: 100, total_ingested: 5000, total_rejected: 0,
    successes: 100, errors: 0, last_run: iso(8), last_completed: iso(8),
    ...(feed_type ? { feed_type } : {}),
    ...over,
  };
}

const INGEST_FEEDS = [
  'phishtank', 'openphish', 'urlhaus', 'phishdestroy', 'otx_alienvault', 'taxii_otx', 'sslbl',
  'c2_intel_feeds', 'ct_logs', 'typosquat_scanner', 'feodo_tracker', 'threatfox', 'malware_bazaar',
  'cins_score', 'blocklist_de',
];
export const FEEDS_FIXTURE: FeedOverview[] = [
  ...INGEST_FEEDS.map((n) => makeFeed(n, 'ingest')),
  makeFeed('nrd_hagezi', 'ingest'),
  ...['greynoise', 'seclookup', 'virustotal', 'google_safe_browsing', 'pulsedive'].map((n) => makeFeed(n, 'enrichment')),
  ...['reddit', 'github', 'telegram', 'mastodon'].map((n) => makeFeed(n, 'social')),
];

let seq = 0;
function run(
  agent_id: string, minutesAgo: number, durSec: number | null, status: TimelineStatus,
  records = 0, extra: Partial<TimelineRun> = {},
): TimelineRun {
  const startMs = NOW_MS - minutesAgo * 60_000;
  const open = durSec === null;
  return {
    id: `r${++seq}`, agent_id, source: agent_id === 'nexus' ? 'workflow' : 'agent_runs',
    started_at: new Date(startMs).toISOString(),
    completed_at: open ? null : new Date(startMs + durSec * 1000).toISOString(),
    status: open ? 'running' : status, open, clipped_start: false,
    duration_ms: open ? null : durSec * 1000, records_processed: records, error: null, ...extra,
  };
}

function pull(
  feed_name: string, minutesAgo: number, durSec: number | null, status: TimelineStatus,
  ingested = 0, extra: Partial<TimelinePull> = {},
): TimelinePull {
  const startMs = NOW_MS - minutesAgo * 60_000;
  const open = durSec === null;
  return {
    id: `p${++seq}`, feed_name, started_at: new Date(startMs).toISOString(),
    completed_at: open ? null : new Date(startMs + durSec * 1000).toISOString(),
    status: open ? 'running' : status, open, clipped_start: false,
    records_ingested: ingested, records_rejected: 0, duration_ms: open ? null : durSec * 1000, error: null, ...extra,
  };
}

const navigatorRuns = [57, 52, 47, 42, 37, 32, 27, 22, 17, 12, 7, 2].map((m) => run('navigator', m, 35, 'success', 40));
const captureRuns = [55, 45, 35, 25, 15, 5].map((m) => run('page_capture', m, 80, 'success', 5));

export const TIMELINE_FIXTURE: AgentTimeline = {
  window: '1h',
  generated_at: FIXTURE_NOW,
  window_start: iso(60),
  window_end: FIXTURE_NOW,
  runs: [
    ...navigatorRuns,
    ...captureRuns,
    // Last hour's mesh tick (:07 of the previous hour is clipped; this hour's is below).
    run('analyst', 5.4, 95, 'success', 120),
    run('enricher', 4.4, 110, 'success', 300),
    run('cartographer', 3.3, null, 'running', 250),
    run('sentinel', 2.3, 42, 'success', 87),
    run('cube_healer', 0.4, 20, 'success', 12),
    run('attributor', 55, 40, 'failed', 0, { error: 'D1 DB is overloaded' }),
    run('observer', 31.5, 120, 'success', 3),
    run('strategist', 2.3, 90, 'success', 14),
    run('sparrow', 1.9, 130, 'partial', 6),
    run('lookalike_scanner', 50, 100, 'success', 9),
    run('ct_monitor', 54, 80, 'success', 4),
    run('social_discovery', 57, 70, 'success', 11),
    run('social_monitor', 56, 90, 'success', 11),
    run('watchdog', 12.5, 45, 'success', 3),
    // nexus: a workflow run that completed 2 seconds before the snapshot.
    run('nexus', 2.55, 150, 'success', 41, { clipped_start: false }),
    // Run writers that are not registered agents.
    run('campaign_hunter', 20, 90, 'success', 2),
    run('daily_briefing', 59, 200, 'success', 1, { source: 'agent_runs' }),
  ],
  pulls: [
    pull('phishtank', 5.5, 12, 'success', 140),
    pull('openphish', 5.4, 9, 'success', 60),
    pull('urlhaus', 5.3, 15, 'success', 410),
    pull('phishdestroy', 5.2, 11, 'success', 220),
    pull('otx_alienvault', 5.0, 40, 'success', 75),
    pull('sslbl', 4.9, 3, 'failed', 0, { error: 'timed out after 480s' }),
    pull('c2_intel_feeds', 4.8, null, 'running', 0),
    pull('nrd_hagezi', 43.5, 30, 'success', 0),
    pull('reddit', 2.4, 20, 'success', 12),
    pull('github', 2.3, 14, 'success', 4),
    pull('greynoise', 11.5, 60, 'success', 38),
    pull('virustotal', 4.2, 70, 'success', 55),
  ],
  events: [{
    id: 'e1', event_type: 'pivot_detected', source_agent: 'nexus', target_agent: 'observer',
    created_at: iso(0.5), status: 'pending',
  } satisfies TimelineEvent],
  truncated: { runs: false, pulls: false, events: false },
};

/**
 * A worst-case 24h payload: about 6000 runs across the registry plus 4000
 * feed pulls (Navigator alone is ~288/day; grouped feeds pull hourly). Used by
 * the tape performance guard.
 */
export function makeBigTimeline(): AgentTimeline {
  const dayMs = 24 * 60 * 60 * 1000;
  const startMs = NOW_MS - dayMs;
  const ids = Object.keys(AGENT_METADATA).filter((id) => id !== 'flight_control');
  const runs: TimelineRun[] = [];
  let k = 0;
  while (runs.length < 6000) {
    const id = ids[k % ids.length]!;
    // deterministic spread over the day
    const t = startMs + ((k * 7919) % 86_400) * 1000;
    const dur = 2 + ((k * 13) % 40);
    runs.push({
      id: `big-r${k}`, agent_id: id, source: 'agent_runs', started_at: new Date(t).toISOString(),
      completed_at: new Date(t + dur * 1000).toISOString(), status: k % 97 === 0 ? 'failed' : k % 31 === 0 ? 'partial' : 'success',
      open: false, clipped_start: false, duration_ms: dur * 1000, records_processed: k % 50, error: null,
    });
    k++;
  }
  const feedNames = ['phishtank', 'openphish', 'urlhaus', 'otx_alienvault', 'greynoise', 'reddit', 'github', 'nrd_hagezi'];
  const pulls: TimelinePull[] = [];
  for (let i = 0; i < 4000; i++) {
    const t = startMs + ((i * 6007) % 86_400) * 1000;
    pulls.push({
      id: `big-p${i}`, feed_name: feedNames[i % feedNames.length]!, started_at: new Date(t).toISOString(),
      completed_at: new Date(t + 6000).toISOString(), status: 'success', open: false, clipped_start: false,
      records_ingested: i % 30, records_rejected: 0, duration_ms: 6000, error: null,
    });
  }
  return {
    window: '24h', generated_at: FIXTURE_NOW, window_start: new Date(startMs).toISOString(), window_end: FIXTURE_NOW,
    runs, pulls, events: [], truncated: { runs: false, pulls: false, events: false },
  };
}
