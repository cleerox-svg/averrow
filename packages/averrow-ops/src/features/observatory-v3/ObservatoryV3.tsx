/**
 * Observatory v3 — GPU-driven particle visualization.
 *
 * Parallel route to /observatory (v2). Uses TripsLayer for animation,
 * overlaid MapboxOverlay mode, enhanced side panel widgets.
 * Designed for rip-and-replace: same hooks, same data, swap route when ready.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useObservatoryThreats, useObservatoryStats, useObservatoryArcs, useObservatoryHeatmap } from '@/hooks/useObservatory';
import type { ArcData } from '@/hooks/useObservatory';
import { ThreatMapV3 } from './components/ThreatMapV3';
import type { MapMode } from './components/ThreatMapV3';
import { SidePanel } from './components/SidePanel';
import { BottomSheet } from '@/components/BottomSheet';
import { useOperations } from '@/hooks/useOperations';
import type { Operation } from '@/hooks/useOperations';
import { Card, Tabs, Button } from '@/components/ui';
import { ObservatoryVersionToggle } from '@/components/ui/ObservatoryVersionToggle';
import { EventTicker } from '@/components/observatory/EventTicker';
import { cn } from '@/lib/cn';
import { LiveIndicator } from '@/components/ui/LiveIndicator';
import { RefreshCw, PanelRightOpen, PanelRightClose, AlertTriangle, ChevronDown } from 'lucide-react';
import { ObservatoryOverlay } from '@/components/observatory/ObservatoryOverlay';
import { useBreakpoint } from '@/hooks/useBreakpoint';

const PERIODS = [
  { id: '24h', label: '24H' },
  { id: '7d', label: '7D' },
  { id: '30d', label: '30D' },
  { id: '90d', label: '90D' },
];

const MAP_MODES: { id: MapMode; label: string }[] = [
  { id: 'global', label: 'GLOBAL' },
  { id: 'operations', label: 'OPERATIONS' },
  { id: 'heatmap', label: 'HEATMAP' },
];

const SOURCES = [
  { id: 'all', label: 'All Sources' },
  { id: 'feeds', label: 'Feeds' },
  { id: 'spam_trap', label: 'Spam Trap' },
];

export function ObservatoryV3() {
  const navigate = useNavigate();
  const { isMobile } = useBreakpoint();
  const [period, setPeriod] = useState('7d');
  const [source, setSource] = useState('all');
  const [mapMode, setMapMode] = useState<MapMode>('global');
  const [colorBy, setColorBy] = useState<'severity' | 'type'>('severity');
  const [showNodes, setShowNodes] = useState(true);
  const [showBeams, setShowBeams] = useState(false); // beams off by default
  const [showParticles, setShowParticles] = useState(true);
  const [showPanel, setShowPanel] = useState(!isMobile);
  // C1 — mobile-only: the 3 control rows (mode/period/source) collapse
  // behind a single summary toggle so they don't crowd the map. Mirrors
  // v2's Observatory.tsx filtersExpanded pattern (~line 70-83).
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // C2 — mobile-only: bottom-sheet drawer exposing the same SidePanel
  // widgets desktop gets docked on the right.
  const [showMobilePanel, setShowMobilePanel] = useState(false);

  const handleFilterSelect = useCallback((setter: () => void) => {
    setter();
    if (collapseTimer.current) clearTimeout(collapseTimer.current);
    collapseTimer.current = setTimeout(() => setFiltersExpanded(false), 300);
  }, []);

  useEffect(() => {
    return () => {
      if (collapseTimer.current) clearTimeout(collapseTimer.current);
    };
  }, []);

  // Review fix (LOW): if the viewport crosses back to desktop while the
  // mobile filter panel/drawer is open, don't let it silently spring back
  // open the next time the viewport narrows to mobile again.
  useEffect(() => {
    if (!isMobile) {
      setFiltersExpanded(false);
      setShowMobilePanel(false);
    }
  }, [isMobile]);

  // Click state
  const [clickedArc, setClickedArc] = useState<{ arc: ArcData; x: number; y: number } | null>(null);
  const [clickedCluster, setClickedCluster] = useState<{ cluster: Operation; x: number; y: number } | null>(null);

  // ─── Data ──
  const { data: threatsRaw, isRefreshing, error: threatsError, refetch } = useObservatoryThreats({ period, source });
  const threats = threatsRaw ?? [];
  const { data: stats, error: statsError, refetch: refetchStats } = useObservatoryStats({ period, source });
  const { data: arcs, error: arcsError, refetch: refetchArcs } = useObservatoryArcs({ period, source });
  const arcsResolved = arcs ?? [];
  const { data: operations = [] } = useOperations({ status: 'active', limit: 50 });
  const { data: heatmapRaw, error: heatmapError, refetch: refetchHeatmap } = useObservatoryHeatmap({ period });
  const heatmapData = heatmapRaw ?? [];

  // Uniform across the four useObservatoryQuery-backed hooks above — same
  // { error, refetch } shape (useObservatoryQuery.ts), so one combined
  // retry-all affordance covers them without per-query bespoke handling.
  const loadError = threatsError || statsError || arcsError || heatmapError;
  const retryFailed = useCallback(() => {
    if (threatsError) refetch();
    if (statsError) refetchStats();
    if (arcsError) refetchArcs();
    if (heatmapError) refetchHeatmap();
  }, [threatsError, statsError, arcsError, heatmapError, refetch, refetchStats, refetchArcs, refetchHeatmap]);

  const handleArcClick = useCallback((arc: ArcData, x: number, y: number) => {
    setClickedCluster(null);
    setClickedArc({ arc, x: Math.min(x, window.innerWidth - 340), y: Math.min(y, window.innerHeight - 200) });
  }, []);

  const handleClusterClick = useCallback((cluster: Operation, x: number, y: number) => {
    setClickedArc(null);
    setClickedCluster({ cluster, x: Math.min(x, window.innerWidth - 340), y: Math.min(y, window.innerHeight - 250) });
  }, []);

  return (
    <div className="relative h-[calc(100vh-3rem)] overflow-hidden">
      {/* Full-screen map */}
      <div className={cn('absolute inset-0', isMobile ? 'bottom-[108px]' : 'bottom-[84px]')}>
        <ThreatMapV3
          threats={threats}
          arcs={arcsResolved}
          showBeams={showBeams}
          showParticles={showParticles}
          showNodes={showNodes}
          colorBy={colorBy}
          mapMode={mapMode}
          period={period}
          operations={operations}
          heatmapData={heatmapData}
          onArcClick={handleArcClick}
          onClusterClick={handleClusterClick}
        />
        {threats.length === 0 && (
          <ObservatoryOverlay
            historicalThreats={stats?.threats_mapped ?? 0}
            historicalCountries={stats?.countries ?? 0}
            timeWindow={PERIODS.find(p => p.id === period)?.label ?? period}
          />
        )}
      </div>

      {/* ─── Top controls ─────────────────────────────────────── */}
      {isMobile ? (
        /* R10 mobile chrome (C1): fold Mode + Period + Source behind a
           single collapsible summary toggle so 3 stacked rows don't sit
           on top of the map. Pattern mirrors v2's Observatory.tsx
           filtersExpanded block (~line 184-268). Desktop branch below is
           untouched. */
        <div className="absolute top-3 left-0 right-0 z-10 flex flex-col gap-1.5 px-4">
          {/* Review fix (MUST #1): the unconditional top-right cluster
              (ObservatoryVersionToggle + LiveIndicator + Refresh, below)
              shares this same top-3 band on desktop. On mobile it's gated
              off entirely and a minimal LiveIndicator + Refresh subset
              rides in-flow alongside the summary toggle instead of
              absolutely-pinned top-right — normal flexbox flow means it
              can never overlap the summary button, at any width. */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setFiltersExpanded(prev => !prev)}
              className="ds-focusable"
              style={{
                flex: 1,
                minWidth: 0,
                background: 'var(--bg-card)',
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
                border: '1px solid var(--border-base)',
                borderRadius: 10,
                padding: '8px 14px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                cursor: 'pointer',
                outline: 'none',
              }}
            >
              <span className="text-xs font-mono truncate">
                <span style={{ color: 'var(--amber-text)' }}>{MAP_MODES.find(m => m.id === mapMode)?.label}</span>
                <span style={{ color: 'var(--text-tertiary)' }}> · </span>
                <span style={{ color: 'var(--amber-text)' }}>{PERIODS.find(p => p.id === period)?.label}</span>
                <span style={{ color: 'var(--text-tertiary)' }}> · </span>
                <span style={{ color: 'var(--amber-text)' }}>{SOURCES.find(s => s.id === source)?.label}</span>
              </span>
              <ChevronDown
                className={cn('w-3.5 h-3.5 transition-transform duration-300 shrink-0', filtersExpanded && 'rotate-180')}
                style={{ color: 'var(--text-tertiary)' }}
              />
            </button>
            <div className="flex items-center gap-1.5 shrink-0">
              <LiveIndicator />
              <button
                onClick={() => refetch()}
                className="ds-focusable p-1.5 rounded-md transition-colors"
                style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-base)',
                  color: isRefreshing ? 'var(--amber-text)' : 'var(--text-muted)',
                  cursor: 'pointer',
                }}
              >
                <RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} />
              </button>
            </div>
          </div>

          <div
            className={cn(
              'overflow-hidden transition-all duration-300 ease-in-out',
              filtersExpanded ? 'max-h-[420px] opacity-100' : 'max-h-0 opacity-0'
            )}
          >
            <Card variant="elevated" style={{ marginTop: 4, padding: '8px 14px' }}>
              {/* VIEW group (map mode) */}
              <div style={{ padding: '6px 0' }}>
                <div className="text-[10px] font-mono uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>View</div>
                <Tabs
                  tabs={MAP_MODES.map(m => ({ id: m.id, label: m.label }))}
                  activeTab={mapMode}
                  onChange={(id) => handleFilterSelect(() => setMapMode(id as MapMode))}
                  variant="bar"
                />
              </div>

              {/* TIME group */}
              <div style={{ padding: '6px 0', borderTop: '1px solid var(--border-base)' }}>
                <div className="text-[10px] font-mono uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>Time</div>
                <Tabs
                  tabs={PERIODS.map(p => ({ id: p.id, label: p.label }))}
                  activeTab={period}
                  onChange={(id) => handleFilterSelect(() => setPeriod(id))}
                  variant="bar"
                />
              </div>

              {/* COLOR group */}
              <div style={{ padding: '6px 0', borderTop: '1px solid var(--border-base)' }}>
                <div className="text-[10px] font-mono uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>Color</div>
                <button
                  onClick={() => handleFilterSelect(() => setColorBy(colorBy === 'severity' ? 'type' : 'severity'))}
                  className="font-mono text-[9px] px-2.5 py-1.5 rounded-md uppercase tracking-wider"
                  style={{
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border-base)',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                  }}
                >
                  {colorBy === 'severity' ? 'By Severity' : 'By Type'}
                </button>
              </div>

              {/* SOURCE group */}
              <div style={{ padding: '6px 0', borderTop: '1px solid var(--border-base)' }}>
                <div className="text-[10px] font-mono uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>Source</div>
                <Tabs
                  tabs={SOURCES.map(s => ({ id: s.id, label: s.label }))}
                  activeTab={source}
                  onChange={(id) => handleFilterSelect(() => setSource(id))}
                  variant="bar"
                />
              </div>
            </Card>
          </div>
        </div>
      ) : (
        <div className="absolute top-3 left-4 z-10 flex flex-col gap-1.5">
          {/* Mode tabs */}
          <Tabs
            tabs={MAP_MODES.map(m => ({ id: m.id, label: m.label }))}
            activeTab={mapMode}
            onChange={(id) => setMapMode(id as MapMode)}
            variant="bar"
          />
          {/* Period + controls row */}
          <div className="flex items-center gap-2">
            <Tabs
              tabs={PERIODS.map(p => ({ id: p.id, label: p.label }))}
              activeTab={period}
              onChange={setPeriod}
              variant="bar"
            />
            <button
              onClick={() => setColorBy(colorBy === 'severity' ? 'type' : 'severity')}
              className="font-mono text-[9px] px-2.5 py-1.5 rounded-md uppercase tracking-wider"
              style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border-base)',
                color: 'var(--text-secondary)',
                backdropFilter: 'blur(12px)',
                cursor: 'pointer',
              }}
            >
              {colorBy === 'severity' ? 'By Severity' : 'By Type'}
            </button>
          </div>
          {/* Source filter row — mirrors v2 Observatory.tsx SOURCES tabs */}
          <Tabs
            tabs={SOURCES.map(s => ({ id: s.id, label: s.label }))}
            activeTab={source}
            onChange={setSource}
            variant="bar"
          />
        </div>
      )}

      {/* ─── Top-right: Status + controls (desktop) ────────────────
          Review fix (MUST #1): this whole cluster shared the top-3 band
          with the new mobile filter summary and overlapped it at 375px.
          Gated to desktop; mobile gets a minimal LiveIndicator + Refresh
          subset laid out in-flow next to the summary toggle instead (see
          the isMobile controls branch above) — no absolute-position
          overlap possible. ObservatoryVersionToggle is dropped on mobile
          rather than repositioned since it's slated for removal in the
          next phase (v2 retirement). */}
      {!isMobile && (
        <div className="absolute top-3 right-4 z-10 flex items-center gap-2">
          {/* v2 / v3 toggle */}
          <ObservatoryVersionToggle />
          {/* Live indicator */}
          <LiveIndicator />
          {/* Refresh */}
          <button
            onClick={() => refetch()}
            className="p-1.5 rounded-md transition-colors"
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--border-base)',
              color: isRefreshing ? 'var(--amber-text)' : 'var(--text-muted)',
              cursor: 'pointer',
            }}
          >
            <RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      )}

      {/* ─── Load-error banner ──────────────────────────────────
          Mirrors v2's Observatory.tsx "Load failed / Retry" affordance
          (previously the only version that surfaced this) — a failed
          threats/stats/arcs/heatmap fetch no longer renders silently. */}
      {loadError && (
        <Card
          variant="critical"
          style={{
            position: 'absolute',
            top: 56,
            // Clear the default-open desktop SidePanel (w-80 = 320px) +
            // its own inset gap; collapses to a flat right-16 when the
            // panel is closed or on mobile (SidePanel doesn't render there).
            right: showPanel && !isMobile ? 336 : 16,
            zIndex: 30,
            padding: '8px 12px',
            maxWidth: 260,
          }}
        >
          <div className="flex items-center gap-2">
            <AlertTriangle size={13} style={{ color: 'var(--sev-critical)', flexShrink: 0 }} />
            <span className="font-mono text-[10px]" style={{ color: 'var(--sev-critical)' }}>
              Observatory data failed to load
            </span>
          </div>
          <div className="mt-1.5">
            <Button variant="danger" size="sm" onClick={retryFailed} icon={<RefreshCw size={11} />}>
              Retry
            </Button>
          </div>
        </Card>
      )}

      {/* ─── Bottom-left: Layer toggles ───────────────────────── */}
      {!isMobile && mapMode === 'global' && (
        <div
          className="absolute bottom-[96px] left-4 z-10 flex gap-2"
        >
          {[
            { key: 'nodes', label: 'Nodes', active: showNodes, set: setShowNodes },
            { key: 'particles', label: 'Particles', active: showParticles, set: setShowParticles },
            { key: 'beams', label: 'Beams', active: showBeams, set: setShowBeams },
          ].map(({ key, label, active, set }) => (
            <button
              key={key}
              onClick={() => set(!active)}
              className="font-mono text-[9px] px-2.5 py-1.5 rounded-md uppercase tracking-wider transition-all"
              style={{
                background: active ? 'rgba(229,168,50,0.15)' : 'var(--bg-card)',
                border: `1px solid ${active ? 'rgba(229,168,50,0.30)' : 'var(--border-base)'}`,
                color: active ? 'var(--amber-text)' : 'var(--text-muted)',
                backdropFilter: 'blur(12px)',
                cursor: 'pointer',
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* ─── Stats bar ────────────────────────────────────────── */}
      <div
        className="absolute left-0 right-0 z-10 flex items-center justify-between px-4"
        style={{
          bottom: isMobile ? 72 : 48,
          height: 36,
          background: 'var(--bg-card-deep)',
          backdropFilter: 'blur(20px)',
          borderTop: '1px solid var(--border-base)',
        }}
      >
        <div className="flex items-center gap-4">
          <div className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
            <span style={{ color: 'var(--amber-text)' }}>{PERIODS.find(p => p.id === period)?.label}</span>
            {' \u00b7 '}
            <span style={{ color: 'var(--text-secondary)' }}>{(stats?.threats_mapped ?? 0).toLocaleString()}</span> threats
            {' \u00b7 '}
            <span style={{ color: 'var(--text-secondary)' }}>{stats?.countries ?? 0}</span> countries
            {' \u00b7 '}
            <span style={{ color: 'var(--text-secondary)' }}>{arcsResolved.length}</span> arcs
          </div>
        </div>
        <div className="font-mono text-[9px]" style={{ color: 'var(--text-muted)' }}>
          {showParticles && mapMode === 'global' && (
            <span style={{ color: 'var(--sev-info)' }}>GPU particles active</span>
          )}
        </div>
      </div>

      {/* ─── Event ticker ─────────────────────────────────────── */}
      <div className="absolute bottom-0 left-0 right-0 z-10" style={{ height: isMobile ? 72 : 48 }}>
        <EventTicker />
      </div>

      {/* ─── Right panel (desktop) ────────────────────────────── */}
      {!isMobile && (
        <SidePanel period={period} visible={showPanel && mapMode !== 'heatmap'} />
      )}

      {/* Panel toggle */}
      {!isMobile && mapMode !== 'heatmap' && (
        <button
          onClick={() => setShowPanel(!showPanel)}
          className="absolute top-1/2 z-30 transform -translate-y-1/2"
          style={{
            ...(showPanel ? { right: '320px' } : { right: 0 }),
            background: 'var(--bg-card)',
            backdropFilter: 'blur(20px)',
            border: '1px solid var(--border-base)',
            borderRadius: '8px 0 0 8px',
            padding: '12px 4px',
            color: 'var(--text-tertiary)',
            cursor: 'pointer',
          }}
        >
          {showPanel ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
        </button>
      )}

      {/* ─── Intel FAB (mobile) — opens the bottom-sheet drawer ── */}
      {isMobile && mapMode !== 'heatmap' && (
        <button
          onClick={() => setShowMobilePanel(true)}
          className="absolute z-20 flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-wide"
          style={{
            bottom: 120,
            right: 16,
            padding: '9px 16px',
            borderRadius: 999,
            background: 'var(--bg-card)',
            border: '1px solid var(--border-base)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            color: 'var(--amber-text)',
            boxShadow: 'var(--card-shadow)',
            cursor: 'pointer',
          }}
        >
          <PanelRightOpen size={13} />
          Intel
        </button>
      )}

      {/* ─── Intel drawer (mobile) — reuses the existing BottomSheet
          primitive (src/components/BottomSheet.tsx, already used by
          UserAvatar/NotificationBell) instead of a hand-rolled portal.
          Gets Esc-to-close + body-scroll-lock for free. BottomSheet owns
          the single scroll container (its own `flex-1 overflow-y-auto`
          wraps these children), so the title row below is made sticky
          rather than adding a second scroll container. BottomSheet
          already renders its own grip handle, so ours is dropped; it has
          no title/close of its own, so both are kept here. */}
      {isMobile && mapMode !== 'heatmap' && (
        <BottomSheet open={showMobilePanel} onClose={() => setShowMobilePanel(false)}>
          <div
            className="flex items-center justify-between px-4 pb-2"
            style={{
              position: 'sticky',
              top: 0,
              zIndex: 1,
              background: 'var(--bg-card-deep)',
              borderBottom: '1px solid var(--border-base)',
            }}
          >
            <span className="font-mono text-[9px] uppercase tracking-[0.2em]" style={{ color: 'var(--text-tertiary)' }}>
              Intelligence
            </span>
            <button
              onClick={() => setShowMobilePanel(false)}
              aria-label="Close intelligence panel"
              style={{ padding: 4, background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer' }}
            >
              <PanelRightClose size={14} />
            </button>
          </div>
          <SidePanel period={period} visible mobile />
        </BottomSheet>
      )}

      {/* ─── Click cards (arc / cluster detail) ───────────────── */}
      {clickedArc && (
        <Card
          variant="elevated"
          className="absolute z-40"
          style={{ left: clickedArc.x, top: clickedArc.y, width: 300, padding: 16 }}
        >
          <div className="flex justify-between items-start mb-2">
            <span className="font-mono text-xs font-bold capitalize" style={{ color: 'var(--text-primary)' }}>
              {clickedArc.arc.threat_type?.replace(/_/g, ' ')}
            </span>
            <button onClick={() => setClickedArc(null)} className="text-white/30 hover:text-white/60" style={{ cursor: 'pointer', background: 'none', border: 'none' }}>
              x
            </button>
          </div>
          <div className="space-y-1 text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
            <div>{clickedArc.arc.volume} threat{clickedArc.arc.volume > 1 ? 's' : ''}</div>
            {clickedArc.arc.brand_name && <div style={{ color: 'var(--amber)' }}>Target: {clickedArc.arc.brand_name}</div>}
            {clickedArc.arc.source_region && <div>From: {clickedArc.arc.source_region}</div>}
            <div className="uppercase" style={{ color: `var(--sev-${clickedArc.arc.severity || 'medium'})` }}>
              {clickedArc.arc.severity}
            </div>
          </div>
        </Card>
      )}

      {clickedCluster && (
        <Card
          variant="elevated"
          className="absolute z-40"
          style={{ left: clickedCluster.x, top: clickedCluster.y, width: 300, padding: 16 }}
        >
          <div className="flex justify-between items-start mb-2">
            <span className="font-mono text-xs font-bold" style={{ color: 'var(--text-primary)' }}>
              {clickedCluster.cluster.cluster_name || 'Unnamed Operation'}
            </span>
            <button onClick={() => setClickedCluster(null)} className="text-white/30 hover:text-white/60" style={{ cursor: 'pointer', background: 'none', border: 'none' }}>
              x
            </button>
          </div>
          <div className="space-y-1 text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
            <div>{clickedCluster.cluster.threat_count} threats</div>
            <div>{clickedCluster.cluster.status}</div>
            {clickedCluster.cluster.agent_notes && (
              <div className="mt-1 text-[9px] line-clamp-3" style={{ color: 'var(--text-tertiary)' }}>
                {clickedCluster.cluster.agent_notes}
              </div>
            )}
          </div>
          {/* GO4: pivot the map detail card into the campaign. */}
          <button
            onClick={() => navigate(`/campaigns/${clickedCluster.cluster.id}`)}
            className="mt-2 font-mono text-[10px] font-semibold uppercase tracking-wide hover:underline"
            style={{ color: 'var(--amber)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          >
            View campaign →
          </button>
        </Card>
      )}
    </div>
  );
}
