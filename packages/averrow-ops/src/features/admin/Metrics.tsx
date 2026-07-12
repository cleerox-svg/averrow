// /admin/metrics — legacy route.
//
// Tier 3 admin dashboard overhaul merged the 6-tab Metrics surface into
// /admin as additional tabs (see AdminDashboard.tsx). This file is now a
// pure redirect shim so old bookmarks / internal links resolve without a
// dangling route: `/admin/metrics?tab=<legacy-id>` -> `/admin?tab=<new-id>`.
//
// Legacy id -> new AdminDashboard tab id:
//   summary            -> overview
//   pipelines          -> pipelines
//   d1-budget          -> cost
//   ai-spend           -> cost
//   cost-optimization  -> cost
//   geo-coverage       -> geo
//   feed-failures      -> feeds
// No `?tab` (or an unrecognized id) -> overview.

import { Navigate, useSearchParams } from 'react-router-dom';

const LEGACY_TAB_MAP: Record<string, string> = {
  'summary':           'overview',
  'pipelines':         'pipelines',
  'd1-budget':         'cost',
  'ai-spend':          'cost',
  'cost-optimization': 'cost',
  'geo-coverage':       'geo',
  'feed-failures':      'feeds',
};

const DEFAULT_TARGET_TAB = 'overview';

export function Metrics() {
  const [searchParams] = useSearchParams();
  const legacyTab = searchParams.get('tab');
  const targetTab = (legacyTab && LEGACY_TAB_MAP[legacyTab]) || DEFAULT_TARGET_TAB;

  return <Navigate to={`/admin?tab=${targetTab}`} replace />;
}
