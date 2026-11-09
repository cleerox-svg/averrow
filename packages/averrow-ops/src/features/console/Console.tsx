// SOC Console — the v4 analyst daily-driver workspace.
//
// A BOLD cinematic header (big KPI hero + deep-linkable tab
// bar) over the existing queue pages mounted as tab bodies. Built on
// @averrow/shared/ui + live data — no page-logic rewrites. The hero is the
// "this is clearly v4" surface (matches the approved prototype).

import { Fragment, Suspense, lazy } from 'react';
import { useSearchParams } from 'react-router-dom';
import { StatTile, Tabs, WorkspaceEmbedProvider } from '@averrow/shared/ui';
import { useOpenAlertCount } from '@/hooks/useOpenAlertCount';
import { useIncidents } from '@/features/admin-incidents/useIncidents';
import { useAuth } from '@/lib/auth';
import { PageState } from '@/design-system/components';
import { loadAlerts, loadThreats, loadTakedowns, loadIncidents } from './tabLoaders';
import './console.css';

type ConsoleTab = 'alerts' | 'threats' | 'incidents' | 'takedowns';

const TABS: { id: ConsoleTab; label: string; def: string }[] = [
  {
    id: 'alerts', label: 'Alerts',
    def: 'Auto-triaged alerts that need a human look — suspected impersonations (social & app-store), phishing domains, and brand lookalikes surfaced from detections.',
  },
  {
    id: 'threats', label: 'Threats',
    def: 'The full inventory of threats we’re tracking — malicious domains, URLs, and indicators mapped to your brands.',
  },
  {
    id: 'incidents', label: 'Incidents',
    def: 'Platform & operational incidents — feed outages, provider surges, and infrastructure-health events the platform auto-opens.',
  },
  {
    id: 'takedowns', label: 'Takedowns',
    def: 'Takedown requests and where each one sits in its lifecycle — draft, submitted, resolved, or dismissed.',
  },
];
const TAB_VALUES: readonly string[] = TABS.map(t => t.id);
function isTab(v: string | null): v is ConsoleTab {
  return v != null && TAB_VALUES.includes(v);
}
// `?tab=signals` was the pre-consolidation id for the Alerts tab.
function tabFromParam(v: string | null): ConsoleTab {
  if (v === 'signals') return 'alerts';
  return isTab(v) ? v : 'alerts';
}

const Alerts = lazy(loadAlerts);
const Threats = lazy(loadThreats);
const Takedowns = lazy(loadTakedowns);
const Incidents = lazy(loadIncidents);

export function Console() {
  const [params, setParams] = useSearchParams();
  // Derived from the URL (not mirrored into state) so redirects and links that
  // only change `?tab=` switch panes.
  const tab = tabFromParam(params.get('tab'));
  const { data: openSignals = null, isError: signalsError, enabled: canTriage } = useOpenAlertCount();

  // /api/admin/incidents is super_admin-only: other roles must not request it,
  // and get no incidents KPIs, tab or pane (a 403 would read as "0 incidents").
  const { isSuperAdmin } = useAuth();
  const { data: incidents, isError: incidentsError } = useIncidents({ onlyOpen: true, enabled: isSuperAdmin });
  const openIncidents = incidents?.length ?? null;
  const criticalIncidents = incidents ? incidents.filter(i => i.severity === 'critical').length : null;

  function selectTab(next: ConsoleTab) {
    // Only `tab` carries over; other params belong to the pane being left.
    setParams(next === 'alerts' ? {} : { tab: next }, { replace: true });
  }

  const active = TABS.find(t => t.id === tab);
  const incidentsLocked = tab === 'incidents' && !isSuperAdmin;

  return (
    <div className="console-v4">
      <div className="console-head">
        <div>
          <div className="console-crumb">{'SOC console'}</div>
          <h1 className="console-title">Console</h1>
        </div>
      </div>

      {/* KPI hero — numbers render immediately (no count-up); each tile jumps to its queue. */}
      <div className="kpi-grid">
        {canTriage && (
          <StatTile tone="neutral" label="Open alerts"        value={openSignals}       sub="awaiting triage" onClick={() => selectTab('alerts')} error={signalsError} />
        )}
        {isSuperAdmin && (
          <>
            <StatTile tone="red"   label="Critical incidents" value={criticalIncidents} sub="need eyes now"    onClick={() => selectTab('incidents')} error={incidentsError} />
            <StatTile tone="blue"  label="Open incidents"     value={openIncidents}     sub="platform & ops"   onClick={() => selectTab('incidents')} error={incidentsError} />
          </>
        )}
      </div>

      {/* deep-linkable tab bar: kit Tabs (tablist / aria-selected / arrow keys) */}
      <Tabs
        variant="underline"
        size="md"
        aria-label="Console sections"
        className="console-tabbar"
        tabs={TABS.filter(t => t.id !== 'incidents' || isSuperAdmin).map(t => ({ id: t.id, label: t.label }))}
        activeTab={tab}
        onChange={id => { if (isTab(id)) selectTab(id); }}
      />

      {active?.def && !incidentsLocked && <p className="console-def">{active.def}</p>}

      {/* Only the active pane renders, so the tabs carry no aria-controls; the
          panel is named directly (aria-label) instead of via a tab id. */}
      <div role="tabpanel" id={`tabpanel-${tab}`} aria-label={active?.label}>
      <Suspense fallback={<PageState kind="loading" />}>
        {/* The Console owns the view's single h1; embedded panes drop theirs. */}
        <WorkspaceEmbedProvider>
          <Fragment key={params.get('q') ?? ''}>
            {tab === 'alerts'    && <Alerts />}
            {tab === 'threats'   && <Threats />}
            {tab === 'incidents' && isSuperAdmin && <Incidents />}
            {incidentsLocked && (
              <PageState kind="locked" title="Incidents are restricted" description="Platform incidents are visible to super admins only." />
            )}
            {tab === 'takedowns' && <Takedowns />}
          </Fragment>
        </WorkspaceEmbedProvider>
      </Suspense>
      </div>
    </div>
  );
}
