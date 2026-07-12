// Tier 3: /admin/metrics was merged into /admin as additional tabs
// (AdminDashboard.tsx). Metrics.tsx is now a pure redirect shim so old
// `/admin/metrics?tab=<legacy-id>` bookmarks/links resolve to the right
// `/admin?tab=<new-id>` tab instead of dangling.

import { describe, it, expect } from 'vitest';
import { Routes, Route } from 'react-router-dom';
import { renderWithProviders } from '@/test/utils';
import { Metrics } from './Metrics';

function navigateTo(path: string) {
  window.history.pushState({}, '', path);
}

function currentPath() {
  return window.location.pathname + window.location.search;
}

// Rendering <Metrics/> bare (no <Routes>) would leave it mounted forever —
// its own useSearchParams would then re-read the URL <Navigate> just wrote,
// treat the NEW tab id ("cost", "geo", ...) as an unrecognized legacy id,
// and redirect a second time to ?tab=overview. Real usage never hits this:
// App.tsx's <Route path="admin/metrics" element={<Metrics/>}/> unmounts
// Metrics as soon as the path no longer matches. Mirror that here with a
// minimal <Routes> so the shim's actual (single-redirect) behavior is what
// gets asserted.
function renderMetricsRoute() {
  return renderWithProviders(
    <Routes>
      <Route path="/admin/metrics" element={<Metrics />} />
      <Route path="/admin" element={<div>ADMIN PLACEHOLDER</div>} />
    </Routes>,
  );
}

describe('Metrics (legacy /admin/metrics redirect shim)', () => {
  it('redirects a bare /admin/metrics (no ?tab) to /admin?tab=overview', () => {
    navigateTo('/admin/metrics');
    renderMetricsRoute();
    expect(currentPath()).toBe('/admin?tab=overview');
  });

  it('redirects an unrecognized legacy ?tab to /admin?tab=overview', () => {
    navigateTo('/admin/metrics?tab=nonsense');
    renderMetricsRoute();
    expect(currentPath()).toBe('/admin?tab=overview');
  });

  // Legacy id -> new AdminDashboard tab id map (RESTRUCTURE Tier 3 spec).
  const LEGACY_MAP: Array<[string, string]> = [
    ['summary', 'overview'],
    ['pipelines', 'pipelines'],
    ['d1-budget', 'cost'],
    ['ai-spend', 'cost'],
    ['cost-optimization', 'cost'],
    ['geo-coverage', 'geo'],
    ['feed-failures', 'feeds'],
  ];

  it.each(LEGACY_MAP)('redirects legacy ?tab=%s to /admin?tab=%s', (legacyId, newId) => {
    navigateTo(`/admin/metrics?tab=${legacyId}`);
    renderMetricsRoute();
    expect(currentPath()).toBe(`/admin?tab=${newId}`);
  });
});
