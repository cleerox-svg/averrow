// v4 "Operations" workspace — consolidates the four flat platform-ops pages
// (Agents, Feeds, Takedown Integrations, Attribution Backlog) under one nav
// entry as deep-linkable tabs, shrinking the PLATFORM group. The old
// standalone paths (/agents, /feeds, /admin/integrations,
// /admin/agents/attribution-backlog, ...) redirect here (LEGACY_TAB_PATHS).
//
// Metrics is NOT a tab here — it has its own 7-pill internal tab bar and
// nesting it would create tab-inside-tab. It keeps its own nav row.

import { lazy } from 'react';
import { TabbedWorkspace, type WorkspaceTab } from '@/components/v4/TabbedWorkspace';

const Agents = lazy(() => import('@/features/agents/Agents').then(m => ({ default: m.Agents })));
const Feeds = lazy(() => import('@/features/feeds/Feeds').then(m => ({ default: m.Feeds })));
const Integrations = lazy(() => import('@/features/integrations/Integrations').then(m => ({ default: m.Integrations })));
const AttributionBacklog = lazy(() => import('@/features/admin/AttributionBacklog').then(m => ({ default: m.AttributionBacklog })));

const TABS: WorkspaceTab[] = [
  { id: 'agents', label: 'Agents', Component: Agents,
    def: 'The autonomous agent fleet — runs, success rates, errors, and per-agent health across the mesh.' },
  { id: 'feeds', label: 'Feeds', Component: Feeds,
    def: 'Threat-feed ingestion — per-feed pull health, failure streaks, circuit-breaker state, and manual controls.' },
  { id: 'takedown-integrations', label: 'Takedown integrations', Component: Integrations,
    def: 'Takedown submitter health — per-provider success rates and submission outcomes for the auto-takedown pipeline.' },
  { id: 'attribution', label: 'Attribution backlog', Component: AttributionBacklog,
    def: 'Infrastructure clusters awaiting threat-actor attribution, ordered by threat volume.' },
];

export function OperationsWorkspace() {
  return <TabbedWorkspace crumb="Platform" title="Operations" tabs={TABS} />;
}
