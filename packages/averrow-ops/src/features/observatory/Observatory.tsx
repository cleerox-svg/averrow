import { useState, useEffect, useCallback, useRef, memo, useMemo } from 'react';
import { useObservatoryThreats, useObservatoryStats, useObservatoryArcs, useObservatoryHeatmap } from '@/hooks/useObservatory';
import type { ArcData } from '@/hooks/useObservatory';
import { ThreatMap } from './components/ThreatMap';
import type { MapMode } from './components/ThreatMap';
import { useBrands } from '@/hooks/useBrands';
import { useProviders } from '@/hooks/useProviders';
import { useAgents } from '@/hooks/useAgents';
import { useOperations } from '@/hooks/useOperations';
import type { Operation } from '@/hooks/useOperations';
import { Card, Tabs, FilterBar, Badge } from '@/components/ui';
import { EventTicker } from './components/EventTicker';
import { relativeTime } from '@/lib/time';
import { cn } from '@/lib/cn';
import { LiveIndicator } from '@/components/ui/LiveIndicator';
import { ObservatoryVersionToggle } from '@/components/ui/ObservatoryVersionToggle';
import { X, ChevronDown, Activity, Loader2, RefreshCw } from 'lucide-react';
import { ObservatoryOverlay } from './components/ObservatoryOverlay';
import { EmptyState } from '@/components/ui/EmptyState';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { BIMIGradeBadge } from '@/components/ui/BIMIGradeBadge';
import { AgentAttribution } from '@/components/ui/AgentAttribution';

const PERIODS = [
  { id: '24h', label: '24H' },
  { id: '7d', label: '7D' },
  { id: '30d', label: '30D' },
  { id: '90d', label: '90D' },
];

const SOURCES = [
  { id: 'all', label: 'All Sources' },
  { id: 'feeds', label: 'Feeds' },
  { id: 'spam_trap', label: 'Spam Trap' },
];

const MAP_MODES: { id: MapMode; label: string }[] = [
  { id: 'global', label: 'GLOBAL' },
  { id: 'operations', label: 'OPERATIONS' },
  { id: 'heatmap', label: 'HEATMAP' },
];

function parseJsonArray(val: string | null): string[] {
  if (!val) return [];
  try { return JSON.parse(val) as string[]; }
  catch { return []; }
}

function countryFlag(code: string): string {
  if (!code || code.length !== 2) return '';
  return String.fromCodePoint(
    ...code.toUpperCase().split('').map(c => 0x1F1E6 + c.charCodeAt(0) - 65),
  );
}

export function Observatory() {
  const { isMobile } = useBreakpoint();
  const [period, setPeriod] = useState('7d');
  const [source, setSource] = useState('all');
  const [showBeams, setShowBeams] = useState(true);
  const [showParticles, setShowParticles] = useState(true);
  const [showNodes, setShowNodes] = useState(true);
  const [colorBy, setColorBy] = useState<'severity' | 'type'>('severity');
  const [showPanel, setShowPanel] = useState(!isMobile);
  const [mobileActiveTab, setMobileActiveTab] = useState<'brands' | 'intel' | 'feed' | null>(null);
  const [clock, setClock] = useState('');
  const [mapMode, setMapMode] = useState<MapMode>('global');
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Clicked element state
  const [clickedArc, setClickedArc] = useState<{ arc: ArcData; x: number; y: number } | null>(null);
  const [clickedCluster, setClickedCluster] = useState<{ cluster: Operation; x: number; y: number } | null>(null);

  const { data: threatsRaw, isRefreshing, error: threatsError, refetch } = useObservatoryThreats({ period, source });
  const threats = threatsRaw ?? [];
  const { data: stats } = useObservatoryStats({ period, source });
  const { data: arcs } = useObservatoryArcs({ period, source });
  const arcsResolved = arcs ?? [];
  const { data: operations = [] } = useOperations({ status: 'active', limit: 50 });
  const { data: heatmapRaw } = useObservatoryHeatmap({ period });
  const heatmapData = heatmapRaw ?? [];

  // Close click cards on Escape or click elsewhere
  useEffect(() => {
    function handleEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setClickedArc(null);
        setClickedCluster(null);
      }
    }
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, []);

  const handleArcClick = useCallback((arc: ArcData, x: number, y: number) => {
    setClickedCluster(null);
    setClickedArc({ arc, x: Math.min(x, window.innerWidth - 340), y: Math.min(y, window.innerHeight - 200) });
  }, []);

  const handleClusterClick = useCallback((cluster: Operation, x: number, y: number) => {
    setClickedArc(null);
    setClickedCluster({ cluster, x: Math.min(x, window.innerWidth - 340), y: Math.min(y, window.innerHeight - 250) });
  }, []);

  // Close panels when switching modes
  useEffect(() => {
    setClickedArc(null);
    setClickedCluster(null);
    if (mapMode === 'heatmap') {
      setShowPanel(false);
    } else {
      setShowPanel(!isMobile);
    }
  }, [mapMode, isMobile]);

  // Live clock
  useEffect(() => {
    const tzAbbr = Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
      .formatToParts(new Date())
      .find(p => p.type === 'timeZoneName')?.value || 'LOCAL';

    function update() {
      setClock(
        new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' ' + tzAbbr
      );
    }
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="relative h-[calc(100vh-3rem)] overflow-hidden">
      {/* Full-screen map */}
      <div className={cn('absolute inset-0', isMobile ? 'bottom-[108px]' : 'bottom-[84px]')}>
        <ThreatMap
          threats={threats}
          arcs={arcsResolved}
          showBeams={showBeams}
          showParticles={showParticles}
          showNodes={showNodes}
          colorBy={colorBy}
          mapMode={mapMode}
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

      {/* Top-left: Mode switcher + Period selector + Color mode */}
      {isMobile ? (
        <div className="absolute top-3 left-0 right-0 z-10 flex flex-col gap-1.5 px-4">
          {/* Row 1: Mode tabs */}
          <Tabs
            tabs={MAP_MODES.map(m => ({ id: m.id, label: m.label }))}
            activeTab={mapMode}
            onChange={(id) => setMapMode(id as MapMode)}
            variant="bar"
          />
          {/* Row 2: Collapsible filter bar */}
          <div>
            {/* Summary bar (collapsed) */}
            <button
              onClick={() => setFiltersExpanded(prev => !prev)}
              style={{
                width: '100%',
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
              <span className="text-xs font-mono">
                <span style={{ color: 'var(--amber)' }}>{PERIODS.find(p => p.id === period)?.label}</span>
                {mapMode === 'global' && (
                  <>
                    <span style={{ color: 'var(--text-tertiary)' }}> · </span>
                    <span className="capitalize" style={{ color: 'var(--amber)' }}>{colorBy}</span>
                  </>
                )}
                <span style={{ color: 'var(--text-tertiary)' }}> · </span>
                <span style={{ color: 'var(--amber)' }}>{SOURCES.find(s => s.id === source)?.label}</span>
              </span>
              <ChevronDown className={cn(
                'w-3.5 h-3.5 transition-transform duration-300',
                filtersExpanded && 'rotate-180'
              )} style={{ color: 'var(--text-tertiary)' }} />
            </button>

            {/* Expanded filter groups */}
            <div
              className={cn(
                'overflow-hidden transition-all duration-300 ease-in-out',
                filtersExpanded ? 'max-h-60 opacity-100' : 'max-h-0 opacity-0'
              )}
            >
              <Card variant="elevated" style={{ marginTop: 4, padding: '8px 14px' }}>
                {/* TIME group */}
                <div style={{ padding: '6px 0' }}>
                  <div className="text-[10px] font-mono uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>Time</div>
                  <Tabs
                    tabs={PERIODS.map(p => ({ id: p.id, label: p.label }))}
                    activeTab={period}
                    onChange={(id) => handleFilterSelect(() => setPeriod(id))}
                    variant="bar"
                  />
                </div>

                {/* COLOR group (global mode only) */}
                {mapMode === 'global' && (
                  <div style={{ padding: '6px 0', borderTop: '1px solid var(--border-base)' }}>
                    <div className="text-[10px] font-mono uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>Color</div>
                    <Tabs
                      tabs={[
                        { id: 'severity', label: 'Severity' },
                        { id: 'type', label: 'Type' },
                      ]}
                      activeTab={colorBy}
                      onChange={(id) => handleFilterSelect(() => setColorBy(id as 'severity' | 'type'))}
                      variant="bar"
                    />
                  </div>
                )}

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
        </div>
      ) : (
        <div className="absolute top-4 left-4 z-10 flex gap-2 items-center">
          {/* Mode switcher */}
          <div style={{ minWidth: 260 }}>
            <Tabs
              tabs={MAP_MODES.map(m => ({ id: m.id, label: m.label }))}
              activeTab={mapMode}
              onChange={(id) => setMapMode(id as MapMode)}
              variant="bar"
            />
          </div>

          {/* Period selector */}
          <div style={{ minWidth: 200 }}>
            <Tabs
              tabs={PERIODS.map(p => ({ id: p.id, label: p.label }))}
              activeTab={period}
              onChange={setPeriod}
              variant="bar"
            />
          </div>

          {/* Color mode (Global mode only) */}
          {mapMode === 'global' && (
            <div style={{ minWidth: 150 }}>
              <Tabs
                tabs={[
                  { id: 'severity', label: 'Severity' },
                  { id: 'type', label: 'Type' },
                ]}
                activeTab={colorBy}
                onChange={(id) => setColorBy(id as 'severity' | 'type')}
                variant="bar"
              />
            </div>
          )}

          {/* Source filter */}
          <div style={{ minWidth: 240 }}>
            <Tabs
              tabs={SOURCES.map(s => ({ id: s.id, label: s.label }))}
              activeTab={source}
              onChange={setSource}
              variant="bar"
            />
          </div>
        </div>
      )}

      {/* Top-right: Version toggle + Live clock — hidden on mobile to avoid overlap with control bar */}
      <div className="hidden md:flex absolute top-4 right-16 z-10 items-center gap-3">
        <ObservatoryVersionToggle />
        <div className="font-mono text-lg font-bold tabular-nums" style={{ color: 'var(--amber)' }}>{clock}</div>
      </div>

      {/* Mobile: version toggle pinned to top-right corner */}
      <div className="md:hidden absolute top-3 right-3 z-20">
        <ObservatoryVersionToggle />
      </div>

      {/* Legend */}
      {mapMode === 'global' && (
        isMobile ? (
          /* Mobile: horizontal strip below filter rows, top-left */
          <div className="absolute top-[88px] left-4 z-10">
            <Card style={{ borderRadius: 8, padding: '6px 10px' }}>
              <div className="flex flex-row gap-3">
                {colorBy === 'severity' ? (
                  <>
                    <LegendItem color="rgb(200,60,60)" label="Critical" />
                    <LegendItem color="rgb(232,146,60)" label="High" />
                    <LegendItem color="rgb(220,170,50)" label="Medium" />
                    <LegendItem color="rgb(120,160,200)" label="Low" />
                  </>
                ) : (
                  <>
                    <LegendItem color="rgb(200,60,60)" label="Phishing" />
                    <LegendItem color="rgb(251,146,60)" label="Credential" />
                    <LegendItem color="rgb(168,85,247)" label="Malware" />
                    <LegendItem color="rgb(239,68,68)" label="C2" />
                  </>
                )}
              </div>
            </Card>
          </div>
        ) : (
          /* Desktop: vertical legend bottom-left */
          <div className="absolute left-4 bottom-[100px] z-10">
            <Card style={{ borderRadius: 10, padding: 12 }}>
              <div
                className="font-mono text-[9px] uppercase tracking-wider mb-2"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {colorBy === 'severity' ? 'Severity' : 'Threat Type'}
              </div>
              <div className="space-y-1">
                {colorBy === 'severity' ? (
                  <>
                    <LegendItem color="rgb(200,60,60)" label="Critical" />
                    <LegendItem color="rgb(232,146,60)" label="High" />
                    <LegendItem color="rgb(220,170,50)" label="Medium" />
                    <LegendItem color="rgb(120,160,200)" label="Low" />
                  </>
                ) : (
                  <>
                    <LegendItem color="rgb(200,60,60)" label="Phishing" />
                    <LegendItem color="rgb(251,146,60)" label="Credential" />
                    <LegendItem color="rgb(168,85,247)" label="Malware" />
                    <LegendItem color="rgb(239,68,68)" label="C2" />
                    <LegendItem color="rgb(251,113,133)" label="Web Attack" />
                    <LegendItem color="rgb(34,211,238)" label="Spam/Botnet" />
                  </>
                )}
              </div>
            </Card>
          </div>
        )
      )}

      {/* Heatmap legend (bottom-left) */}
      {mapMode === 'heatmap' && (
        <div className={cn('absolute left-4 z-10', isMobile ? 'bottom-[120px]' : 'bottom-[100px]')}>
          <Card variant="active" style={{ borderRadius: 10, padding: 16 }}>
            <div
              className="font-mono text-[9px] uppercase tracking-wider mb-3"
              style={{ color: 'var(--amber)' }}
            >
              Attack Density ({period.toUpperCase()})
            </div>
            <div className="flex items-center gap-3 mb-3">
              <LegendItem color="rgb(0,212,255)" label="Low" />
              <LegendItem color="rgb(251,146,60)" label="Medium" />
              <LegendItem color="rgb(200,60,60)" label="High" />
              <LegendItem color="rgb(200,60,60)" label="Critical" />
            </div>
            <div className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
              {heatmapData.length.toLocaleString()} threat points mapped
            </div>
          </Card>
        </div>
      )}

      {/* Bottom-right: LIVE indicator + refreshing state */}
      <div className={cn('absolute right-4 z-10 flex flex-col items-end gap-1.5', isMobile ? 'bottom-[120px]' : 'bottom-[100px]')}>
        {threatsError && (
          <Card variant="critical" style={{ borderRadius: 10, padding: '6px 12px' }}>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px]" style={{ color: 'var(--sev-critical)' }}>
                Load failed
              </span>
              <button
                onClick={() => refetch()}
                style={{
                  background: 'var(--border-base)',
                  border: '1px solid var(--border-base)',
                  borderRadius: 6,
                  padding: '2px 6px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <RefreshCw className="w-3 h-3" style={{ color: 'var(--text-secondary)' }} />
                <span className="font-mono text-[10px]" style={{ color: 'var(--text-secondary)' }}>Retry</span>
              </button>
            </div>
          </Card>
        )}
        <Card style={{ borderRadius: 10, padding: '6px 12px' }}>
          <div className="flex items-center gap-2">
            {isRefreshing ? (
              <Loader2 className="w-3 h-3 animate-spin" style={{ color: 'var(--amber)' }} />
            ) : (
              <LiveIndicator />
            )}
            <span
              className="font-mono text-[10px] tabular-nums"
              style={{ color: 'var(--text-secondary)' }}
            >
              {threats.length.toLocaleString()} threats
            </span>
          </div>
        </Card>
      </div>

      {/* Event ticker — self-positions with fixed at bottom */}
      <EventTicker />

      {/* Bottom stats bar */}
      {isMobile ? (
        <div
          style={{
            position: 'fixed',
            bottom: 0,
            left: 0,
            right: 0,
            height: 36,
            zIndex: 20,
            background: 'var(--bg-card-deep)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            borderTop: '1px solid var(--border-base)',
            padding: '0 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div className="flex items-center gap-3 flex-shrink-0">
            <span
              className="font-mono uppercase tracking-wider text-[10px]"
              style={{ color: 'var(--text-secondary)' }}
            >
              {mapMode === 'global' ? 'GLOBAL THREAT MAP' : mapMode === 'operations' ? 'OPERATIONS MAP' : 'DENSITY HEATMAP'}
            </span>
          </div>
          <div className="flex items-center gap-3 overflow-x-auto scrollbar-none">
            {stats && (
              <>
                <span
                  className="font-mono text-[10px] font-bold tabular-nums"
                  style={{ color: 'var(--amber)' }}
                >
                  {(stats.threats_mapped ?? 0).toLocaleString()}
                </span>
                <span className="font-mono text-[10px]" style={{ color: 'var(--text-secondary)' }}>THREATS</span>
                <span
                  className="font-mono text-[10px] font-bold tabular-nums"
                  style={{ color: 'var(--amber)' }}
                >
                  {(stats.countries ?? 0).toLocaleString()}
                </span>
                <span className="font-mono text-[10px]" style={{ color: 'var(--text-secondary)' }}>COUNTRIES</span>
              </>
            )}
          </div>
        </div>
      ) : (
        <Card
          variant="elevated"
          style={{
            position: 'absolute',
            bottom: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 20,
            padding: '10px 24px',
            display: 'flex',
            alignItems: 'center',
            gap: 24,
            borderRadius: 14,
          }}
        >
          <span
            className="font-mono text-[9px] uppercase tracking-[0.2em] shrink-0"
            style={{ color: 'var(--text-tertiary)' }}
          >
            {mapMode === 'global' ? 'GLOBAL THREAT MAP' : mapMode === 'operations' ? 'OPERATIONS MAP' : 'DENSITY HEATMAP'}
          </span>
          {stats && (
            <>
              <StatChip value={stats.threats_mapped} label="Threats Mapped" color="var(--amber)" />
              <StatChip value={stats.countries} label="Countries" color="var(--blue)" />
              <StatChip value={stats.active_campaigns} label="Active Campaigns" color="var(--sev-high)" />
              <StatChip value={stats.brands_monitored} label="Brands Monitored" color="var(--green)" />
            </>
          )}
        </Card>
      )}

      {/* ─── Clicked Arc Detail Card ─── */}
      {clickedArc && (
        <Card
          variant="critical"
          style={{
            position: 'absolute',
            zIndex: 30,
            width: 320,
            padding: '14px 16px',
            left: clickedArc.x,
            top: clickedArc.y,
          }}
        >
          <div onClick={e => e.stopPropagation()}>
            <button
              onClick={() => setClickedArc(null)}
              style={{
                position: 'absolute',
                top: 8,
                right: 8,
                padding: 6,
                borderRadius: 6,
                background: 'var(--border-base)',
                border: '1px solid var(--border-base)',
                cursor: 'pointer',
                color: 'var(--text-tertiary)',
              }}
            >
              <X className="w-4 h-4" />
            </button>
            <div className="font-mono text-[11px] font-bold mb-1" style={{ color: 'var(--text-primary)' }}>
              {clickedArc.arc.source_region} {'\u2192'} {clickedArc.arc.brand_name || 'Unknown'}
            </div>
            <div
              style={{
                height: 1,
                background: 'var(--border-base)',
                margin: '8px 0',
              }}
            />
            <div className="space-y-1.5">
              {clickedArc.arc.brand_name && (
                <div className="flex justify-between">
                  <span className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>TARGET</span>
                  <span className="font-mono text-[10px]" style={{ color: 'var(--text-primary)' }}>{clickedArc.arc.brand_name}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>TYPE</span>
                <span className="font-mono text-[10px] capitalize" style={{ color: 'var(--text-primary)' }}>{clickedArc.arc.threat_type?.replace(/_/g, ' ')}</span>
              </div>
              <div className="flex justify-between">
                <span className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>SEVERITY</span>
                <span className="font-mono text-[10px] uppercase" style={{ color: 'var(--text-primary)' }}>{clickedArc.arc.severity}</span>
              </div>
              <div className="flex justify-between">
                <span className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>VOLUME</span>
                <span className="font-mono text-[10px]" style={{ color: 'var(--text-primary)' }}>{clickedArc.arc.volume} attacks</span>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* ─── Clicked Cluster Detail Card ─── */}
      {clickedCluster && (() => {
        const isAccel = clickedCluster.cluster.agent_notes?.includes('ACCELERATING');
        const isPivot = clickedCluster.cluster.agent_notes?.includes('PIVOT');
        const variant: 'active' | 'elevated' | 'critical' =
          isAccel ? 'active' : isPivot ? 'elevated' : 'critical';
        return (
          <Card
            variant={variant}
            style={{
              position: 'absolute',
              zIndex: 30,
              width: 320,
              padding: '14px 16px',
              left: clickedCluster.x,
              top: clickedCluster.y,
            }}
          >
            <div onClick={e => e.stopPropagation()}>
              <button
                onClick={() => setClickedCluster(null)}
                style={{
                  position: 'absolute',
                  top: 8,
                  right: 8,
                  padding: 6,
                  borderRadius: 6,
                  background: 'var(--border-base)',
                  border: '1px solid var(--border-base)',
                  cursor: 'pointer',
                  color: 'var(--text-tertiary)',
                }}
              >
                <X className="w-4 h-4" />
              </button>
              {isAccel && (
                <div style={{ marginBottom: 8 }}>
                  <Badge status="warning" label="Accelerating" size="xs" />
                </div>
              )}
              {isPivot && (
                <div style={{ marginBottom: 8 }}>
                  <Badge status="active" label="Pivot" size="xs" />
                </div>
              )}
              <div className="font-mono text-[11px] font-bold mb-1" style={{ color: 'var(--text-primary)' }}>
                {clickedCluster.cluster.cluster_name || `Cluster ${clickedCluster.cluster.id.slice(0, 8)}`}
              </div>
              <div className="font-mono text-[10px] mb-2" style={{ color: 'var(--text-secondary)' }}>
                {parseJsonArray(clickedCluster.cluster.asns).join(', ')} {'\u00B7'} {parseJsonArray(clickedCluster.cluster.countries).map(countryFlag).join(' ')}
              </div>
              <div
                style={{
                  height: 1,
                  background: 'var(--border-base)',
                  margin: '8px 0',
                }}
              />
              <div className="space-y-1.5">
                <div className="flex justify-between">
                  <span className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>THREATS</span>
                  <span className="font-mono text-[10px] tabular-nums" style={{ color: 'var(--text-primary)' }}>{clickedCluster.cluster.threat_count.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>CONFIDENCE</span>
                  <span className="font-mono text-[10px] tabular-nums" style={{ color: 'var(--text-primary)' }}>{clickedCluster.cluster.confidence_score ?? '—'}</span>
                </div>
              </div>
              {clickedCluster.cluster.agent_notes && (
                <>
                  <div
                    style={{
                      height: 1,
                      background: 'var(--border-base)',
                      margin: '8px 0',
                    }}
                  />
                  <div className="font-mono text-[10px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                    {clickedCluster.cluster.agent_notes}
                  </div>
                </>
              )}
            </div>
          </Card>
        );
      })()}

      {/* ─── Mobile bottom tab bar + expandable panel ─── */}
      {isMobile && (
        <>
          {/* Expanded panel — slides up from above the tab bar */}
          <div
            className={cn(
              'fixed left-0 right-0 z-20 overflow-hidden transition-all duration-300 ease-in-out',
              mobileActiveTab ? 'max-h-64' : 'max-h-0'
            )}
            style={{ bottom: 'calc(36px + 32px + 40px)' /* stats + ticker + tab bar */ }}
          >
            <Card
              variant="elevated"
              style={{
                borderRadius: 0,
                padding: 0,
                overflowY: 'auto',
                maxHeight: 256,
              }}
            >
              <div style={{ padding: '8px 12px' }}>
                {mobileActiveTab === 'brands' && <MobileTopBrandsList period={period} />}
                {mobileActiveTab === 'intel' && <AgentIntelFeed />}
                {mobileActiveTab === 'feed' && <LiveThreatFeed />}
              </div>
            </Card>
          </div>

          {/* Tab bar — fixed above ticker */}
          <div
            style={{
              position: 'fixed',
              left: 0,
              right: 0,
              zIndex: 20,
              bottom: 'calc(36px + 32px)' /* stats + ticker */,
              background: 'var(--bg-card-deep)',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              borderTop: '1px solid var(--border-base)',
              padding: '0 8px',
            }}
          >
            <Tabs
              tabs={[
                { id: 'brands', label: 'Top Brands' },
                { id: 'intel', label: 'Intel' },
                { id: 'feed', label: 'Live Feed' },
              ]}
              activeTab={mobileActiveTab ?? ''}
              onChange={(id) =>
                setMobileActiveTab(
                  mobileActiveTab === id ? null : (id as typeof mobileActiveTab)
                )
              }
              variant="underline"
            />
          </div>
        </>
      )}

      {/* ─── Desktop sidebar backdrop (no longer used on mobile) ─── */}

      {/* ─── Right sidebar panel (desktop only) ─── */}
      {!isMobile && showPanel && mapMode !== 'heatmap' && (
        <div
          className="absolute top-0 right-0 bottom-[84px] z-20 w-80 backdrop-blur-2xl border-l border-white/[0.06] flex flex-col overflow-hidden"
          style={{
            background: 'var(--bg-card-deep)',
            boxShadow: 'var(--card-shadow), inset 1px 0 0 var(--border-base)',
          }}
        >
          <div className="flex-1 overflow-y-auto">
          {/* Mode-aware header */}
          {mapMode === 'global' && (
            <>
              <div className="px-4 py-2 flex items-center gap-2">
                <div className="h-px flex-1 bg-white/[0.08]" />
                <span className="text-[9px] font-mono tracking-[0.2em] text-white/50 uppercase shrink-0">Top Targeted Brands</span>
                <div className="h-px flex-1 bg-white/[0.08]" />
              </div>
              <div className="px-4 pb-3">
                <TopBrandsList period={period} />
              </div>
              <div className="h-px mx-4 my-2" style={{ background: "linear-gradient(to right, transparent, var(--border-strong) 50%, transparent)" }} />
              <div className="px-4 py-2 flex items-center gap-2">
                <div className="h-px flex-1 bg-white/[0.08]" />
                <span className="text-[9px] font-mono tracking-[0.2em] text-white/50 uppercase shrink-0">Hosting Providers</span>
                <div className="h-px flex-1 bg-white/[0.08]" />
              </div>
              <div className="px-4 pb-3">
                <TopProvidersList period={period} />
              </div>
              <div className="h-px mx-4 my-2" style={{ background: "linear-gradient(to right, transparent, var(--border-strong) 50%, transparent)" }} />
              <div className="px-4 py-2 flex items-center gap-2">
                <div className="h-px flex-1 bg-white/[0.08]" />
                <span className="text-[9px] font-mono tracking-[0.2em] text-white/50 uppercase shrink-0">Agent Intelligence</span>
                <div className="h-px flex-1 bg-white/[0.08]" />
              </div>
              <div className="px-4 pb-3">
                <AgentAttribution agent="Observer + Sentinel" />
                <AgentIntelFeed />
              </div>
              <div className="h-px mx-4 my-2" style={{ background: "linear-gradient(to right, transparent, var(--border-strong) 50%, transparent)" }} />
              <div className="px-4 py-2 flex items-center gap-2">
                <div className="h-px flex-1 bg-white/[0.08]" />
                <span className="text-[9px] font-mono tracking-[0.2em] text-white/50 uppercase shrink-0">Active Operations</span>
                <div className="h-px flex-1 bg-white/[0.08]" />
              </div>
              <div className="px-4 pb-3">
                <ActiveOperationsPanel />
              </div>
              <div className="h-px mx-4 my-2" style={{ background: "linear-gradient(to right, transparent, var(--border-strong) 50%, transparent)" }} />
              <div className="px-4 py-2 flex items-center gap-2">
                <div className="h-px flex-1 bg-white/[0.08]" />
                <span className="text-[9px] font-mono tracking-[0.2em] text-white/50 uppercase shrink-0">Live Feed</span>
                <div className="h-px flex-1 bg-white/[0.08]" />
              </div>
              <div className="px-4 pb-3">
                <LiveThreatFeed />
              </div>
            </>
          )}

          {mapMode === 'operations' && (
            <>
              <div className="px-4 py-2 flex items-center gap-2">
                <div className="h-px flex-1 bg-white/[0.08]" />
                <span className="text-[9px] font-mono tracking-[0.2em] text-white/50 uppercase shrink-0">Active Operations</span>
                <div className="h-px flex-1 bg-white/[0.08]" />
              </div>
              <div className="px-4 pb-3">
                <OperationsClusterList
                  operations={operations}
                  onSelect={(op) => {
                    const countries = parseJsonArray(op.countries);
                    const pos = countries.length > 0 ? countries[0] : '';
                    setClickedCluster({ cluster: op, x: window.innerWidth / 2 - 160, y: 100 });
                  }}
                />
              </div>
            </>
          )}
          </div>
        </div>
      )}

      {/* Panel toggle button (desktop only) */}
      {!isMobile && mapMode !== 'heatmap' && (
        <button
          onClick={() => setShowPanel(!showPanel)}
          className="absolute top-1/2 z-30 transform -translate-y-1/2"
          style={{
            ...(showPanel ? { right: '320px' } : { right: 0 }),
            background: 'var(--bg-card)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border: '1px solid var(--border-base)',
            borderRadius: '8px 0 0 8px',
            padding: '12px 4px',
            color: 'var(--text-tertiary)',
            cursor: 'pointer',
          }}
        >
          {showPanel ? '\u203A' : '\u2039'}
        </button>
      )}
    </div>
  );
}

// ─── Supporting components ───────────────────────────────────

function StatChip({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <div>
        <div className="font-mono text-xl font-bold tabular-nums" style={{ color }}>{(value ?? 0).toLocaleString()}</div>
        <div className="font-mono text-[11px] uppercase" style={{ color: 'var(--text-tertiary)' }}>{label}</div>
      </div>
    </div>
  );
}

function LegendItem({ color, label, compact }: { color: string; label: string; compact?: boolean }) {
  return (
    <div className={cn('flex items-center', compact ? 'gap-1' : 'gap-2')}>
      <span className={cn('rounded-full', compact ? 'w-2 h-2' : 'w-2.5 h-2.5')} style={{ backgroundColor: color }} />
      <span
        className={cn('font-mono', compact ? 'text-[10px]' : 'text-[10px]')}
        style={{ color: 'var(--text-secondary)' }}
      >
        {label}
      </span>
    </div>
  );
}

const OperationsClusterList = memo(function OperationsClusterList({ operations, onSelect }: { operations: Operation[]; onSelect: (op: Operation) => void }) {
  if (operations.length === 0) {
    return (
      <EmptyState
        icon={<Activity />}
        title="No active operations"
        subtitle="Nexus will surface correlated attack clusters as threat data accumulates"
        variant="scanning"
        compact
      />
    );
  }

  return (
    <div className="space-y-2">
      {operations.map(op => {
        const countries = parseJsonArray(op.countries);
        const isAccelerating = op.agent_notes?.includes('ACCELERATING');
        const isPivot = op.agent_notes?.includes('PIVOT');
        return (
          <button
            key={op.id}
            onClick={() => onSelect(op)}
            className="w-full text-left"
            style={{
              background: 'var(--bg-card)',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              border: '1px solid var(--border-base)',
              borderRadius: 10,
              padding: 10,
              cursor: 'pointer',
              transition: 'var(--transition-fast)',
            }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[11px] truncate" style={{ color: 'var(--text-primary)' }}>
                {op.cluster_name || `Cluster ${op.id.slice(0, 8)}`}
              </span>
              {isAccelerating && <Badge status="warning" label="Accel" size="xs" />}
              {isPivot && <Badge status="active" label="Pivot" size="xs" />}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <span className="font-mono text-[10px] tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
                {op.threat_count.toLocaleString()} threats
              </span>
              {countries.length > 0 && (
                <span className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                  {countries.map(countryFlag).join(' ')}
                </span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
});

const TopBrandsList = memo(function TopBrandsList({ period }: { period: string }) {
  const { data: brands = [] } = useBrands({ view: 'top', limit: 10, timeRange: period });

  return (
    <div className="space-y-2">
      {brands.map((brand, i) => (
        <div key={brand.id} className="flex items-center gap-3 py-1">
          <span className="font-mono text-[10px] w-4" style={{ color: 'var(--text-tertiary)' }}>{i + 1}</span>
          <img
            src={`https://www.google.com/s2/favicons?domain=${brand.canonical_domain}&sz=32`}
            alt=""
            className="w-4 h-4"
          />
          <span className="text-xs flex-1 truncate" style={{ color: 'var(--text-primary)' }}>{brand.name}</span>
          <div className="flex items-center gap-2 shrink-0">
            <BIMIGradeBadge grade={brand.email_security_grade} size="sm" />
            <span
              className="font-mono text-xs font-bold tabular-nums"
              style={{
                color:
                  brand.threat_count >= 100 ? 'var(--sev-critical)' :
                  brand.threat_count >= 20 ? 'var(--amber)' :
                  'var(--text-primary)',
              }}
            >
              {brand.threat_count}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
});

const MobileTopBrandsList = memo(function MobileTopBrandsList({ period }: { period: string }) {
  const { data: brands = [] } = useBrands({ view: 'top', limit: 8, timeRange: period });

  if (brands.length === 0) {
    return <div className="text-[10px] font-mono py-2" style={{ color: 'var(--text-muted)' }}>Loading brands...</div>;
  }

  return (
    <div className="space-y-1">
      {brands.map((brand, i) => (
        <div key={brand.id} className="flex items-center gap-2 py-1">
          <span className="font-mono text-[10px] w-4 flex-shrink-0" style={{ color: 'var(--text-tertiary)' }}>{i + 1}</span>
          <img
            src={`https://www.google.com/s2/favicons?domain=${brand.canonical_domain}&sz=32`}
            alt=""
            className="w-3.5 h-3.5 flex-shrink-0"
          />
          <span className="font-mono text-[11px] flex-1 truncate" style={{ color: 'var(--text-primary)' }}>{brand.name}</span>
          <span
            className="font-mono text-[11px] font-bold tabular-nums flex-shrink-0"
            style={{
              color:
                brand.threat_count >= 100 ? 'var(--sev-critical)' :
                brand.threat_count >= 20 ? 'var(--amber)' :
                'var(--text-secondary)',
            }}
          >
            {brand.threat_count}
          </span>
        </div>
      ))}
    </div>
  );
});

const TopProvidersList = memo(function TopProvidersList({ period }: { period: string }) {
  const { data } = useProviders({ view: 'worst', limit: 5, timeRange: period });
  const providers = data || [];

  return (
    <div className="space-y-2">
      {providers.map(provider => (
        <div key={provider.id} className="py-1">
          <div className="flex items-center justify-between">
            <span className="text-xs truncate" style={{ color: 'var(--text-primary)' }}>{provider.name}</span>
            <span className="font-mono text-xs font-bold tabular-nums" style={{ color: 'var(--amber)' }}>{provider.active_threat_count}</span>
          </div>
          <div className="font-mono text-[9px]" style={{ color: 'var(--text-tertiary)' }}>{provider.asn}</div>
          {provider.trend_7d != null && provider.trend_7d !== 0 && (
            <span
              className="font-mono text-[9px]"
              style={{
                color: (provider.trend_7d ?? 0) > 0 ? 'var(--amber)' : 'var(--green)',
              }}
            >
              {(provider.trend_7d ?? 0) > 0 ? '+' : ''}{(provider.trend_7d ?? 0).toFixed(1)}%
            </span>
          )}
        </div>
      ))}
    </div>
  );
});

const AgentIntelFeed = memo(function AgentIntelFeed() {
  const { data: agents } = useAgents();
  const recentOutputs = useMemo(
    () => (agents || [])
      .filter(a => a.last_output_at)
      .sort((a, b) => new Date(b.last_output_at!).getTime() - new Date(a.last_output_at!).getTime())
      .slice(0, 5),
    [agents],
  );

  return (
    <div className="space-y-3">
      {recentOutputs.map(agent => (
        <div key={agent.agent_id} className="text-xs">
          <div className="flex items-center justify-between mb-1">
            <span className="font-mono font-bold uppercase" style={{ color: agent.color }}>
              {agent.display_name}
            </span>
            <Badge status={agent.status === 'active' ? 'active' : 'inactive'}>
              {agent.last_run_status || 'idle'}
            </Badge>
          </div>
          <div style={{ color: 'var(--text-tertiary)' }}>
            {agent.outputs_24h} outputs &middot; {relativeTime(agent.last_output_at)}
          </div>
        </div>
      ))}
    </div>
  );
});

const ActiveOperationsPanel = memo(function ActiveOperationsPanel() {
  const { data: operations = [] } = useQuery({
    queryKey: ['observatory-operations'],
    queryFn: async () => {
      const res = await api.get<Operation[]>('/api/observatory/operations?status=active&limit=5');
      return res.data ?? [];
    },
    refetchInterval: 60_000,
  });

  if (operations.length === 0) {
    return (
      <EmptyState
        icon={<Activity />}
        title="No active operations"
        subtitle="Operations will appear as the pipeline processes new threats"
        variant="scanning"
        compact
      />
    );
  }

  return (
    <div className="space-y-2">
      {operations.slice(0, 5).map(op => (
        <div key={op.id} className="py-1">
          <div className="flex items-center justify-between">
            <span className="text-xs truncate flex-1 mr-2" style={{ color: 'var(--text-primary)' }}>
              {op.cluster_name || `Cluster ${op.id.slice(0, 8)}`}
            </span>
            <span className="font-mono text-[10px] font-bold tabular-nums" style={{ color: 'var(--amber)' }}>{op.threat_count}</span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            {op.status === 'active' && (op.confidence_score ?? 0) >= 70 && (
              <Badge status="warning" label="Accelerating" size="xs" />
            )}
            {op.agent_notes?.toLowerCase().includes('pivot') && (
              <Badge status="active" label="Pivot" size="xs" />
            )}
            {op.countries && (
              <span className="font-mono text-[9px] truncate" style={{ color: 'var(--text-tertiary)' }}>
                {(() => { try { return (JSON.parse(op.countries) as string[]).slice(0, 3).join(', '); } catch { return ''; } })()}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
});

interface LiveThreatEntry {
  id: string;
  threat_type: string;
  severity: string | null;
  country_code: string | null;
  created_at: string;
  malicious_domain: string | null;
}

const SEVERITY_DOT_COLORS: Record<string, string> = {
  critical: 'dot-pulse-red',
  high: 'dot-pulse-amber',
  medium: 'bg-yellow-400',
  low: 'dot-pulse-teal',
};

const LiveThreatFeed = memo(function LiveThreatFeed() {
  const { data: entries = [] } = useQuery({
    queryKey: ['observatory-live-feed'],
    queryFn: async () => {
      const res = await api.get<LiveThreatEntry[]>('/api/observatory/live?limit=8');
      return res.data ?? [];
    },
    refetchInterval: 15_000,
  });

  if (entries.length === 0) {
    return <div className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>Waiting for threats...</div>;
  }

  return (
    <div className="space-y-1.5">
      {entries.slice(0, 8).map(entry => (
        <div key={entry.id} className="flex items-center gap-2 py-0.5 animate-fade-in">
          <span className={cn(
            'w-1.5 h-1.5 rounded-full flex-shrink-0',
            SEVERITY_DOT_COLORS[entry.severity?.toLowerCase() ?? ''] ?? 'bg-blue-400'
          )} />
          <span className="font-mono text-[10px] truncate flex-1" style={{ color: 'var(--text-primary)' }}>
            {entry.threat_type?.replace(/_/g, ' ')}
          </span>
          {entry.country_code && (
            <span className="font-mono text-[9px]" style={{ color: 'var(--text-secondary)' }}>{entry.country_code}</span>
          )}
          <span className="font-mono text-[9px] flex-shrink-0" style={{ color: 'var(--text-tertiary)' }}>
            {relativeTime(entry.created_at)}
          </span>
        </div>
      ))}
    </div>
  );
});

