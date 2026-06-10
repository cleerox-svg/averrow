// Standalone preview harness for NotificationPreferences redesign.
// Mocks the API + AuthContext so we can iterate on the UX without
// running the full app or signing in. Not shipped to prod.

import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NotificationPreferences } from '../features/settings/NotificationPreferences';
import { AuthProvider } from '../lib/auth';
import { api } from '../lib/api';
import '../index.css';

// Seed the shared AuthProvider's cache so it hydrates as a super_admin
// without going to the network. Tokens are also stubbed so api.getToken()
// doesn't return null.
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
// H5: tokens are memory-only — seed the api client directly so
// api.getToken() doesn't return null (localStorage no longer carries
// tokens).
api.setTokens('mock.access.token', '');

// Toggle this to preview the "push not enabled" vs "push enabled" state.
// Set ?subscribed=1 in the URL to flip to enabled.
const params = new URLSearchParams(window.location.search);
const subscribed = params.get('subscribed') === '1';

// ─── Fetch interceptor — mock every endpoint the page touches ────
const originalFetch = window.fetch;
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const path = url.startsWith('http') ? new URL(url).pathname + new URL(url).search : url;
  const method = init?.method ?? 'GET';

  // GET /api/auth/me — auth bootstrap
  if (path.startsWith('/api/auth/me') && method === 'GET') {
    return new Response(JSON.stringify({ success: true, data: MOCK_USER }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  // GET /api/notifications/preferences/v2 — main pref row
  if (path.startsWith('/api/notifications/preferences/v2') && method === 'GET') {
    return new Response(JSON.stringify({
      success: true,
      data: {
        inapp_severity_floor: 'info',
        push_severity_floor: 'low',
        email_severity_floor: 'high',
        digest_mode: 'daily',
        digest_severity_floor: 'medium',
        quiet_hours_start: null,
        quiet_hours_end: null,
        quiet_hours_timezone: 'UTC',
        critical_bypasses_quiet: 1,
        show_tenant_notifications: 0,
        cadence_intel: 'realtime',
        cadence_platform: 'realtime',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  // GET /api/notifications/preferences (legacy v1 toggles)
  if (path.startsWith('/api/notifications/preferences') && method === 'GET') {
    return new Response(JSON.stringify({
      success: true,
      data: {
        brand_threat: 1,
        campaign_escalation: 1,
        feed_health: 1,
        intelligence_digest: 1,
        agent_milestone: 1,
        push_notifications: subscribed ? 1 : 0,
        quiet_hours_start: null,
        quiet_hours_end: null,
        quiet_hours_timezone: 'UTC',
        critical_breakthrough: 1,
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  // GET /api/notifications/subscribe (push device list)
  if (path.startsWith('/api/notifications/subscribe') && method === 'GET') {
    return new Response(JSON.stringify({
      success: true,
      data: subscribed
        ? [
            { id: '1', device_label: 'Pixel 8 Pro · Chrome', user_agent: 'Mozilla/5.0…', created_at: new Date(Date.now() - 86_400_000 * 4).toISOString(), last_used_at: new Date(Date.now() - 60_000).toISOString() },
            { id: '2', device_label: 'MacBook Pro · Safari', user_agent: 'Mozilla/5.0…', created_at: new Date(Date.now() - 86_400_000 * 12).toISOString(), last_used_at: new Date(Date.now() - 3_600_000).toISOString() },
          ]
        : [],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  // GET /api/notifications/subscriptions — per-brand watches
  if (path.startsWith('/api/notifications/subscriptions')) {
    return new Response(JSON.stringify({
      success: true,
      data: [
        { brand_id: 'brand_acme', brand_name: 'Acme Corp', level: 'watching', snoozed_until: null, updated_at: new Date().toISOString() },
        { brand_id: 'brand_globex', brand_name: 'Globex', level: 'default', snoozed_until: null, updated_at: new Date().toISOString() },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  // Any mutation — no-op success
  if (method !== 'GET') {
    return new Response(JSON.stringify({ success: true, data: { delivered: 2, attempted: 2, failed: 0, expired: 0 } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }
  return originalFetch(input, init);
}) as typeof window.fetch;

// Mock browser Notification API to avoid permission prompt warnings.
if (!('Notification' in window)) {
  (window as unknown as { Notification: object }).Notification = { permission: 'default' };
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
        <AuthProvider>
          <div style={{
            minHeight: '100vh',
            background: 'var(--bg-page, #060A14)',
            padding: '32px',
          }}>
            <NotificationPreferences />
          </div>
        </AuthProvider>
      </QueryClientProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
