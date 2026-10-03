// Fake API for Home tests: valid payloads for every endpoint Home may call,
// with per-URL failure injection and a request log for gating assertions.

export type Failure = 'reject' | 'envelope';

export interface HomeApiOptions {
  /** Failure to inject, keyed by URL prefix (first match wins). */
  fail?: Record<string, Failure>;
  alerts?: { new_count: number; critical_count: number };
  incidents?: unknown[];
  pending?: unknown[];
  statusCounts?: Array<{ status: string; count: number }>;
  agents?: unknown[];
  atRisk?: Array<Record<string, unknown>>;
  unattributed?: number;
  candidates?: number;
  events?: unknown[];
}

const HOUR_LABELS = (n: number) => Array.from({ length: n }, (_, i) => `2026-10-03 ${String(i % 24).padStart(2, '0')}:00:00`);

function inflow(window: '24h' | '7d') {
  const n = window === '24h' ? 24 : 168;
  const counts = new Array<number>(n).fill(100);
  return { window, buckets: HOUR_LABELS(n), series: [{ threat_type: 'phishing', counts, total: n * 100 }], total: n * 100, generated_at: '2026-10-03T12:00:00Z' };
}

export function createHomeApi(opts: HomeApiOptions = {}) {
  const requests: string[] = [];

  const handler = async (url: string): Promise<unknown> => {
    requests.push(url);
    for (const [prefix, mode] of Object.entries(opts.fail ?? {})) {
      if (url.startsWith(prefix)) {
        if (mode === 'reject') throw new Error(`HTTP 500 ${prefix}`);
        return { success: false, error: 'internal' };
      }
    }
    if (url.startsWith('/api/alerts/triage-summary')) {
      return { success: true, data: opts.alerts ?? { new_count: 0, critical_count: 0 } };
    }
    if (url.startsWith('/api/intel/critical-banner')) {
      const events = opts.events ?? [];
      return { success: true, data: { events, total: events.length, generated_at: '2026-10-03T12:00:00Z' } };
    }
    if (url.startsWith('/api/admin/incidents')) return { success: true, data: opts.incidents ?? [] };
    if (url.startsWith('/api/admin/agents/approvals/pending')) {
      const pending = opts.pending ?? [];
      return { success: true, data: { pending, total: pending.length } };
    }
    if (url.startsWith('/api/admin/takedowns')) {
      return { success: true, data: [], total: 0, status_counts: opts.statusCounts ?? [], scope: 'authorized' };
    }
    if (url.startsWith('/api/agents')) return { success: true, data: opts.agents ?? [] };
    if (url.startsWith('/api/admin/dashboard')) {
      const atRisk = opts.atRisk ?? [];
      return {
        success: true,
        data: {
          threat_health: null, budget: null, pipeline: null, email_security: null,
          feeds: { at_risk_count: atRisk.length, at_risk: atRisk, totals_24h: { total_pulls: 0, total_success: 0, total_failed: 0, feeds_active: 0 } },
          generated_at: '2026-10-03T12:00:00Z',
        },
      };
    }
    if (url.startsWith('/api/admin/agents/attribution-backlog')) {
      return {
        success: true,
        data: {
          items: [], limit: 50, offset: 0, generated_at: '2026-10-03T12:00:00Z',
          totals: { total_clusters: 0, unattributed: opts.unattributed ?? 0, attempted_unknown: 0, never_attempted: 0, dismissed: 0 },
        },
      };
    }
    if (url.startsWith('/api/admin/brand-candidates')) {
      const n = opts.candidates ?? 0;
      return { success: true, data: Array.from({ length: n }, (_, i) => ({ id: `c${i}` })), total: n };
    }
    if (url.startsWith('/api/threats/inflow')) return inflow(url.includes('7d') ? '7d' : '24h');
    if (url.startsWith('/api/trends/intelligence')) {
      return {
        success: true,
        data: [{
          id: 'i1', type: 'insight', severity: 'high',
          summary: '**Phishing surge** — 40 new domains hit Acme overnight.',
          created_at: new Date().toISOString(), details: null,
          related_brand_ids: '["brand_acme"]', related_campaign_id: null, related_provider_ids: null,
        }],
      };
    }
    if (url.startsWith('/api/v1/public/platform-status')) {
      const cat = (category: string) => ({
        category, current: 'operational', uptime_30d_pct: 99.9, daily: [], realtime: 'operational', realtime_note: '',
      });
      return {
        generated_at: '2026-10-03T12:00:00Z', overall: 'operational', overall_note: 'All systems operational',
        categories: [cat('feeds'), cat('agents'), cat('processing')], window_days: 30,
      };
    }
    throw new Error(`unexpected url ${url}`);
  };

  return { handler, requests };
}
