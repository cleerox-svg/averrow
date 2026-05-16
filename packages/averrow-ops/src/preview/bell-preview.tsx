// Standalone preview harness for NotificationBell redesign.
// Mounts the bell with mocked API responses so we can iterate on the
// UX without booting the full app + signing in. Not shipped to prod.

import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotificationBell } from '../components/NotificationBell';
import '../index.css';

// ─── Mock data ────────────────────────────────────────────────────
const NOW = new Date();
const MIN = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const HRS = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const DAYS = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

const MOCK_NOTIFICATIONS = [
  {
    id: '1',
    brand_id: null, org_id: null, audience: 'super_admin',
    type: 'agent_milestone', severity: 'medium',
    title: 'New campaign identified',
    message: 'Strategist found: JD.com Phishing Kit Network — 47 threats sharing IP 185.220.101.42',
    reason_text: null, recommended_action: null, link: '/campaigns/abc',
    state: 'unread', read_at: null, snoozed_until: null, done_at: null,
    group_key: null, created_at: MIN(2), updated_at: MIN(2), metadata: null,
  },
  {
    id: '2',
    brand_id: null, org_id: null, audience: 'super_admin',
    type: 'platform_feed_at_risk', severity: 'high',
    title: 'Feed AlienVault OTX (TAXII 2.1) at risk of auto-pause (60%)',
    message: '3 consecutive failures (threshold 5). Investigate before it pauses.',
    reason_text: 'Platform alert — operational only.',
    recommended_action: 'Check the feed source; rotate API key if you see 401/403; verify network reachability.',
    link: '/admin/feeds',
    state: 'unread', read_at: null, snoozed_until: null, done_at: null,
    group_key: null, created_at: MIN(5), updated_at: MIN(5), metadata: null,
  },
  {
    id: '3',
    brand_id: null, org_id: null, audience: 'super_admin',
    type: 'platform_feed_silent', severity: 'critical',
    title: 'Feed degraded: Certificate Transparency',
    message: 'No data ingested for 4 hours. Last successful pull at 09:14 UTC.',
    reason_text: null, recommended_action: null, link: '/admin/feeds',
    state: 'unread', read_at: null, snoozed_until: null, done_at: null,
    group_key: null, created_at: MIN(14), updated_at: MIN(14), metadata: null,
  },
  {
    id: '4',
    brand_id: null, org_id: null, audience: 'super_admin',
    type: 'campaign_escalation', severity: 'medium',
    title: 'Campaign growing: Iran APT34 Wave 5',
    message: '12 new threats added to campaign over the last 6 hours.',
    reason_text: null, recommended_action: null, link: '/campaigns/iran-5',
    state: 'unread', read_at: null, snoozed_until: null, done_at: null,
    group_key: null, created_at: HRS(2), updated_at: HRS(2), metadata: null,
  },
  {
    id: '5',
    brand_id: null, org_id: null, audience: 'super_admin',
    type: 'intelligence_digest', severity: 'info',
    title: 'New intelligence briefing',
    message: 'Daily synthesis: 89 new threats, 3 new campaigns, top sector finance...',
    reason_text: null, recommended_action: null, link: '/trends',
    state: 'read', read_at: HRS(4), snoozed_until: null, done_at: null,
    group_key: null, created_at: HRS(4), updated_at: HRS(4), metadata: null,
  },
  {
    id: '6',
    brand_id: null, org_id: null, audience: 'super_admin',
    type: 'platform_d1_budget_warn', severity: 'high',
    title: 'D1 daily reads at 87% of plan',
    message: '724,392,182 / 833,333,333 reads today.',
    reason_text: 'Platform alert — operational only.',
    recommended_action: 'Review query plan; check for missing indexes; consider read-replica routing for hot endpoints.',
    link: '/admin', state: 'read', read_at: HRS(6), snoozed_until: null, done_at: null,
    group_key: null, created_at: HRS(8), updated_at: HRS(8), metadata: null,
  },
  {
    id: '7',
    brand_id: null, org_id: null, audience: 'super_admin',
    type: 'intel_threat_actor_surface', severity: 'high',
    title: 'New threat actor: BeaverTooth',
    message: 'Phishing kit operator first observed targeting 3 brands in the financial sector.',
    reason_text: null, recommended_action: null, link: '/threat-actors/beavertooth',
    state: 'read', read_at: DAYS(1), snoozed_until: null, done_at: null,
    group_key: null, created_at: DAYS(1), updated_at: DAYS(1), metadata: null,
  },
  {
    id: '8',
    brand_id: null, org_id: null, audience: 'super_admin',
    type: 'platform_agent_stalled', severity: 'high',
    title: 'Agent stalled: cartographer',
    message: 'No successful run in 90 minutes. Last run at 04:22 UTC.',
    reason_text: null, recommended_action: null, link: '/agents/cartographer',
    state: 'read', read_at: DAYS(3), snoozed_until: null, done_at: null,
    group_key: null, created_at: DAYS(3), updated_at: DAYS(3), metadata: null,
  },
];

// ─── Fetch interceptor ────────────────────────────────────────────
const originalFetch = window.fetch;
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  // Strip leading origin so we can match against pathnames.
  const path = url.startsWith('http') ? new URL(url).pathname + new URL(url).search : url;

  // GET /api/notifications?... — list endpoint.
  if (path.startsWith('/api/notifications') && !path.includes('unread-count') && !path.includes('preferences')) {
    return new Response(JSON.stringify({
      success: true,
      data: MOCK_NOTIFICATIONS,
      unread_count: MOCK_NOTIFICATIONS.filter(n => n.state === 'unread').length,
      next_cursor: null,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  // GET /api/notifications/unread-count
  if (path.startsWith('/api/notifications/unread-count')) {
    return new Response(JSON.stringify({
      success: true,
      count: MOCK_NOTIFICATIONS.filter(n => n.state === 'unread').length,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  // GET /api/alerts/triage-summary (and admin variant)
  if (path.includes('/alerts/triage-summary')) {
    return new Response(JSON.stringify({
      success: true,
      data: { new_count: 2352, critical_count: 7 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  // POST mutations — no-op success
  if (init?.method && init.method !== 'GET') {
    return new Response(JSON.stringify({ success: true }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  // Fallback to real fetch (will probably 404 — that's fine for preview).
  return originalFetch(input, init);
}) as typeof window.fetch;

// ─── Auto-open the bell so the screenshot captures the dropdown ──
function AutoOpen() {
  useEffect(() => {
    const t = setTimeout(() => {
      const btn = document.querySelector<HTMLButtonElement>('button[aria-label="Notifications"]');
      btn?.click();
    }, 150);
    return () => clearTimeout(t);
  }, []);
  return null;
}

// ─── Mount ────────────────────────────────────────────────────────
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <div style={{
          minHeight: '100vh',
          background: 'var(--bg-page, #060A14)',
          padding: '24px',
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'flex-start',
        }}>
          <NotificationBell />
        </div>
        <AutoOpen />
      </QueryClientProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
