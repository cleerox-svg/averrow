/**
 * Observatory — GPU-driven threat console.
 *
 * The sole Observatory surface as of #35 Phase D (v2 retired). deck.gl layers
 * over MapLibre, one animation loop (see components/ThreatMapV3.tsx), and — Phase B
 * — a console around it: a LENS switcher (Threats / Operations / Movement / Hosting /
 * Baseline / Campaigns / Actors), a layer rail, search over the loaded data, a
 * drill-in drawer for anything selected, live sonar pings and a replay timeline.
 *
 * View state (lens, layers, period, source, mode, colour-by, baseline measure and
 * the selection) lives in the URL — see lib/url-state.ts — so views are shareable
 * and survive reload. Every query is enabled only for the view that renders it
 * (lib/mode-data.ts).
 */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  useObservatoryThreats, useObservatoryStats, useObservatoryArcs, useObservatoryHeatmap, useObservatoryLive,
  useRefreshObservatory,
} from '@/hooks/useObservatory';
import type { ThreatPoint, ArcData, HeatmapPoint } from '@/hooks/useObservatory';
import { ThreatMapV3, type MapFocus, type PingBatch, type LensMapProps } from './components/ThreatMapV3';
import { SidePanel } from './components/SidePanel';
import { BottomSheet } from '@/components/BottomSheet';
import { Card, Tabs, Button } from '@/design-system/components';
import { ObservatoryLoadError } from './components/ObservatoryLoadError';
import { EventTicker } from '@/components/observatory/EventTicker';
import { cn } from '@/lib/cn';
import { RefreshCw, PanelRightOpen, PanelRightClose, AlertTriangle, ChevronDown, Search as SearchIcon } from 'lucide-react';
import { ObservatoryOverlay } from '@/components/observatory/ObservatoryOverlay';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useBotTraffic } from '@/hooks/useBotTraffic';
import { BotDensityLegend } from './components/BotDensityLegend';
import { MapLegend } from './components/MapLegend';
import { LayerRail, useLayerShortcuts, type LayerStatus } from './components/LayerRail';
import { LensSwitcher } from './components/LensSwitcher';
import { ObservatorySearch } from './components/ObservatorySearch';
import { DrillDrawer } from './components/DrillDrawer';
import { LensLegend } from './components/LensLegend';
import { ReplayTimeline, usePlayheadBus } from './components/ReplayTimeline';
import { buildBotDensityPoints, botDensityDomain, resolveGlobalAvg } from './lib/bot-density';
import {
  useObservatoryUrlState, parseSel, mapModeOf,
  PERIOD_IDS, SOURCE_IDS, MAP_MODE_IDS, COLOR_BY_IDS,
  type MapMode, type Period, type Source, type ColorBy, type LayerId, type LensId,
} from './lib/url-state';
import { LAYER_IDS } from './lib/lenses';
import { dataNeeds, relevantFailures } from './lib/mode-data';
import { clearOverlayKind } from './lib/overlay-visibility';
import { selectionLngLat, type MapSelection } from './lib/selection';
import { usePrefersReducedMotion } from './lib/use-motion';
import { resolveDrill, drillAnchor, isPending, drillToPatch, selPatch, type DrillTarget, type DrillData } from './lib/drill';
import { targetPatch, type SearchData, type SearchResult } from './lib/search';
import { useLensData } from './lib/use-lens-data';
import { NO_SELECTION, type LensPick, type LensSelection } from './layers/lens-layers';
import { diffLive, announcePings } from './lib/lens/live';
import { AnimationClock } from './lib/animation-clock';
import { CYCLE_LENGTH } from './lib/trips';
import { countryName } from './lib/country-name';
import { useCanSeeTakedowns } from './lib/use-takedown-access';

const PERIOD_LABELS: Record<Period, string> = { '24h': '24H', '7d': '7D', '30d': '30D', '90d': '90D' };
const PERIODS = PERIOD_IDS.map(id => ({ id, label: PERIOD_LABELS[id] }));

const MODE_LABELS: Record<MapMode, string> = { global: 'GLOBAL', heatmap: 'HEATMAP', bot_density: 'BOT DENSITY' };
const MAP_MODES = MAP_MODE_IDS.map(id => ({ id, label: MODE_LABELS[id] }));

const SOURCE_LABELS: Record<Source, string> = { all: 'All Sources', feeds: 'Feeds', spam_trap: 'Spam Trap' };
const SOURCES = SOURCE_IDS.map(id => ({ id, label: SOURCE_LABELS[id] }));

const COLOR_BY_LABELS: Record<ColorBy, string> = { severity: 'Severity', type: 'Type' };
const COLOR_BY_TABS = COLOR_BY_IDS.map(id => ({ id, label: COLOR_BY_LABELS[id] }));

const PANEL_OPEN_MIN_WIDTH = 1280;
/** Width of the docked right slot (intelligence panel or drill drawer). */
const DOCK_WIDTH = 320;
/** Replay bar height + its gap above the stats bar. */
const TIMELINE_H = 56;
/** Approximate width of the desktop left column (filters, layer rail, legends). */
const LEFT_RAIL_WIDTH = 332;

// Stable empties: a fresh `[]` per render would defeat the map's identity-based layer memoisation.
const EMPTY_THREATS: ThreatPoint[] = [];
const EMPTY_ARCS: ArcData[] = [];
const EMPTY_HEAT: HeatmapPoint[] = [];

// Explicit stacking order for this view's overlay chrome — replaces raw
// z-10/20/30/40 Tailwind utilities so the layering intent is documented in
// one place instead of scattered magic numbers. (ThreatMapV3's own hover
// tooltip renders above all of these, inside that component.)
const Z_CHROME = 10;   // top control stack, stats bar, ticker, layer rail
const Z_PANEL = 20;    // mobile Intel FAB (opens the SidePanel drawer)
const Z_TOGGLE = 30;   // desktop panel toggle + load-error banner
const Z_SEARCH = 40;   // the search results list floats above everything else in the chrome

const PICK_TO_SEL: Record<LensPick['kind'], 'op' | 'provider' | 'country' | 'campaign' | 'move' | 'actor'> = {
  operation: 'op', provider: 'provider', country: 'country', campaign: 'campaign', movement: 'move', actor: 'actor',
};

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

const qState = (q: { isLoading: boolean; error: Error | null; refetch: () => Promise<unknown> }) => ({
  isLoading: q.isLoading, error: q.error, refetch: q.refetch,
});

export function ObservatoryV3() {
  const { isMobile, width: viewportWidth } = useBreakpoint();
  const reducedMotion = usePrefersReducedMotion();
  const canSeeTakedowns = useCanSeeTakedowns();
  const { state, update } = useObservatoryUrlState();
  const { period, source, colorBy, layers, lens, measure } = state;
  const mapMode = mapModeOf(state);
  const showNodes = layers.nodes;
  const showParticles = layers.particles;
  const showBeams = layers.beams;
  const sel = useMemo(() => parseSel(state.sel), [state.sel]);

  // The docked panel is 320px: only start open where the map keeps a usable width beside
  // the filter card (>= 1280). Narrower desktops start closed; the toggle opens it.
  const [showPanel, setShowPanel] = useState(() => viewportWidth >= PANEL_OPEN_MIN_WIDTH);
  const [mapFatal, setMapFatal] = useState(false);
  // C1 — mobile-only: the control rows collapse behind a single summary toggle so they don't crowd the map.
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // C2 — mobile-only: bottom-sheet drawer exposing the same SidePanel widgets desktop gets docked on the right.
  const [showMobilePanel, setShowMobilePanel] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  /** The search box has been focused: lens lists it searches get loaded. */
  const [searching, setSearching] = useState(false);

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
      setMobileSearchOpen(false);
    }
  }, [isMobile]);

  const setPeriod = useCallback((id: string) => update({ period: id as Period }), [update]);
  const setSource = useCallback((id: string) => update({ source: id as Source }), [update]);
  const setMapMode = useCallback((id: string) => update({ mode: id as MapMode }), [update]);
  const setColorBy = useCallback((id: string) => update({ colorBy: id as ColorBy }), [update]);
  const setLens = useCallback((id: LensId) => update({ lens: id }), [update]);
  const toggleLayer = useCallback((id: LayerId, next: boolean) => update({ layers: { [id]: next } }), [update]);

  // ─── Data — each query is enabled only for the views that render it ──
  const selectionKind = state.node ? 'node' : state.arc ? 'arc' : sel?.kind ?? null;
  const needs = useMemo(
    () => dataNeeds(mapMode, layers, { selection: selectionKind, searching }),
    [mapMode, layers, selectionKind, searching],
  );
  const threatsQ = useObservatoryThreats({ period, source, enabled: needs.nodes });
  const statsQ = useObservatoryStats({ period, source, enabled: needs.stats });
  const arcsQ = useObservatoryArcs({ period, source, enabled: needs.arcs });
  const heatmapQ = useObservatoryHeatmap({ period, source, enabled: needs.heatmap });
  const threats = threatsQ.data ?? EMPTY_THREATS;
  const arcsResolved = arcsQ.data ?? EMPTY_ARCS;
  const heatmapData = heatmapQ.data ?? EMPTY_HEAT;
  const stats = statsQ.data;

  const actorId = sel?.kind === 'actor' ? sel.id : null;
  const L = useLensData({
    needs, period, source, actorId,
    timelineCountry: sel?.kind === 'country' ? sel.id : null,
  });

  // Bot density mode: fetched only while that mode is active (days=7).
  const isBotMode = needs.bot;
  const { data: botData, isLoading: botLoading, error: botError, refetch: refetchBot } = useBotTraffic(7, { enabled: isBotMode });
  const botPoints = useMemo(() => buildBotDensityPoints(botData?.bot_density), [botData?.bot_density]);
  const botDomain = useMemo(() => botDensityDomain(botPoints), [botPoints]);
  const botGlobalAvg = resolveGlobalAvg(botData);
  const botAsOf = botData?.as_of?.bot_density ?? null;

  // The SidePanel (and its toggle / Intel drawer) only exists in the global view.
  const hasSidePanel = mapMode === 'global';

  // Only failures from queries the current view actually uses raise the banner.
  const failures = relevantFailures(needs, {
    nodes: threatsQ.error, arcs: arcsQ.error, heatmap: heatmapQ.error, stats: statsQ.error,
    operations: L.operationsQ.error, movements: L.movementsQ.error, providers: L.providersQ.error,
    overindex: L.overindexQ.error, campaigns: L.campaignsQ.error, actors: L.actorsQ.error,
    timeline: L.timelineQ.error,
  });
  const loadError = failures.length > 0;
  const retryFailed = useCallback(() => {
    if (failures.includes('nodes')) void threatsQ.refetch();
    if (failures.includes('stats')) void statsQ.refetch();
    if (failures.includes('arcs')) void arcsQ.refetch();
    if (failures.includes('heatmap')) void heatmapQ.refetch();
    if (failures.includes('operations')) void L.operationsQ.refetch();
    if (failures.includes('movements')) void L.movementsQ.refetch();
    if (failures.includes('providers')) void L.providersQ.refetch();
    if (failures.includes('overindex')) void L.overindexQ.refetch();
    if (failures.includes('campaigns')) void L.campaignsQ.refetch();
    if (failures.includes('actors')) void L.actorsQ.refetch();
    if (failures.includes('timeline')) void L.timelineQ.refetch();
  }, [failures, threatsQ, statsQ, arcsQ, heatmapQ, L.operationsQ, L.movementsQ, L.providersQ, L.overindexQ, L.campaignsQ, L.actorsQ, L.timelineQ]);

  // "Updating" = showing the previous period/source's data while the new one loads.
  const activeQueries = [
    needs.nodes ? threatsQ : null, needs.stats ? statsQ : null, needs.arcs ? arcsQ : null, needs.heatmap ? heatmapQ : null,
  ].filter((q): q is typeof threatsQ => q !== null);
  const isUpdating = activeQueries.some(q => q.isUpdating);
  // The footer's threats / countries come from the stats query alone: its label
  // must not flip to the new period until THAT data has arrived.
  const statsUpdating = needs.stats && statsQ.isUpdating;
  const isInitialLoading = activeQueries.some(q => q.isLoading);
  const isFetching = activeQueries.some(q => q.isFetching) || (isBotMode && botLoading);

  // Refresh: invalidate every observatory query (lenses included) + the side panel's widgets.
  const refreshAll = useRefreshObservatory();
  const handleRefresh = useCallback(() => {
    void refreshAll();
    if (isBotMode) void refetchBot();
  }, [refreshAll, isBotMode, refetchBot]);

  // ─── Selection (URL-backed) → drill target ──
  const drillData = useMemo<DrillData>(() => ({
    threats: threatsQ.data,
    arcs: arcsQ.data,
    operations: L.operationsQ.data?.data.operations,
    providers: L.providers,
    campaigns: L.campaigns,
    movements: L.movements,
    actors: L.actorList,
    overindex: L.overindex,
  }), [threatsQ.data, arcsQ.data, L.operationsQ.data, L.providers, L.campaigns, L.movements, L.actorList, L.overindex]);

  const drill = useMemo<DrillTarget | null>(
    () => (mapMode === 'global' ? resolveDrill({ node: state.node, arc: state.arc, sel: state.sel }, drillData) : null),
    [mapMode, state.node, state.arc, state.sel, drillData],
  );

  // The map highlights node / arc selections itself.
  const selection = useMemo<MapSelection | null>(
    () => (drill?.kind === 'node' ? { kind: 'node', node: drill.node } : drill?.kind === 'arc' ? { kind: 'arc', arc: drill.arc } : null),
    [drill],
  );
  const lensSel = useMemo<LensSelection>(() => {
    if (!drill) return NO_SELECTION;
    return {
      ...NO_SELECTION,
      opId: drill.kind === 'operation' ? drill.id : null,
      providerId: drill.kind === 'provider' ? drill.id : null,
      country: drill.kind === 'country' ? drill.code : null,
      campaignId: drill.kind === 'campaign' ? drill.id : null,
      movementId: drill.kind === 'movement' ? drill.id : null,
      actorId: drill.kind === 'actor' ? drill.id : null,
    };
  }, [drill]);

  // ─── Camera ──
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const focusSeq = useRef(0);
  const focusAt = useCallback((at: [number, number] | null, opts: { instant?: boolean; zoom?: number } = {}) => {
    if (!at) return; // unplaceable: select without moving the camera
    focusSeq.current += 1;
    setFocus({ id: focusSeq.current, lng: at[0], lat: at[1], instant: opts.instant ?? false, zoom: opts.zoom });
  }, []);

  /** Select something that did NOT come from a click on the map: the camera follows it. */
  const selectTarget = useCallback((target: DrillTarget) => {
    update(targetPatch(target, layers));
    focusAt(drillAnchor(target));
    setShowMobilePanel(false);
  }, [update, layers, focusAt]);

  const closeDrill = useCallback(() => update(drillToPatch(null)), [update]);

  // A click on the map selects without moving the camera.
  const handleMapSelect = useCallback((s: MapSelection | null) => {
    update(drillToPatch(s ? (s.kind === 'node' ? { kind: 'node', node: s.node } : { kind: 'arc', arc: s.arc }) : null));
  }, [update]);
  const handleLensPick = useCallback((pick: LensPick) => {
    update(selPatch(PICK_TO_SEL[pick.kind], pick.id));
  }, [update]);

  // Keyboard / SR path to node selection: the side panel's Top Threat Origins rows.
  const handleSelectNodeFromPanel = useCallback((node: ThreatPoint) => {
    const sel2: MapSelection = { kind: 'node', node };
    update(drillToPatch({ kind: 'node', node }));
    focusAt(selectionLngLat(sel2));
    setShowMobilePanel(false);
  }, [update, focusAt]);

  // A shared link that restores a selection frames it once (instantly): the camera
  // otherwise opens on the default world view.
  const restoredRef = useRef(!(state.node || state.arc || state.sel));
  useEffect(() => {
    if (restoredRef.current || !drill) return;
    const at = drillAnchor(drill);
    // A pending target (its query hasn't returned) has no position yet: wait for it.
    if (!at && isPending(drill)) return;
    restoredRef.current = true;
    focusAt(at, { instant: true });
  }, [drill, focusAt]);

  // An actor has no single point: frame its most heavily attributed country once its infrastructure loads.
  const actorFocused = useRef<string | null>(null);
  useEffect(() => {
    const m = L.actorModel;
    if (!m || m.empty || actorFocused.current === m.actorId) return;
    actorFocused.current = m.actorId;
    focusAt(m.countries[0]!.position, { zoom: 2.4 });
  }, [L.actorModel, focusAt]);

  // A shared link may point at something that no longer exists in the fresh
  // data: once the relevant query has settled, drop the dead key from the URL.
  const settled = {
    nodes: !threatsQ.isFetching && threatsQ.data !== undefined,
    arcs: !arcsQ.isFetching && arcsQ.data !== undefined,
    op: !L.operationsQ.isFetching && L.operationsQ.data !== undefined,
    provider: !L.providersQ.isFetching && L.providersQ.data !== undefined,
    campaign: !L.campaignsQ.isFetching && L.campaignsQ.data !== undefined,
    move: !L.movementsQ.isFetching && L.movementsQ.data !== undefined,
  };
  useEffect(() => {
    if (drill) return;
    if (state.node && settled.nodes) update(drillToPatch(null));
    else if (state.arc && settled.arcs && settled.nodes) update(drillToPatch(null));
    else if (sel && sel.kind in settled && settled[sel.kind as keyof typeof settled]) update(drillToPatch(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `settled` is derived from the listed query states
  }, [drill, state.node, state.arc, sel, threatsQ.isFetching, threatsQ.data, arcsQ.isFetching, arcsQ.data, L.operationsQ.isFetching, L.operationsQ.data, L.providersQ.isFetching, L.providersQ.data, L.campaignsQ.isFetching, L.campaignsQ.data, L.movementsQ.isFetching, L.movementsQ.data, update]);

  // "Threat Landscape Clear" — only when verified for THIS view.
  const overlayKind = mapFatal ? null : clearOverlayKind({
    mode: mapMode,
    nodesReady: needs.nodes && layers.nodes && threatsQ.data !== undefined && !threatsQ.error && !threatsQ.isUpdating,
    nodeCount: threats.length,
    stats: stats && !statsQ.error && !statsQ.isUpdating
      ? { threats_mapped: stats.threats_mapped, threats_total: stats.threats_total }
      : null,
  });

  const periodLabel = PERIOD_LABELS[period];
  // While the new period loads, the numbers still belong to the previous one: keep
  // labelling them with it (the "Updating to X" pill announces the switch).
  const settledPeriod = useRef(period);
  if (!statsUpdating) settledPeriod.current = period;
  const footerPeriodLabel = PERIOD_LABELS[statsUpdating ? settledPeriod.current : period];

  // ─── Replay clock + transport ──
  const [clock] = useState(() => new AnimationClock({ cycleLength: CYCLE_LENGTH }));
  const playhead = usePlayheadBus();
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [seekVersion, setSeekVersion] = useState(0);
  useEffect(() => { if (playing) clock.play(); else clock.pause(); }, [playing, clock]);
  useEffect(() => { clock.setSpeed(speed); }, [speed, clock]);
  const handleSeek = useCallback((t: number) => { clock.seek(t); setSeekVersion(v => v + 1); }, [clock]);
  const showTimeline = mapMode === 'global' && needs.timeline;

  // ─── Live pings + announcement ──
  const liveQ = useObservatoryLive({ source, enabled: needs.live });
  const seenLive = useRef(new Set<string>());
  const livePrimed = useRef(false);
  const pingSeq = useRef(0);
  const [pings, setPings] = useState<PingBatch | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const pendingAnnounce = useRef<ReturnType<typeof diffLive>>([]);
  const announceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => { seenLive.current.clear(); livePrimed.current = false; }, [source]);
  useEffect(() => {
    if (!liveQ.data) return;
    // The side panel shares this query, so data can arrive while the Nodes layer is off:
    // keep the seen-set current (no flood when it comes back on) but stay quiet.
    const fresh = diffLive(seenLive.current, liveQ.data, livePrimed.current);
    livePrimed.current = true;
    if (fresh.length === 0 || !needs.live) return;
    pingSeq.current += 1;
    setPings({ seq: pingSeq.current, items: fresh });
    // Screen readers hear the same event, batched so a burst is one sentence.
    pendingAnnounce.current = [...pendingAnnounce.current, ...fresh];
    if (!announceTimer.current) {
      announceTimer.current = setTimeout(() => {
        announceTimer.current = null;
        setAnnouncement(announcePings(pendingAnnounce.current));
        pendingAnnounce.current = [];
      }, 1200);
    }
  }, [liveQ.data, needs.live]);
  useEffect(() => () => { if (announceTimer.current) clearTimeout(announceTimer.current); }, []);

  // ─── Lens props for the map ──
  const lensMapProps = useMemo<LensMapProps>(() => ({
    layers,
    operations: L.operationsModel,
    hosting: L.hostingModel,
    baseline: L.baselineModel,
    measure,
    countries: L.geometry.countries,
    campaigns: L.campaignsModel,
    actors: L.actorModel,
    movement: L.movementModel,
    sel: lensSel,
  }), [layers, L.operationsModel, L.hostingModel, L.baselineModel, measure, L.geometry.countries, L.campaignsModel, L.actorModel, L.movementModel, lensSel]);

  // ─── Rail counts / status ──
  const counts = useMemo<Partial<Record<LayerId, number | null>>>(() => ({
    nodes: threatsQ.data ? threatsQ.data.length : null,
    particles: arcsQ.data ? arcsQ.data.length : null,
    beams: arcsQ.data ? arcsQ.data.length : null,
    operations: L.operationsModel ? L.operationsModel.nodes.length : null,
    movement: L.movementModel ? L.movementModel.hops.filter(h => !h.id.endsWith(':w')).length + L.movementModel.pulses.length : null,
    hosting: L.hostingModel ? L.hostingModel.rings.length : null,
    baseline: L.baselineModel ? L.baselineModel.rows.size : null,
    campaigns: L.campaignsModel ? L.campaignsModel.arcs.length : null,
    actors: L.actorModel ? L.actorModel.countries.length : null,
  }), [threatsQ.data, arcsQ.data, L.operationsModel, L.movementModel, L.hostingModel, L.baselineModel, L.campaignsModel, L.actorModel]);
  const status = useMemo<Partial<Record<LayerId, LayerStatus>>>(() => {
    const st = (on: boolean, q: { isLoading: boolean; error: Error | null }): LayerStatus => (!on ? 'idle' : q.error ? 'error' : q.isLoading ? 'loading' : 'idle');
    return {
      nodes: st(needs.nodes, threatsQ), particles: st(needs.arcs, arcsQ), beams: st(needs.arcs, arcsQ),
      operations: st(needs.operations, L.operationsQ), movement: st(needs.movements, L.movementsQ),
      hosting: st(needs.providers, L.providersQ), baseline: st(needs.overindex, L.overindexQ),
      campaigns: st(needs.campaigns, L.campaignsQ), actors: st(needs.actors, L.actorsQ),
    };
  }, [needs, threatsQ, arcsQ, L.operationsQ, L.movementsQ, L.providersQ, L.overindexQ, L.campaignsQ, L.actorsQ]);

  // ─── Search ──
  const searchData = useMemo<SearchData>(() => ({
    threats: threatsQ.data, arcs: arcsQ.data, operations: L.operationsQ.data?.data.operations,
    providers: L.providers, actors: L.actorList, campaigns: L.campaigns,
  }), [threatsQ.data, arcsQ.data, L.operationsQ.data, L.providers, L.actorList, L.campaigns]);
  const handleSearchPick = useCallback((r: SearchResult) => {
    selectTarget(r.target);
    setMobileSearchOpen(false);
  }, [selectTarget]);
  const activateSearch = useCallback(() => setSearching(true), []);

  const onShortcut = useLayerShortcuts(useCallback((id: LayerId) => {
    if (id === 'particles' && reducedMotion) return;
    update({ layers: { [id]: !layers[id] } });
  }, [update, layers, reducedMotion]), mapMode === 'global');

  const onPickActor = useCallback((id: string | null) => {
    if (!id) { update(drillToPatch(null)); return; }
    actorFocused.current = null;
    update(selPatch('actor', id));
  }, [update]);

  // Layout geometry
  const drawerOpen = !isMobile && !!drill;
  const panelInset = !isMobile && hasSidePanel && (drawerOpen || showPanel) ? DOCK_WIDTH : 0;
  const rightClear = panelInset > 0 ? panelInset + 16 : 16;
  const timelineBottom = isMobile ? 116 : 84;
  const leftColBottom = (isMobile ? 120 : 88) + (showTimeline ? TIMELINE_H + 4 : 0);
  const lensLayersOn = LAYER_IDS.some(id => id !== 'nodes' && id !== 'particles' && id !== 'beams' && layers[id]);
  /** Short viewports start with the colour legend collapsed so the rail stays in reach. */
  const [compactHeight] = useState(() => typeof window !== 'undefined' && window.innerHeight < 960);
  const threatLayersOn = layers.nodes || layers.particles || layers.beams;
  const countryLabel = sel?.kind === 'country' ? countryName(sel.id) : null;

  const lensLegend = (
    <LensLegend
      layers={layers}
      operations={{ model: L.operationsModel, q: qState(L.operationsQ) }}
      movement={{ model: L.movementModel, q: qState(L.movementsQ), count: L.movements?.length ?? 0 }}
      hosting={{ model: L.hostingModel, q: qState(L.providersQ) }}
      baseline={{
        model: L.baselineModel, q: qState(L.overindexQ), measure,
        snapshotDate: L.overindexQ.data?.meta.radar_snapshot_date ?? null,
        geometryError: L.geometry.error, period: L.overindexQ.data?.meta.period ?? null,
      }}
      campaigns={{ model: L.campaignsModel, q: qState(L.campaignsQ) }}
      actors={{
        model: L.actorModel, list: L.actorList ? [...L.actorList] : [], listQ: qState(L.actorsQ),
        detailQ: actorId ? qState(L.actorDetailQ) : null, selectedId: actorId,
      }}
      onMeasure={m => update({ measure: m })}
      onPickActor={onPickActor}
    />
  );

  // Fills the shell outlet (.v4-page--fill is a flex column) — no vh math, so
  // it tracks the real topbar + safe-area + platform-alert-banner height.
  return (
    <div className="relative flex-1 min-h-0 overflow-hidden" onKeyDown={onShortcut}>
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
          controlLeftInset={!isMobile && mapMode !== 'bot_density' ? LEFT_RAIL_WIDTH + 16 : 0}
          selection={selection}
          onSelect={handleMapSelect}
          onFatalChange={setMapFatal}
          focus={focus}
          lens={lensMapProps}
          onLensPick={handleLensPick}
          pings={pings}
          clock={clock}
          onPlayhead={playhead.publish}
          seekVersion={seekVersion}
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

      {/* New-threat announcements for screen readers (the sonar pings' text twin). */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>

      {/* Subtle loading / updating pill over the map (no skeleton). */}
      {!isBotMode && (isInitialLoading || isUpdating) && (
        <div
          role="status"
          className="absolute left-1/2 -translate-x-1/2 px-3 py-1 rounded-full font-mono text-[10px] uppercase tracking-wider pointer-events-none"
          style={{
            top: isMobile ? 112 : 64,
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
           on top of the map. Refresh + search ride in-flow beside the summary
           toggle (no absolute-position overlap possible at any width). The lens
           strip scrolls horizontally under it. */
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
            {hasSidePanel && (
              <button
                type="button"
                onClick={() => { setMobileSearchOpen(o => !o); activateSearch(); }}
                aria-label="Search the map"
                aria-expanded={mobileSearchOpen}
                className="ds-focusable shrink-0 inline-flex items-center justify-center rounded-md min-w-[44px] min-h-[44px]"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border-base)', color: mobileSearchOpen ? 'var(--amber-text)' : 'var(--text-muted)', cursor: 'pointer' }}
              >
                <SearchIcon size={14} />
              </button>
            )}
            <RefreshButton onClick={handleRefresh} busy={isFetching} className="shrink-0" />
          </div>

          {hasSidePanel && <LensSwitcher lens={lens} onChange={setLens} />}

          {hasSidePanel && mobileSearchOpen && (
            <div style={{ zIndex: Z_SEARCH }}>
              <ObservatorySearch data={searchData} onPick={handleSearchPick} onActivate={activateSearch} touch />
            </div>
          )}

          <div
            id="observatory-mobile-filters"
            // Collapsed = out of the tab order and the a11y tree (`inert`, not typed in React 18).
            {...(filtersExpanded ? {} : ({ inert: '' } as Record<string, string>))}
            className={cn(
              'transition-all duration-300 ease-in-out motion-reduce:transition-none',
              filtersExpanded ? 'max-h-[min(560px,58vh)] overflow-y-auto opacity-100' : 'max-h-0 overflow-hidden opacity-0 invisible',
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

              {/* LAYERS group (global map only) */}
              {mapMode === 'global' && (
                <div style={{ padding: '6px 0', borderTop: '1px solid var(--border-base)' }}>
                  <div className="text-[10px] font-mono uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-tertiary)' }}>Layers</div>
                  <LayerRail layers={layers} reducedMotion={reducedMotion} onToggle={toggleLayer} counts={counts} status={status} touch />
                </div>
              )}

              {mapMode === 'global' && lensLayersOn && (
                <div style={{ padding: '6px 0', borderTop: '1px solid var(--border-base)' }}>{lensLegend}</div>
              )}
            </Card>
          </div>
        </div>
      ) : (
        <>
          {/* Row 1: lens switcher + search */}
          {hasSidePanel && (
            <div
              className="absolute top-3 left-4 flex items-start gap-2"
              style={{ zIndex: Z_CHROME, right: rightClear + 44 }}
            >
              <LensSwitcher lens={lens} onChange={setLens} className="shrink" />
              <ObservatorySearch
                data={searchData}
                onPick={handleSearchPick}
                onActivate={activateSearch}
                className="flex-1 min-w-[150px] max-w-[300px]"
              />
            </div>
          )}

          {/* Left column: filters, layer rail, legends. Scrolls when the viewport is short. */}
          <div
            className="absolute left-4 flex flex-col gap-2 pointer-events-none overflow-y-auto"
            style={{
              zIndex: Z_CHROME, top: hasSidePanel ? 60 : 12, bottom: leftColBottom, width: LEFT_RAIL_WIDTH, maxWidth: 'calc(100% - 32px)',
              scrollbarWidth: 'thin', paddingBottom: 2,
            }}
          >
            <Card variant="base" padding="10px" className="flex flex-col gap-1.5 shrink-0 pointer-events-auto">
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

            {mapMode === 'global' && (
              <LayerRail
                layers={layers}
                reducedMotion={reducedMotion}
                onToggle={toggleLayer}
                counts={counts}
                status={status}
                defaultCollapsed={viewportWidth < 1200}
                className="pointer-events-auto"
              />
            )}

            {mapMode === 'global' && lensLayersOn && <div className="pointer-events-auto shrink-0">{lensLegend}</div>}

            {/* Legends */}
            {mapMode === 'global' && threatLayersOn && (
              <MapLegend mode="global" colorBy={colorBy} defaultCollapsed={lensLayersOn || compactHeight} style={{ position: 'static', width: '100%', pointerEvents: 'auto', flexShrink: 0 }} />
            )}
            {mapMode === 'heatmap' && (
              <MapLegend mode="heatmap" colorBy={colorBy} style={{ position: 'static', width: '100%', pointerEvents: 'auto', flexShrink: 0 }} />
            )}
            {isBotMode && botPoints.length > 0 && (
              <BotDensityLegend
                domain={botDomain}
                globalAvg={botGlobalAvg}
                asOf={botAsOf}
                countries={botPoints.length}
                style={{ position: 'static', width: '100%', pointerEvents: 'auto', flexShrink: 0 }}
              />
            )}
          </div>
        </>
      )}

      {/* ─── Top-right: Refresh (desktop) ──────────────────────────
          The page-level LIVE badge lives in the shell top bar (ShellV4), so it is not
          repeated here. Mobile gets Refresh in-flow next to the summary toggle. */}
      {!isMobile && (
        <div
          className="absolute top-3 flex items-center gap-2"
          style={{ right: rightClear, zIndex: Z_CHROME }}
        >
          <RefreshButton onClick={handleRefresh} busy={isFetching} />
        </div>
      )}

      {/* ─── Load-error banner ──────────────────────────────────
          Only failures from queries the current view uses. */}
      {loadError && (
        // Right offset clears the docked panel / drawer (w-80 = 320px) + its inset gap;
        // a flat 16 when it is closed, on mobile, or in heatmap mode.
        <ObservatoryLoadError
          onRetry={retryFailed}
          right={rightClear}
          zIndex={Z_TOGGLE}
        />
      )}

      {/* Mobile legends keep their own floating spot (the desktop ones live in the left column). */}
      {isMobile && mapMode === 'global' && threatLayersOn && (
        <MapLegend mode="global" colorBy={colorBy} defaultCollapsed style={{ left: 16, bottom: 120 + (showTimeline ? TIMELINE_H + 4 : 0), zIndex: Z_CHROME }} />
      )}
      {isMobile && mapMode === 'heatmap' && (
        <MapLegend mode="heatmap" colorBy={colorBy} defaultCollapsed style={{ left: 16, bottom: 120, zIndex: Z_CHROME }} />
      )}
      {isMobile && isBotMode && botPoints.length > 0 && (
        <BotDensityLegend
          domain={botDomain}
          globalAvg={botGlobalAvg}
          asOf={botAsOf}
          countries={botPoints.length}
          style={{ left: 16, bottom: 120, zIndex: Z_CHROME }}
        />
      )}

      {/* ─── Replay timeline ─────────────────────────────────────
          Drives the same clock as the particles and movement trails. */}
      {showTimeline && (
        <ReplayTimeline
          data={L.timelineQ.data?.data}
          isLoading={L.timelineQ.isLoading}
          error={L.timelineQ.error}
          onRetry={() => void L.timelineQ.refetch()}
          clock={clock}
          subscribe={playhead.subscribe}
          playing={playing}
          speed={speed}
          onTogglePlay={() => setPlaying(p => !p)}
          onSpeed={setSpeed}
          onSeek={handleSeek}
          reducedMotion={reducedMotion}
          periodLabel={periodLabel}
          countryLabel={countryLabel}
          isMobile={isMobile}
          style={{ position: 'absolute', left: 16, right: isMobile ? 16 : rightClear + 52, bottom: timelineBottom, height: TIMELINE_H, zIndex: Z_CHROME }}
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
            <div className="font-mono text-[10px]" aria-busy={statsUpdating} style={{ color: 'var(--text-muted)', opacity: statsUpdating ? 0.6 : 1 }}>
              <span style={{ color: 'var(--amber-text)' }}>{footerPeriodLabel}</span>
              {' · '}
              <span style={{ color: 'var(--text-secondary)' }}>{(stats?.threats_mapped ?? 0).toLocaleString()}</span> threats
              {' · '}
              <span style={{ color: 'var(--text-secondary)' }}>{stats?.countries ?? 0}</span> countries
              {mapMode === 'global' && threatLayersOn && (
                <>
                  {' · '}
                  <span style={{ color: 'var(--text-secondary)' }}>{arcsResolved.length}</span> arcs
                </>
              )}
            </div>
          )}
        </div>
        <div className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {mapMode === 'global' && (showParticles || lensLayersOn) && (
            reducedMotion
              ? <span>Motion reduced</span>
              : <span style={{ color: 'var(--sev-info-text)' }}>GPU {showParticles ? 'particles' : 'layers'} active</span>
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
          right: panelInset,
          zIndex: Z_CHROME,
        }}
      >
        <EventTicker />
      </div>

      {/* ─── Right slot (desktop): the drill drawer while something is selected, else the intelligence panel ── */}
      {!isMobile && drill && (
        <DrillDrawer target={drill} data={drillData} onClose={closeDrill} onSelect={selectTarget} variant="dock" canSeeTakedowns={canSeeTakedowns} />
      )}
      {!isMobile && (
        <SidePanel period={period} source={source} visible={showPanel && hasSidePanel && !drill} onSelectNode={handleSelectNodeFromPanel} />
      )}

      {/* Panel toggle (the drawer has its own close button and Escape) */}
      {!isMobile && hasSidePanel && !drill && (
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
            bottom: 120 + (showTimeline ? TIMELINE_H + 4 : 0),
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

      {/* ─── Drill drawer (mobile): a bottom sheet over the map ── */}
      {isMobile && (
        <BottomSheet open={!!drill} onClose={closeDrill}>
          {drill && <DrillDrawer target={drill} data={drillData} onClose={closeDrill} onSelect={selectTarget} variant="sheet" canSeeTakedowns={canSeeTakedowns} />}
        </BottomSheet>
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
