// Standalone preview harness for the redesigned AdminDashboard.
// Mocks every API the dashboard touches so we can iterate on layout
// without running the worker. Not shipped to prod.

import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '../lib/auth';
import { AdminDashboard } from '../features/admin/AdminDashboard';
import '../index.css';

const MOCK_USER = {
  id: 'mock-user',
  email: 'preview@averrow.test',
  role: 'super_admin',
  name: 'Preview',
  avatar_url: null,
  status: 'active',
  organization: null,
};
localStorage.setItem('averrow-user', JSON.stringify(MOCK_USER));
localStorage.setItem('averrow.accessToken', 'mock.access.token');

// ─── Fetch interceptor — minimal shape per endpoint ────────────────
const originalFetch = window.fetch;
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const path = url.startsWith('http') ? new URL(url).pathname + new URL(url).search : url;

  // Auth bootstrap
  if (path.startsWith('/api/auth/me')) {
    return json({ success: true, data: MOCK_USER });
  }

  // System health
  if (path.startsWith('/api/admin/system-health')) {
    return json({
      success: true,
      data: {
        threats: { total: 113847, today: 3209, week: 18500 },
        agents: { total: 229, successes: 226, errors: 3 },
        feeds: { pulls: 266, ingested: 6245 },
        sessions: { count: 94 },
        migrations: {
          total: 142,
          last_run: '2026-05-17T18:42:00Z',
          last_name: '0142_brand_score_snapshots.sql',
        },
        audit: { count: 4283 },
        trend: buildTrend(),
        infrastructure: {
          mainDb: { name: 'trust-radar-v2', sizeMb: 287.4, tables: 142, region: 'ENAM' },
          auditDb: { name: 'trust-radar-v2-audit', sizeKb: 412, tables: 4, region: 'ENAM' },
          worker: { name: 'averrow-worker', platform: 'Cloudflare Workers' },
          kvNamespaces: [{ name: 'CACHE' }, { name: 'SESSIONS' }, { name: 'averrow-cache' }],
        },
      },
    });
  }

  // Budget
  if (path.startsWith('/api/admin/budget/status')) {
    return json({
      success: true,
      data: {
        spent_this_month: 87.42,
        config: { monthly_limit_usd: 250 },
        pct_used: 34.97,
        remaining: 162.58,
        daily_burn_rate: 4.62,
        projected_monthly: 138.6,
        days_in_month: 31,
        days_elapsed: 18,
        throttle_level: 'normal',
        anthropic_reported: 84.18,
      },
    });
  }
  if (path.startsWith('/api/admin/budget/breakdown')) {
    return json({
      success: true,
      data: [
        { agent_id: 'analyst', calls: 1284, cost_usd: 32.412 },
        { agent_id: 'nexus', calls: 421, cost_usd: 21.207 },
        { agent_id: 'strategist', calls: 87, cost_usd: 12.418 },
        { agent_id: 'observer', calls: 18, cost_usd: 8.124 },
        { agent_id: 'narrator', calls: 18, cost_usd: 6.821 },
        { agent_id: 'abuse_responder', calls: 142, cost_usd: 4.218 },
        { agent_id: 'pathfinder', calls: 8, cost_usd: 2.218 },
      ],
    });
  }
  if (path.startsWith('/api/admin/budget/config')) {
    return json({ success: true, data: {} });
  }

  // Push config
  if (path.startsWith('/api/admin/push/config')) {
    return json({
      success: true,
      data: {
        push_enabled: true,
        vapid_public_key: 'BLc8...mock',
        vapid_private_key_configured: true,
      },
    });
  }

  // Briefing latest
  if (path.startsWith('/api/briefings/latest')) {
    return json({
      success: true,
      data: {
        id: 1,
        type: 'comprehensive',
        report_date: '2026-05-18',
        generated_at: '2026-05-18T08:00:00Z',
        trigger: 'cron',
        emailed: 1,
        report_data: JSON.stringify({
          platformOverview: {
            totalThreats: 113847,
            last24h: 3209,
            last12h: 1612,
            avgPerHour: 134,
            brandsMonitored: 9652,
            brandsClassified: 8821,
            todayCount: 3209,
            yesterdayCount: 2841,
          },
          newThreats: {
            bySeverity: [
              { severity: 'critical', count: 41 },
              { severity: 'high', count: 287 },
              { severity: 'medium', count: 612 },
              { severity: 'low', count: 672 },
            ],
            bySource: [
              { source_feed: 'urlhaus_recent', count: 412 },
              { source_feed: 'openphish', count: 287 },
            ],
            notable: [
              {
                malicious_domain: 'paypa1-secure-login.example',
                type: 'phishing', severity: 'critical', source_feed: 'urlhaus',
                first_seen: '2026-05-18T03:14:00Z',
              },
            ],
          },
          feedProduction: [
            { feed_name: 'urlhaus_recent', runs: 12, ingested: 412 },
            { feed_name: 'openphish', runs: 12, ingested: 287 },
          ],
          feedHealth: {
            feeds: [],
            summary: [
              { health_status: 'healthy', count: 13 },
              { health_status: 'degraded', count: 1 },
            ],
            staleFeeds: [],
            degradedFeeds: [
              { feed_name: 'seclookup_v2', last_error: 'HTTP 502' },
            ],
          },
          enrichment: {
            surbl_checked: 4287, surbl_hits: 412,
            vt_checked: 4287, vt_hits: 287,
            gsb_checked: 4287, gsb_hits: 91,
            dbl_checked: 4287, dbl_hits: 156,
            abuse_checked: 4287, abuse_hits: 47,
            gn_checked: 0, sec_checked: 4287,
          },
          flightController: { summary: 'Cartographer: 124, Enricher: 87, Budget: $87.42 / $250.00', created_at: '2026-05-18T08:00:00Z' },
          agentActivity: [
            { agent_id: 'sentinel', runs: 12, last_run: '2026-05-18T07:07:00Z' },
            { agent_id: 'cartographer', runs: 12, last_run: '2026-05-18T07:09:00Z' },
            { agent_id: 'enricher', runs: 12, last_run: '2026-05-18T07:08:00Z' },
          ],
          newCapabilities: { typosquat_total: 1284, typosquat_new: 27, social_total: 92, social_new: 4, certstream: 91 },
          spamTrap: { totalSeeds: 412, totalCaptures: 1287, captures12h: 47, latestCaptures: [], seedingSources: [] },
          honeypot: { totalVisits: 8421, botVisits: 7654, humanVisits: 767, visits12h: 412, pageBreakdown: [], recentBots: [], suspiciousHumans: [] },
          topTargetedBrands: [
            { name: 'PayPal', threats_24h: 287 },
            { name: 'Apple', threats_24h: 198 },
            { name: 'Microsoft', threats_24h: 156 },
          ],
          brandCoverage: [
            { sector: 'Finance', brands: 1284 },
            { sector: 'Tech', brands: 987 },
          ],
          generatedAt: '2026-05-18T08:00:00Z',
          statusBadge: 'OPERATIONAL',
        }),
      },
    });
  }

  // Email security stats
  if (path.startsWith('/api/email-security/stats')) {
    return json({
      success: true,
      data: {
        scanned: 4287,
        pending: 5365,
        avg_score: 78,
        total_brands: 9652,
        grades: [
          { grade: 'A+', count: 412 },
          { grade: 'A', count: 1284 },
          { grade: 'B', count: 1620 },
          { grade: 'C', count: 612 },
          { grade: 'D', count: 287 },
          { grade: 'F', count: 72 },
        ],
      },
    });
  }

  // Fallthrough — log + 404 so the dashboard's loading states don't hang
  if (path.startsWith('/api/')) {
    console.warn('Unmocked API call:', path);
    return json({ success: false, error: 'Not mocked' }, 404);
  }

  return originalFetch(input, init);
}) as typeof fetch;

function buildTrend() {
  const now = Date.now();
  const out: { day: string; count: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now - i * 86_400_000);
    const iso = d.toISOString().slice(0, 10);
    // Synthetic but visually interesting wave
    const base = 2400 + Math.round(800 * Math.sin(i * 0.6) + 600 * Math.cos(i * 0.3));
    const spike = i === 7 ? 4800 : 0;
    out.push({ day: iso, count: base + spike });
  }
  return out;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <BrowserRouter basename="/">
      <AuthProvider>
        <div style={{ minHeight: '100vh', background: 'var(--bg-page)', padding: '32px 32px 64px' }}>
          <div style={{ maxWidth: 1400, margin: '0 auto' }}>
            <AdminDashboard />
          </div>
        </div>
      </AuthProvider>
    </BrowserRouter>
  </QueryClientProvider>
);
