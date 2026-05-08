/**
 * Observatory v3 — GPU-driven particle visualization.
 *
 * Parallel route to /observatory (v2). Uses TripsLayer for animation,
 * overlaid MapboxOverlay mode, enhanced side panel widgets.
 * Designed for rip-and-replace: same hooks, same data, swap route when ready.
 */

import { useState, useCallback } from 'react';
import { useObservatoryThreats, useObservatoryStats, useObservatoryArcs, useObservatoryHeatmap } from '@/hooks/useObservatory';
import type { ArcData } from '@/hooks/useObservatory';
import { ThreatMapV3 } from './components/ThreatMapV3';
import type { MapMode } from './components/ThreatMapV3';
import { SidePanel } from './components/SidePanel';
import { useOperations } from '@/hooks/useOperations';
import type { Operation } from '@/hooks/useOperations';
import { Card, Tabs } from '@/components/ui';
import { ObservatoryVersionToggle } from '@/components/ui/ObservatoryVersionToggle';
import { EventTicker } from '@/features/observatory/components/EventTicker';
import { cn } from '@/lib/cn';
import { LiveIndicator } from '@/components/ui/LiveIndicator';
import { RefreshCw, PanelRightOpen, PanelRightClose } from 'lucide-react';
import { ObservatoryOverlay } from '@/features/observatory/components/ObservatoryOverlay';
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

export function ObservatoryV3() {
  const { isMobile } = useBreakpoint();
  const [period, setPeriod] = useState('7d');
  const [source] = useState('all');
  const [mapMode, setMapMode] = useState<MapMode>('global');
  const [colorBy, setColorBy] = useState<'severity' | 'type'>('severity');
  const [showNodes, setShowNodes] = useState(true);
  const [showBeams, setShowBeams] = useState(false); // beams off by default
  const [showParticles, setShowParticles] = useState(true);
  const [showPanel, setShowPanel] = useState(!isMobile);

  // Click state
  const [clickedArc, setClickedArc] = useState<{ arc: ArcData; x: number; y: number } | null>(null);
  const [clickedCluster, setClickedCluster] = useState<{ cluster: Operation; x: number; y: number } | null>(null);

  // ─── Data ──
  const { data: threatsRaw, isRefreshing, refetch } = useObservatoryThreats({ period, source });
  const threats = threatsRaw ?? [];
  const { data: stats } = useObservatoryStats({ period, source });
  const { data: arcs } = useObservatoryArcs({ period, source });
  const arcsResolved = arcs ?? [];
  const { data: operations = [] } = useOperations({ status: 'active', limit: 50 });
  const { data: heatmapRaw } = useObservatoryHeatmap({ period });
  const heatmapData = heatmapRaw ?? [];

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
              background: 'rgba(6,10,20,0.80)',
              border: '1px solid var(--border-base)',
              color: 'var(--text-secondary)',
              backdropFilter: 'blur(12px)',
              cursor: 'pointer',
            }}
          >
            {colorBy === 'severity' ? 'By Severity' : 'By Type'}
          </button>
        </div>
      </div>

      {/* ─── Top-right: Status + controls ─────────────────────── */}
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
            background: 'rgba(6,10,20,0.80)',
            border: '1px solid var(--border-base)',
            color: isRefreshing ? 'var(--amber)' : 'var(--text-muted)',
            cursor: 'pointer',
          }}
        >
          <RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} />
        </button>
      </div>

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
                background: active ? 'rgba(229,168,50,0.15)' : 'rgba(6,10,20,0.80)',
                border: `1px solid ${active ? 'rgba(229,168,50,0.30)' : 'var(--border-base)'}`,
                color: active ? 'var(--amber)' : 'var(--text-muted)',
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
          background: 'rgba(6,10,20,0.92)',
          backdropFilter: 'blur(20px)',
          borderTop: '1px solid var(--border-base)',
        }}
      >
        <div className="flex items-center gap-4">
          <div className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
            <span style={{ color: 'var(--amber)' }}>{PERIODS.find(p => p.id === period)?.label}</span>
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
        </Card>
      )}
    </div>
  );
}
