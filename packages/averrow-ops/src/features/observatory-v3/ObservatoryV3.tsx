/**
 * Observatory — GPU-driven particle visualization.
 *
 * The sole Observatory surface as of #35 Phase D (v2 retired). Uses
 * TripsLayer for animation, overlaid MapboxOverlay mode, enhanced side
 * panel widgets.
 *
 * View state (period, source, mode, colour-by, layer toggles, selected
 * node/arc) lives in the URL — see lib/url-state.ts — so views are shareable
 * and survive reload. Each map mode fetches only the data it renders
 * (lib/mode-data.ts).
 */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  useObservatoryThreats, useObservatoryStats, useObservatoryArcs, useObservatoryHeatmap, useRefreshObservatory,
} from '@/hooks/useObservatory';
import type { ThreatPoint, ArcData, HeatmapPoint } from '@/hooks/useObservatory';
import { ThreatMapV3 } from './components/ThreatMapV3';
import { SidePanel } from './components/SidePanel';
import { BottomSheet } from '@/components/BottomSheet';
import { Card, Tabs, Button } from '@/design-system/components';
import { ObservatoryLoadError } from './components/ObservatoryLoadError';
import { EventTicker } from '@/components/observatory/EventTicker';
import { cn } from '@/lib/cn';
import { RefreshCw, PanelRightOpen, PanelRightClose, AlertTriangle, ChevronDown } from 'lucide-react';
import { ObservatoryOverlay } from '@/components/observatory/ObservatoryOverlay';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useBotTraffic } from '@/hooks/useBotTraffic';
import { BotDensityLegend } from './components/BotDensityLegend';
import { MapLegend } from './components/MapLegend';
import { buildBotDensityPoints, botDensityDomain, resolveGlobalAvg } from './lib/bot-density';
import {
  useObservatoryUrlState, nodeKey, arcKey,
  PERIOD_IDS, SOURCE_IDS, MAP_MODE_IDS, COLOR_BY_IDS, LAYER_IDS,
  type MapMode, type Period, type Source, type ColorBy, type LayerId,
} from './lib/url-state';
import { dataNeeds, relevantFailures } from './lib/mode-data';
import { clearOverlayKind } from './lib/overlay-visibility';
import { resolveSelection, type MapSelection } from './lib/selection';
import { usePrefersReducedMotion } from './lib/use-motion';

const PERIOD_LABELS: Record<Period, string> = { '24h': '24H', '7d': '7D', '30d': '30D', '90d': '90D' };
const PERIODS = PERIOD_IDS.map(id => ({ id, label: PERIOD_LABELS[id] }));

const MODE_LABELS: Record<MapMode, string> = { global: 'GLOBAL', heatmap: 'HEATMAP', bot_density: 'BOT DENSITY' };
const MAP_MODES = MAP_MODE_IDS.map(id => ({ id, label: MODE_LABELS[id] }));

const SOURCE_LABELS: Record<Source, string> = { all: 'All Sources', feeds: 'Feeds', spam_trap: 'Spam Trap' };
const SOURCES = SOURCE_IDS.map(id => ({ id, label: SOURCE_LABELS[id] }));

const COLOR_BY_LABELS: Record<ColorBy, string> = { severity: 'Severity', type: 'Type' };
const COLOR_BY_TABS = COLOR_BY_IDS.map(id => ({ id, label: COLOR_BY_LABELS[id] }));

const PANEL_OPEN_MIN_WIDTH = 1280;
const LAYER_LABELS: Record<LayerId, string> = { nodes: 'Nodes', particles: 'Particles', beams: 'Beams' };

// Stable empties: a fresh `[]` per render would defeat the map's identity-based layer memoisation.
const EMPTY_THREATS: ThreatPoint[] = [];
const EMPTY_ARCS: ArcData[] = [];
const EMPTY_HEAT: HeatmapPoint[] = [];

// Explicit stacking order for this view's overlay chrome — replaces raw
// z-10/20/30/40 Tailwind utilities so the layering intent is documented in
// one place instead of scattered magic numbers. (ThreatMapV3's own hover
// tooltip and detail card render above all of these, inside that component.)
const Z_CHROME = 10;   // top control stack, stats bar, ticker, layer toggles
const Z_PANEL = 20;    // mobile Intel FAB (opens the SidePanel drawer)
const Z_TOGGLE = 30;   // desktop panel toggle + load-error banner

function RefreshButton({ onClick, busy, className }: { onClick: () => void; busy: boolean; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Refresh Observatory data"
      aria-busy={busy}
      className={cn('ds-focusable inline-flex items-center justify-center p-1.5 min-w-[28px] min-h-[28px] max-[899px]:min-w-[44px] max-[899px]:min-h-[44px] rounded-md transition-colors motion-reduce:transition-none', className)}
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-base)',
        color: busy ? 'var(--amber-text)' : 'var(--text-muted)',
        cursor: 'pointer',
      }}
    >
      <RefreshCw size={14} className={busy ? 'animate-spin motion-reduce:animate-none' : ''} />
    </button>
  );
}

/**
 * Nodes / Particles / Beams toggles. Shared by the desktop bottom-left overlay and
 * the mobile filter drawer. Under reduced motion the particle layer is paused by
 * the map regardless of the URL layer state, so the toggle is shown disabled with
 * a hint (aria-disabled, not `disabled`, so the hint stays reachable by keyboard)
 * and never rewrites the URL state.
 */
function LayerToggleGroup({
  layers, reducedMotion, onToggle, touch,
}: {
  layers: Record<LayerId, boolean>;
  reducedMotion: boolean;
  onToggle: (id: LayerId, next: boolean) => void;
  touch?: boolean;
}) {
  return (
    <div role="group" aria-label="Map layers" className="flex gap-2 flex-wrap">
      {LAYER_IDS.map(id => {
        const active = layers[id];
        const paused = id === 'particles' && reducedMotion;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={active}
            aria-disabled={paused || undefined}
            title={paused ? 'Paused: reduced motion' : undefined}
            onClick={() => { if (!paused) onToggle(id, !active); }}
            className={cn(
              'ds-focusable font-mono text-[10px] px-2.5 py-1.5 rounded-md uppercase tracking-wider transition-all motion-reduce:transition-none',
              touch ? 'min-h-[44px] flex-1' : 'min-h-[24px]',
            )}
            style={{
              background: active && !paused ? 'color-mix(in srgb, var(--amber) 15%, transparent)' : 'var(--bg-card)',
              border: `1px solid ${active && !paused ? 'var(--amber-border)' : 'var(--border-base)'}`,
              color: paused ? 'var(--text-muted)' : active ? 'var(--amber-text)' : 'var(--text-muted)',
              opacity: paused ? 0.55 : 1,
              backdropFilter: 'blur(12px)',
              cursor: paused ? 'not-allowed' : 'pointer',
            }}
          >
            {LAYER_LABELS[id]}
            {paused && <span className="sr-only"> (Paused: reduced motion)</span>}
          </button>
        );
      })}
    </div>
  );
}

export function ObservatoryV3() {
  const { isMobile, width: viewportWidth } = useBreakpoint();
  const reducedMotion = usePrefersReducedMotion();
  const { state, update } = useObservatoryUrlState();
  const { period, source, mode: mapMode, colorBy, layers } = state;
  const showNodes = layers.nodes;
  const showParticles = layers.particles;
  const showBeams = layers.beams;

  // The docked panel is 320px: only start open where the map keeps a usable width beside
  // the filter card (>= 1280). Narrower desktops start closed; the toggle opens it.
  const [showPanel, setShowPanel] = useState(() => viewportWidth >= PANEL_OPEN_MIN_WIDTH);
  const [mapFatal, setMapFatal] = useState(false);
  // C1 — mobile-only: the 3 control rows (mode/period/source) collapse
  // behind a single summary toggle so they don't crowd the map.
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

  // If the viewport crosses back to desktop while the mobile filter
  // panel/drawer is open, don't let it silently spring back open.
  useEffect(() => {
    if (!isMobile) {
      setFiltersExpanded(false);
      setShowMobilePanel(false);
    }
  }, [isMobile]);

  const setPeriod = useCallback((id: string) => update({ period: id as Period }), [update]);
  const setSource = useCallback((id: string) => update({ source: id as Source }), [update]);
  const setMapMode = useCallback((id: string) => update({ mode: id as MapMode }), [update]);
  const setColorBy = useCallback((id: string) => update({ colorBy: id as ColorBy }), [update]);

  // ─── Data — each query is enabled only for the modes that render it ──
  const needs = useMemo(() => dataNeeds(mapMode, layers), [mapMode, layers]);
  const threatsQ = useObservatoryThreats({ period, source, enabled: needs.nodes });
  const statsQ = useObservatoryStats({ period, source, enabled: needs.stats });
  const arcsQ = useObservatoryArcs({ period, source, enabled: needs.arcs });
  const heatmapQ = useObservatoryHeatmap({ period, source, enabled: needs.heatmap });
  const threats = threatsQ.data ?? EMPTY_THREATS;
  const arcsResolved = arcsQ.data ?? EMPTY_ARCS;
  const heatmapData = heatmapQ.data ?? EMPTY_HEAT;
  const stats = statsQ.data;

  // Bot density mode: fetched only while that mode is active (days=7).
  const isBotMode = needs.bot;
  const { data: botData, isLoading: botLoading, error: botError, refetch: refetchBot } = useBotTraffic(7, { enabled: isBotMode });
  const botPoints = useMemo(() => buildBotDensityPoints(botData?.bot_density), [botData?.bot_density]);
  const botDomain = useMemo(() => botDensityDomain(botPoints), [botPoints]);
  const botGlobalAvg = resolveGlobalAvg(botData);
  const botAsOf = botData?.as_of?.bot_density ?? null;

  // The SidePanel (and its toggle / Intel drawer) only exists in the global view.
  const hasSidePanel = mapMode === 'global';

  // Only failures from queries the current mode actually uses raise the banner.
  const failures = relevantFailures(needs, {
    nodes: threatsQ.error, arcs: arcsQ.error, heatmap: heatmapQ.error, stats: statsQ.error,
  });
  const loadError = failures.length > 0;
  const retryFailed = useCallback(() => {
    if (failures.includes('nodes')) void threatsQ.refetch();
    if (failures.includes('stats')) void statsQ.refetch();
    if (failures.includes('arcs')) void arcsQ.refetch();
    if (failures.includes('heatmap')) void heatmapQ.refetch();
  }, [failures, threatsQ, statsQ, arcsQ, heatmapQ]);

  // "Updating" = showing the previous period/source's data while the new one loads.
  const activeQueries = [
    needs.nodes ? threatsQ : null, needs.stats ? statsQ : null, needs.arcs ? arcsQ : null, needs.heatmap ? heatmapQ : null,
  ].filter((q): q is typeof threatsQ => q !== null);
  const isUpdating = activeQueries.some(q => q.isUpdating);
  const isInitialLoading = activeQueries.some(q => q.isLoading);
  const isFetching = activeQueries.some(q => q.isFetching) || (isBotMode && botLoading);

  // Refresh: invalidate every observatory query + the side panel's widgets.
  const refreshAll = useRefreshObservatory();
  const handleRefresh = useCallback(() => {
    void refreshAll();
    if (isBotMode) void refetchBot();
  }, [refreshAll, isBotMode, refetchBot]);

  // ─── Selection (URL-backed) ──
  const selection = useMemo(
    () => (mapMode === 'global' ? resolveSelection(state.node, state.arc, threats, arcsResolved) : null),
    [mapMode, state.node, state.arc, threats, arcsResolved],
  );
  const handleSelect = useCallback((sel: MapSelection | null) => {
    update({
      node: sel?.kind === 'node' ? nodeKey(sel.node) : null,
      arc: sel?.kind === 'arc' ? arcKey(sel.arc) : null,
    });
  }, [update]);

  // Keyboard / SR path to node selection: the side panel's Top Threat Origins rows.
  const handleSelectNodeFromPanel = useCallback((node: ThreatPoint) => {
    handleSelect({ kind: 'node', node });
    setShowMobilePanel(false);
  }, [handleSelect]);

  // A shared link may point at a node/arc that no longer exists in the fresh
  // data: once the relevant query has settled, drop the dead key from the URL.
  const nodesSettled = !threatsQ.isFetching && threatsQ.data !== undefined;
  const arcsSettled = !arcsQ.isFetching && arcsQ.data !== undefined;
  useEffect(() => {
    if (selection) return;
    if (state.node && nodesSettled) update({ node: null });
    else if (state.arc && arcsSettled && nodesSettled) update({ arc: null });
  }, [selection, state.node, state.arc, nodesSettled, arcsSettled, update]);

  // "Threat Landscape Clear" — only when verified for THIS view.
  const overlayKind = mapFatal ? null : clearOverlayKind({
    mode: mapMode,
    nodesReady: needs.nodes && threatsQ.data !== undefined && !threatsQ.error && !threatsQ.isUpdating,
    nodeCount: threats.length,
    stats: stats && !statsQ.error && !statsQ.isUpdating
      ? { threats_mapped: stats.threats_mapped, threats_total: stats.threats_total }
      : null,
  });

  const periodLabel = PERIOD_LABELS[period];
  // While the new period loads, the numbers still belong to the previous one: keep
  // labelling them with it (the "Updating to X" pill announces the switch).
  const settledPeriod = useRef(period);
  if (!isUpdating) settledPeriod.current = period;
  const footerPeriodLabel = PERIOD_LABELS[isUpdating ? settledPeriod.current : period];
  const panelInset = !isMobile && showPanel && hasSidePanel ? 320 : 0;

  // Fills the shell outlet (.v4-page--fill is a flex column) — no vh math, so
  // it tracks the real topbar + safe-area + platform-alert-banner height.
  return (
    <div className="relative flex-1 min-h-0 overflow-hidden">
      {/* Full-screen map — bottom inset reserves the stats bar + ticker
          band below (desktop: 36 + 40 = 76; mobile: 36 + 72 = 108). */}
      <div
        className={cn('absolute inset-0', isMobile ? 'bottom-[108px]' : 'bottom-[76px]')}
        aria-busy={isInitialLoading || isUpdating}
      >
        <ThreatMapV3
          threats={threats}
          arcs={arcsResolved}
          showBeams={showBeams}
          showParticles={showParticles}
          showNodes={showNodes}
          colorBy={colorBy}
          mapMode={mapMode}
          period={period}
          heatmapData={heatmapData}
          botDensity={botPoints}
          botGlobalAvg={botGlobalAvg}
          controlRightInset={panelInset}
          selection={selection}
          onSelect={handleSelect}
          onFatalChange={setMapFatal}
        />
        {overlayKind && (
          <ObservatoryOverlay
            kind={overlayKind}
            totalThreats={stats?.threats_total ?? 0}
            timeWindow={periodLabel}
            sourceLabel={source === 'all' ? null : SOURCE_LABELS[source]}
          />
        )}
      </div>

      {/* Subtle loading / updating pill over the map (no skeleton). */}
      {!isBotMode && (isInitialLoading || isUpdating) && (
        <div
          role="status"
          className="absolute left-1/2 -translate-x-1/2 px-3 py-1 rounded-full font-mono text-[10px] uppercase tracking-wider pointer-events-none"
          style={{
            top: isMobile ? 60 : 14,
            zIndex: Z_CHROME,
            background: 'var(--bg-card-deep)',
            border: '1px solid var(--border-base)',
            color: 'var(--amber-text)',
          }}
        >
          {isUpdating ? `Updating to ${periodLabel}…` : 'Loading…'}
        </div>
      )}

      {/* Bot density: loading / error / empty states over the map */}
      {isBotMode && (botLoading || botError || (botData && botPoints.length === 0)) && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ zIndex: Z_CHROME }}>
          <Card variant="elevated" padding="16px 24px" className="text-center pointer-events-auto" style={{ maxWidth: 280 }}>
            {botLoading ? (
              <div role="status" className="font-mono text-xs" style={{ color: 'var(--text-tertiary)' }}>Loading bot density&hellip;</div>
            ) : botError ? (
              <div role="alert">
                <div className="flex items-center justify-center gap-2 font-mono text-xs" style={{ color: 'var(--sev-critical-text)' }}>
                  <AlertTriangle size={13} /> Bot density failed to load
                </div>
                <div className="mt-2">
                  <Button variant="danger" size="sm" onClick={() => refetchBot()} icon={<RefreshCw size={11} />}>Retry</Button>
                </div>
              </div>
            ) : (
              <div role="status" className="font-mono text-xs" style={{ color: 'var(--text-tertiary)' }}>No bot-density data yet</div>
            )}
          </Card>
        </div>
      )}

      {/* ─── Top controls ─────────────────────────────────────── */}
      {isMobile ? (
        /* R10 mobile chrome (C1): fold Mode + Period + Source behind a
           single collapsible summary toggle so 3 stacked rows don't sit
           on top of the map. Refresh rides in-flow beside the summary
           toggle (no absolute-position overlap possible at any width). */
        <div className="absolute top-3 left-0 right-0 flex flex-col gap-1.5 px-4" style={{ zIndex: Z_CHROME }}>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setFiltersExpanded(prev => !prev)}
              aria-expanded={filtersExpanded}
              aria-controls="observatory-mobile-filters"
              aria-label="Map filters"
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
              }}
            >
              <span className="text-xs font-mono truncate">
                <span style={{ color: 'var(--amber-text)' }}>{MODE_LABELS[mapMode]}</span>
                {!isBotMode && (
                  <>
                    <span style={{ color: 'var(--text-tertiary)' }}> · </span>
                    <span style={{ color: 'var(--amber-text)' }}>{periodLabel}</span>
                    <span style={{ color: 'var(--text-tertiary)' }}> · </span>
                    <span style={{ color: 'var(--amber-text)' }}>{SOURCE_LABELS[source]}</span>
                  </>
                )}
              </span>
              <ChevronDown
                className={cn('w-3.5 h-3.5 transition-transform duration-300 motion-reduce:transition-none shrink-0', filtersExpanded && 'rotate-180')}
                style={{ color: 'var(--text-tertiary)' }}
              />
            </button>
            <RefreshButton onClick={handleRefresh} busy={isFetching} className="shrink-0" />
          </div>

          <div
            id="observatory-mobile-filters"
            // Collapsed = out of the tab order and the a11y tree (`inert`, not typed in React 18).
            {...(filtersExpanded ? {} : ({ inert: '' } as Record<string, string>))}
            className={cn(
              'overflow-hidden transition-all duration-300 ease-in-out motion-reduce:transition-none',
              filtersExpanded ? 'max-h-[560px] opacity-100' : 'max-h-0 opacity-0 invisible',
            )}
          >
            <Card variant="elevated" style={{ marginTop: 4, padding: '8px 14px' }}>
              {/* VIEW group (map mode) */}
              <div style={{ padding: '6px 0' }}>
                <div className="text-[10px] font-mono uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>View</div>
                <Tabs
                  tabs={MAP_MODES}
                  activeTab={mapMode}
                  onChange={(id) => handleFilterSelect(() => setMapMode(id))}
                  variant="bar"
                />
              </div>

              {isBotMode && (
                <div className="text-[11px] font-mono" style={{ padding: '6px 0', borderTop: '1px solid var(--border-base)', color: 'var(--text-tertiary)' }}>
                  Period, source and colour filters don&apos;t apply to bot density (daily Cloudflare Radar data).
                </div>
              )}
              {!isBotMode && (<>
              {/* TIME group */}
              <div style={{ padding: '6px 0', borderTop: '1px solid var(--border-base)' }}>
                <div className="text-[10px] font-mono uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>Time</div>
                <Tabs
                  tabs={PERIODS}
                  activeTab={period}
                  onChange={(id) => handleFilterSelect(() => setPeriod(id))}
                  variant="bar"
                />
              </div>

              {/* COLOR group (global map only — the heatmap ignores it) */}
              {mapMode === 'global' && (
                <div style={{ padding: '6px 0', borderTop: '1px solid var(--border-base)' }}>
                  <div className="text-[10px] font-mono uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>Color</div>
                  <Tabs
                    tabs={COLOR_BY_TABS}
                    activeTab={colorBy}
                    onChange={(id) => handleFilterSelect(() => setColorBy(id))}
                    variant="bar"
                  />
                </div>
              )}

              {/* SOURCE group */}
              <div style={{ padding: '6px 0', borderTop: '1px solid var(--border-base)' }}>
                <div className="text-[10px] font-mono uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>Source</div>
                <Tabs
                  tabs={SOURCES}
                  activeTab={source}
                  onChange={(id) => handleFilterSelect(() => setSource(id))}
                  variant="bar"
                />
              </div>
              </>)}

              {/* LAYERS group (global map only — below 900px the overlay toggles are not rendered) */}
              {mapMode === 'global' && (
                <div style={{ padding: '6px 0', borderTop: '1px solid var(--border-base)' }}>
                  <div className="text-[10px] font-mono uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>Layers</div>
                  <LayerToggleGroup
                    layers={layers}
                    reducedMotion={reducedMotion}
                    onToggle={(id, next) => update({ layers: { [id]: next } })}
                    touch
                  />
                </div>
              )}
            </Card>
          </div>
        </div>
      ) : (
        <Card
          variant="base"
          padding="10px"
          className="flex flex-col gap-1.5"
          style={{ position: 'absolute', top: 12, left: 16, zIndex: Z_CHROME }}
        >
          {/* Mode tabs */}
          <Tabs tabs={MAP_MODES} activeTab={mapMode} onChange={setMapMode} variant="bar" />
          {isBotMode && (
            <div className="font-mono text-[10px] max-w-[220px]" style={{ color: 'var(--text-tertiary)' }}>
              Period, source and colour filters don&apos;t apply &mdash; daily Cloudflare Radar data.
            </div>
          )}
          {/* Period + color-by row */}
          {!isBotMode && (
            <div className="flex items-center gap-2">
              <Tabs tabs={PERIODS} activeTab={period} onChange={setPeriod} variant="bar" />
              {mapMode === 'global' && (
                <Tabs tabs={COLOR_BY_TABS} activeTab={colorBy} onChange={setColorBy} variant="bar" />
              )}
            </div>
          )}
          {/* Source filter row — mirrors v2 Observatory.tsx SOURCES tabs */}
          {!isBotMode && <Tabs tabs={SOURCES} activeTab={source} onChange={setSource} variant="bar" />}
        </Card>
      )}

      {/* ─── Top-right: Refresh (desktop) ──────────────────────────
          The page-level LIVE badge lives in the shell top bar (ShellV4), so it is not
          repeated here. Mobile gets Refresh in-flow next to the summary toggle. */}
      {!isMobile && (
        <div
          className="absolute top-3 flex items-center gap-2"
          style={{ right: showPanel && hasSidePanel ? 336 : 16, zIndex: Z_CHROME }}
        >
          <RefreshButton onClick={handleRefresh} busy={isFetching} />
        </div>
      )}

      {/* ─── Load-error banner ──────────────────────────────────
          Only failures from queries the current mode uses. */}
      {loadError && (
        // Right offset clears the default-open desktop SidePanel (w-80 = 320px)
        // + its inset gap; a flat 16 when the panel is closed, on mobile, or in
        // heatmap mode (no SidePanel there, and the panel toggle is hidden, so
        // `showPanel` alone isn't a reliable signal).
        <ObservatoryLoadError
          onRetry={retryFailed}
          right={showPanel && !isMobile && hasSidePanel ? 336 : 16}
          zIndex={Z_TOGGLE}
        />
      )}

      {/* ─── Bottom-left: Layer toggles (>= 900px; mobile has them in the filter drawer) ── */}
      {!isMobile && mapMode === 'global' && (
        <div className="absolute bottom-[96px] left-4" style={{ zIndex: Z_CHROME }}>
          <LayerToggleGroup
            layers={layers}
            reducedMotion={reducedMotion}
            onToggle={(id, next) => update({ layers: { [id]: next } })}
          />
        </div>
      )}

      {/* ─── Legends ──────────────────────────────────────────── */}
      {mapMode === 'global' && (
        <MapLegend
          mode="global"
          colorBy={colorBy}
          defaultCollapsed={isMobile}
          style={{ left: 16, bottom: isMobile ? 120 : 132, zIndex: Z_CHROME }}
        />
      )}
      {mapMode === 'heatmap' && (
        <MapLegend
          mode="heatmap"
          colorBy={colorBy}
          defaultCollapsed={isMobile}
          style={{ left: 16, bottom: isMobile ? 120 : 96, zIndex: Z_CHROME }}
        />
      )}
      {isBotMode && botPoints.length > 0 && (
        <BotDensityLegend
          domain={botDomain}
          globalAvg={botGlobalAvg}
          asOf={botAsOf}
          countries={botPoints.length}
          style={{ left: 16, bottom: isMobile ? 120 : 96, zIndex: Z_CHROME }}
        />
      )}

      {/* ─── Stats bar ─────────────────────────────────────────────
          `bottom` sits flush on top of the ticker wrapper directly below —
          keep this in sync with that wrapper's `height` (desktop 40,
          mobile 72 — see the ticker wrapper below for why). */}
      <div
        className="absolute left-0 right-0 flex items-center justify-between px-4"
        style={{
          bottom: isMobile ? 72 : 40,
          height: 36,
          background: 'var(--bg-card-deep)',
          backdropFilter: 'blur(20px)',
          borderTop: '1px solid var(--border-base)',
          zIndex: Z_CHROME,
        }}
      >
        <div className="flex items-center gap-4">
          {isBotMode ? (
            <div className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
              {/* Bot mode fetches the 7-day Radar window (useBotTraffic(7)). */}
              <span style={{ color: 'var(--amber-text)' }}>7D</span>
              {' · '}
              <span style={{ color: 'var(--text-secondary)' }}>{botPoints.length}</span> countries
              {botGlobalAvg != null && (
                <>{' · '}global avg <span style={{ color: 'var(--text-secondary)' }}>{botGlobalAvg.toFixed(1)}%</span> bots</>
              )}
            </div>
          ) : (
            <div className="font-mono text-[10px]" aria-busy={isUpdating} style={{ color: 'var(--text-muted)', opacity: isUpdating ? 0.6 : 1 }}>
              <span style={{ color: 'var(--amber-text)' }}>{footerPeriodLabel}</span>
              {' · '}
              <span style={{ color: 'var(--text-secondary)' }}>{(stats?.threats_mapped ?? 0).toLocaleString()}</span> threats
              {' · '}
              <span style={{ color: 'var(--text-secondary)' }}>{stats?.countries ?? 0}</span> countries
              {mapMode === 'global' && (
                <>
                  {' · '}
                  <span style={{ color: 'var(--text-secondary)' }}>{arcsResolved.length}</span> arcs
                </>
              )}
            </div>
          )}
        </div>
        <div className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {showParticles && mapMode === 'global' && (
            reducedMotion
              ? <span>Motion reduced</span>
              : <span style={{ color: 'var(--sev-info-text)' }}>GPU particles active</span>
          )}
        </div>
      </div>

      {/* ─── Event ticker ─────────────────────────────────────────
          EventTicker doesn't self-position; it fills whatever box this
          wrapper gives it, and this wrapper is panel-aware (`right` inset)
          exactly like the ticker's siblings. Desktop 40 / mobile 72 (touch
          target sizing) match the stats-bar `bottom` offset and the map's
          bottom inset above. */}
      <div
        className="absolute bottom-0 left-0"
        style={{
          height: isMobile ? 72 : 40,
          right: !isMobile && showPanel && hasSidePanel ? 320 : 0,
          zIndex: Z_CHROME,
        }}
      >
        <EventTicker />
      </div>

      {/* ─── Right panel (desktop) ────────────────────────────── */}
      {!isMobile && (
        <SidePanel period={period} source={source} visible={showPanel && hasSidePanel} onSelectNode={handleSelectNodeFromPanel} />
      )}

      {/* Panel toggle */}
      {!isMobile && hasSidePanel && (
        <button
          type="button"
          onClick={() => setShowPanel(!showPanel)}
          aria-label={showPanel ? 'Hide intelligence panel' : 'Show intelligence panel'}
          aria-expanded={showPanel}
          className="ds-focusable absolute top-1/2 transform -translate-y-1/2"
          style={{
            ...(showPanel ? { right: '320px' } : { right: 0 }),
            background: 'var(--bg-card)',
            backdropFilter: 'blur(20px)',
            border: '1px solid var(--border-base)',
            borderRadius: '8px 0 0 8px',
            padding: '12px 6px',
            color: 'var(--text-tertiary)',
            cursor: 'pointer',
            zIndex: Z_TOGGLE,
          }}
        >
          {showPanel ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
        </button>
      )}

      {/* ─── Intel FAB (mobile) — opens the bottom-sheet drawer ── */}
      {isMobile && hasSidePanel && (
        <button
          type="button"
          onClick={() => setShowMobilePanel(true)}
          aria-label="Open intelligence panel"
          className="ds-focusable absolute flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-wide"
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
            zIndex: Z_PANEL,
          }}
        >
          <PanelRightOpen size={13} />
          Intel
        </button>
      )}

      {/* ─── Intel drawer (mobile) — reuses the existing BottomSheet
          primitive (Esc-to-close + body-scroll-lock for free). BottomSheet
          owns the single scroll container, so the title row below is made
          sticky rather than adding a second scroll container. */}
      {isMobile && hasSidePanel && (
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
            <span className="font-mono text-[10px] uppercase tracking-[0.2em]" style={{ color: 'var(--text-tertiary)' }}>
              Intelligence
            </span>
            <button
              type="button"
              onClick={() => setShowMobilePanel(false)}
              aria-label="Close intelligence panel"
              className="ds-focusable inline-flex items-center justify-center min-w-[44px] min-h-[44px]"
              style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer' }}
            >
              <PanelRightClose size={14} />
            </button>
          </div>
          <SidePanel period={period} source={source} visible mobile onSelectNode={handleSelectNodeFromPanel} />
        </BottomSheet>
      )}
    </div>
  );
}
