/**
 * Observatory — GPU-driven threat console.
 *
 * The sole Observatory surface as of #35 Phase D (v2 retired). deck.gl layers
 * over MapLibre, one animation loop (see components/ThreatMapV3.tsx), and a console
 * around it built on one idea: a LENS is the single exclusive question the map
 * answers (Threats / Operations / Movement / Hosting / Baseline / Campaigns /
 * Actors). Everything else supports it:
 *
 *   toolbar     one 44px row: lens strip, "Find on map", period, source, refresh
 *   rail        slim 44px icon column: the lens's option (Points | Heat,
 *               Over-index | Raw | Bot share) and threat traffic kept underneath
 *   legend      one collapsible chip, bottom-left, for whatever is drawn
 *   right slot  lens-aware intelligence panel, replaced by the drill drawer when
 *               something is selected (docked >= DOCK_MIN_MAP, floating below it,
 *               a non-modal peek sheet on phones)
 *   replay bar  severity histogram + transport on the shared animation clock
 *
 * View state (lens, option, layers, period, source, colour-by and the selection)
 * lives in the URL — see lib/url-state.ts — so views are shareable and survive
 * reload. Layout decisions use the map's measured width (lib/layout.ts), not the
 * viewport at mount, and every query is enabled only for the view that renders it
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
import { Card, Button } from '@/design-system/components';
import { ObservatoryLoadError } from './components/ObservatoryLoadError';
import { EventTicker } from '@/components/observatory/EventTicker';
import { useTheme } from '@/design-system/hooks';
import { RefreshCw, PanelRightOpen, PanelRightClose, AlertTriangle, Search as SearchIcon, SlidersHorizontal } from 'lucide-react';
import { ObservatoryOverlay } from '@/components/observatory/ObservatoryOverlay';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useBotTraffic } from '@/hooks/useBotTraffic';
import { ControlRail } from './components/ControlRail';
import { LensStrip } from './components/LensStrip';
import { ObservatorySearch } from './components/ObservatorySearch';
import { DrillDrawer } from './components/DrillDrawer';
import { LegendChip } from './components/LegendChip';
import { LensPanel } from './components/LensPanel';
import { PeekSheet } from './components/PeekSheet';
import { PeriodSegment, SourceSelect, RefreshButton, FiltersPopover, FILTER_LABEL, PERIOD_LABELS, SOURCE_LABELS } from './components/ToolbarControls';
import { ReplayTimeline, usePlayheadBus } from './components/ReplayTimeline';
import { buildBotDensityPoints, resolveScaleStops, resolveGlobalAvg } from './lib/bot-density';
import { buildBotShareModel } from './lib/lens/bot-share';
import {
  useObservatoryUrlState, parseSel, mapModeOf,
  type Period, type Source, type ColorBy, type LayerId, type LensId, type Measure, type ThreatView,
} from './lib/url-state';
import { noLayers, type LayerToggles } from './lib/lenses';
import type { Projection } from './lib/projection';
import { dataNeeds, relevantFailures } from './lib/mode-data';
import { clearOverlayKind } from './lib/overlay-visibility';
import { selectionLngLat, type MapSelection } from './lib/selection';
import { usePrefersReducedMotion } from './lib/use-motion';
import { resolveDrill, isPending, drillToPatch, selPatch, type DrillTarget, type DrillData } from './lib/drill';
import { targetPatch, type SearchData, type SearchResult } from './lib/search';
import { useLensData } from './lib/use-lens-data';
import { NO_SELECTION, type LensPick, type LensSelection } from './layers/lens-layers';
import { diffLive, announcePings } from './lib/lens/live';
import { AnimationClock } from './lib/animation-clock';
import { CYCLE_LENGTH, periodToMs } from './lib/trips';
import { countryName } from './lib/country-name';
import { TAKEDOWN_ROLE_NOTE, useCanSeeTakedowns, useTakedownAccess } from './lib/use-takedown-access';
import { computeLayout, cameraInsets, chipPlacement, railMaxHeight, initialSheetPx, DOCK_WIDTH, RAIL_TOP, TIMELINE_H } from './lib/layout';
import { useElementSize } from './lib/use-element-width';
import { useViewportHeight } from './lib/use-viewport-height';
import { useLayerShortcuts } from './lib/use-layer-shortcuts';
import { drillPoints, lensFitPoints, type FocusModels } from './lib/camera';
import { legendSummary } from './lib/legend-summary';
import { linkedOperationIds } from './lib/lens/operations';
import { hostingRows, operationRows, baselineRows, campaignRows, movementRows, actorRows, velocityRows, takedownCountryRows, takedownProviderRows } from './lib/panel-rows';
import { takedownPeriod } from '@/hooks/useObservatoryLenses';
import { lensFootnote } from './lib/footnote';
import { MapAttribution } from './components/MapAttribution';
import type { LngLat } from '@/lib/country-centroids';

// Stable empties: a fresh `[]` per render would defeat the map's identity-based layer memoisation.
const EMPTY_THREATS: ThreatPoint[] = [];
const EMPTY_ARCS: ArcData[] = [];
const EMPTY_HEAT: HeatmapPoint[] = [];
const BOT_LAYERS = { ...noLayers(), baseline: true } as LayerToggles;
/** The Fast view is its own picture (like the heatmap and bot share): no threat traffic or lens layer under it. */
const FAST_LAYERS = noLayers();

// Explicit stacking order for this view's overlay chrome — replaces raw
// z-10/20/30/40 Tailwind utilities so the layering intent is documented in
// one place instead of scattered magic numbers. (ThreatMapV3's own hover
// tooltip renders above all of these, inside that component.)
const Z_CHROME = 10;   // rail, stats bar, ticker, legend chip, replay bar
const Z_PANEL = 20;    // intel panel / drill drawer (their own z-20) and the mobile Intel FAB
const Z_TOOLBAR = 22;  // toolbar row: ABOVE the panel / drawer, so its filters + search popovers open over them
const Z_TOGGLE = 30;   // desktop panel toggle + load-error banner

type SheetKey = 'drill' | 'panel';

const FAST_SOURCE_NOTE = 'Fast weaponization is always all sources';

/** What the intelligence panel asks under each lens while its Takedowns measure is on. */
const TAKEDOWN_QUESTION = {
  baseline: 'In which countries do takedowns succeed least often?',
  hosting: 'Which hosts ignore or refuse takedowns most often?',
} as const;

const PICK_TO_SEL: Record<LensPick['kind'], 'op' | 'provider' | 'country' | 'campaign' | 'move' | 'actor'> = {
  operation: 'op', provider: 'provider', country: 'country', campaign: 'campaign', movement: 'move', actor: 'actor',
};

const qState = (q: { isLoading: boolean; error: Error | null; refetch: () => Promise<unknown> }) => ({
  isLoading: q.isLoading, error: q.error, refetch: q.refetch,
});

const LOW_EVIDENCE = 'low-evidence clusters';
/** The Operations panel's count line: what is held back (or, with the toggle on, how many of those are shown). */
export function lowEvidenceNote(total: number, shown: boolean, returned: number | null | undefined): string {
  if (!shown) return `${total.toLocaleString()} ${total === 1 ? 'low-evidence cluster' : LOW_EVIDENCE} hidden (shared hosting, hub IPs, scanning)`;
  const n = Math.min(returned ?? total, total);
  return n >= total
    ? `${total.toLocaleString()} ${total === 1 ? 'low-evidence cluster' : LOW_EVIDENCE} shown (shared hosting, hub IPs, scanning)`
    : `${n.toLocaleString()} of ${total.toLocaleString()} ${LOW_EVIDENCE} shown (largest first)`;
}

export function ObservatoryV3() {
  const { isMobile, width: viewportWidth } = useBreakpoint();
  const reducedMotion = usePrefersReducedMotion();
  const canSeeTakedowns = useCanSeeTakedowns();
  const { resolvedTheme } = useTheme();
  const { state, update } = useObservatoryUrlState();
  const { period, colorBy, layers, lens, view } = state;
  // `measure=takedowns` needs manage_takedowns (the server refuses it to every other role): a viewer without it
  // sees the lens's default measure whatever the URL says, and no takedown request is ever made.
  const measure: Measure = state.measure === 'takedowns' && !canSeeTakedowns ? 'index' : state.measure;
  // ...and the link itself is set right, not just ignored: the address bar (and anything shared from it) stops claiming
  // a view this role cannot see, replacing the entry so Back does not return to it, and a note says what happened.
  const takedownAccessNow = useTakedownAccess();
  const [takedownRefusedOn, setTakedownRefusedOn] = useState<LensId | null>(null);
  useEffect(() => {
    if (state.measure !== 'takedowns' || takedownAccessNow !== 'denied') return;
    setTakedownRefusedOn(state.lens);
    update({ measure: 'index' }); // `update` replaces the history entry
  }, [state.measure, state.lens, takedownAccessNow, update]);
  const takedownNote = takedownRefusedOn === state.lens && state.measure !== 'takedowns' ? TAKEDOWN_ROLE_NOTE : undefined;
  const takedownsOn = measure === 'takedowns';
  const tdWindow = takedownPeriod(state.period);
  const mapMode = mapModeOf(state);
  /** Threats lens, Fast weaponization view: drawn from the velocity cube. */
  const fast = lens === 'threats' && view === 'fast';
  // The velocity cube has no source dimension (the server 400s velocity + a source), so the Fast view is always
  // "all sources" whatever the URL says; the select shows that and is disabled.
  const source: Source = fast ? 'all' : state.source;
  const sel = useMemo(() => parseSel(state.sel), [state.sel]);

  // ─── Layout: the MAP's width decides, and it reacts to every resize ──
  const rootRef = useRef<HTMLDivElement>(null);
  const { width: mapWidth, height: rootHeight } = useElementSize(rootRef);
  const viewportHeight = useViewportHeight();
  const layout = useMemo(() => computeLayout({ mapWidth, viewportWidth, viewportHeight }), [mapWidth, viewportWidth, viewportHeight]);
  const phone = layout.phone || isMobile;

  // The right slot: the intelligence panel (a user choice overrides the tier default) or the drill drawer.
  const [panelPref, setPanelPref] = useState<boolean | null>(null);
  const [mapFatal, setMapFatal] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [showMobilePanel, setShowMobilePanel] = useState(false);
  // The phone sheet that is open and its settled height (px from the page bottom). Keyed so a sheet
  // that is closing can't leak its height into the one opening in the same commit.
  const [sheetRep, setSheetRep] = useState<{ key: SheetKey | null; px: number }>({ key: null, px: 0 });
  const reportSheet = useCallback((key: SheetKey) => (px: number) => {
    setSheetRep(prev => (px > 0 ? (prev.key === key && prev.px === px ? prev : { key, px }) : prev.key === key ? { key: null, px: 0 } : prev));
  }, []);
  const onDrillSheetHeight = useMemo(() => reportSheet('drill'), [reportSheet]);
  const onPanelSheetHeight = useMemo(() => reportSheet('panel'), [reportSheet]);
  /** The search box has been focused: lens lists it searches get loaded. */
  const [searching, setSearching] = useState(false);

  // If the viewport crosses back to desktop while a phone-only surface is open, don't let it spring back.
  useEffect(() => {
    if (!phone) { setShowMobilePanel(false); setMobileSearchOpen(false); }
  }, [phone]);

  const setPeriod = useCallback((p: Period) => update({ period: p }), [update]);
  const setSource = useCallback((s: Source) => update({ source: s }), [update]);
  const setLens = useCallback((id: LensId) => update({ lens: id }), [update]);
  const setLayers = useCallback((patch: Partial<LayerToggles>) => update({ layers: patch }), [update]);
  const setView = useCallback((v: ThreatView) => update({ view: v }), [update]);
  const setMeasure = useCallback((m: Measure) => update({ measure: m }), [update]);
  const setColorBy = useCallback((c: ColorBy) => update({ colorBy: c }), [update]);
  const setProjection = useCallback((proj: Projection) => update({ proj }), [update]);

  // The bot-share scene paints only the baseline shapes: nothing else is drawn under it.
  const mapLayers = mapMode === 'bot_density' ? BOT_LAYERS : fast ? FAST_LAYERS : layers;

  // ─── Data — each query is enabled only for the views that render it ──
  const selectionKind = state.node ? 'node' : state.arc ? 'arc' : sel?.kind ?? null;
  const needs = useMemo(
    () => dataNeeds(mapMode, mapLayers, { selection: selectionKind, searching, velocity: fast, measure }),
    [mapMode, mapLayers, selectionKind, searching, fast, measure],
  );
  const threatsQ = useObservatoryThreats({ period, source, enabled: needs.nodes });
  const statsQ = useObservatoryStats({ period, source, enabled: needs.stats });
  const arcsQ = useObservatoryArcs({ period, source, enabled: needs.arcs });
  const heatmapQ = useObservatoryHeatmap({ period, source, enabled: needs.heatmap });
  const threats = threatsQ.data ?? EMPTY_THREATS;
  const arcsResolved = arcsQ.data ?? EMPTY_ARCS;
  const heatmapData = heatmapQ.data ?? EMPTY_HEAT;
  const stats = statsQ.data;

  // One replay window for the particles, the movement trails and the histogram: [now - period, now],
  // pinned until the data or period changes (not re-read from the wall clock on every render).
  const [replayNowMs, setReplayNowMs] = useState(() => Date.now());
  const replayWindow = useMemo(() => ({ startMs: replayNowMs - periodToMs(period), endMs: replayNowMs }), [replayNowMs, period]);

  const actorId = sel?.kind === 'actor' ? sel.id : null;
  const L = useLensData({
    needs, period, source, actorId,
    timelineCountry: sel?.kind === 'country' ? sel.id : null,
    replayNowMs,
    includeShared: state.shared,
  });

  // Re-pin the window whenever the period/source changes or fresh arcs / moves arrive.
  useEffect(() => { setReplayNowMs(Date.now()); }, [period, source, arcsQ.data, L.movements]);

  // Bot share: fetched only while that scene is active (days=7), painted on the country shapes.
  const isBotMode = needs.bot;
  const { data: botData, isLoading: botLoading, error: botError, refetch: refetchBot } = useBotTraffic(7, { enabled: isBotMode });
  const botPoints = useMemo(() => buildBotDensityPoints(botData?.bot_density), [botData?.bot_density]);
  // Colour stops are tokens read from the DOM: re-resolved after the theme attribute lands.
  const botStops = useMemo(() => resolveScaleStops(), [resolvedTheme]);
  const botGlobalAvg = resolveGlobalAvg(botData);
  const botAsOf = botData?.as_of?.bot_density ?? null;
  const botModel = useMemo(
    () => (isBotMode && botData ? buildBotShareModel(botPoints, botStops, botGlobalAvg, botAsOf) : null),
    [isBotMode, botData, botPoints, botStops, botGlobalAvg, botAsOf],
  );

  // The intelligence panel exists on the interactive scenes (not under the density heatmap).
  const hasPanel = mapMode !== 'heatmap';

  // Only failures from queries the current view actually uses raise the banner.
  const failures = relevantFailures(needs, {
    nodes: threatsQ.error, arcs: arcsQ.error, heatmap: heatmapQ.error, stats: statsQ.error,
    operations: L.operationsQ.error, movements: L.movementsQ.error, providers: L.providersQ.error,
    overindex: L.overindexQ.error, campaigns: L.campaignsQ.error, actors: L.actorsQ.error,
    timeline: L.timelineQ.error, velocity: L.velocityQ.error,
    takedownsCountry: L.takedownCountriesQ.error, takedownsProvider: L.takedownProvidersQ.error,
  });
  const loadError = failures.length > 0 || (isBotMode && !!botError);
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
    if (failures.includes('velocity')) void L.velocityQ.refetch();
    if (failures.includes('takedownsCountry')) void L.takedownCountriesQ.refetch();
    if (failures.includes('takedownsProvider')) void L.takedownProvidersQ.refetch();
    if (isBotMode && botError) void refetchBot();
  }, [failures, threatsQ, statsQ, arcsQ, heatmapQ, L.operationsQ, L.movementsQ, L.providersQ, L.overindexQ, L.campaignsQ, L.actorsQ, L.timelineQ, L.velocityQ, L.takedownCountriesQ, L.takedownProvidersQ, isBotMode, botError, refetchBot]);

  // "Updating" = showing the previous period/source's data while the new one loads.
  const activeQueries = [
    needs.nodes ? threatsQ : null, needs.stats ? statsQ : null, needs.arcs ? arcsQ : null, needs.heatmap ? heatmapQ : null,
    needs.velocity ? L.velocityQ : null,
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
    takedownCountries: L.takedownCountryModel?.rows,
    takedownProviders: L.takedownProviders,
    takedownWindow: tdWindow,
    takedownCountriesError: !!L.takedownCountriesQ.error,
  }), [threatsQ.data, arcsQ.data, L.operationsQ.data, L.providers, L.campaigns, L.movements, L.actorList, L.overindex, L.takedownCountryModel, L.takedownProviders, tdWindow, L.takedownCountriesQ.error]);

  const drill = useMemo<DrillTarget | null>(
    () => (mapMode !== 'heatmap' && mapMode !== 'bot_density' ? resolveDrill({ node: state.node, arc: state.arc, sel: state.sel }, drillData) : null),
    [mapMode, state.node, state.arc, state.sel, drillData],
  );

  // The map highlights node / arc selections itself.
  const selection = useMemo<MapSelection | null>(
    () => (drill?.kind === 'node' ? { kind: 'node', node: drill.node } : drill?.kind === 'arc' ? { kind: 'arc', arc: drill.arc } : null),
    [drill],
  );
  /** A panel row under the pointer: its operation's links are previewed on the map (nothing is selected). */
  const [previewOpId, setPreviewOpId] = useState<string | null>(null);
  const onPanelPreview = useCallback((t: DrillTarget | null) => setPreviewOpId(t && t.kind === 'operation' ? t.id : null), []);
  const lensSel = useMemo<LensSelection>(() => {
    if (!drill) return previewOpId ? { ...NO_SELECTION, previewOpId } : NO_SELECTION;
    return {
      ...NO_SELECTION,
      previewOpId,
      opId: drill.kind === 'operation' ? drill.id : null,
      providerId: drill.kind === 'provider' ? drill.id : null,
      country: drill.kind === 'country' ? drill.code : null,
      campaignId: drill.kind === 'campaign' ? drill.id : null,
      movementId: drill.kind === 'movement' ? drill.id : null,
      actorId: drill.kind === 'actor' ? drill.id : null,
    };
  }, [drill, previewOpId]);

  // ─── Right slot ──
  const panelOpen = (panelPref ?? layout.panelStartsOpen) && hasPanel;
  const rightSlot: 'drawer' | 'panel' | null = phone ? null : drill ? 'drawer' : panelOpen ? 'panel' : null;
  // A short (landscape) phone has no room for the replay bar.
  const showTimeline = mapMode === 'global' && needs.timeline && !layout.compact;

  // ─── Camera: frame ALL of a target inside the area the overlays leave free ──
  // The sheet a selection is about to open has not mounted yet when the camera plans its first move:
  // until it reports its real height, plan for the height it opens at.
  // A 30% peek of a landscape phone is ~100px: barely the handle. Open at the half snap there.
  const sheetInitialSnap = layout.compact ? 1 : 0;
  const sheetKey: SheetKey | null = phone ? (drill ? 'drill' : showMobilePanel && hasPanel ? 'panel' : null) : null;
  const sheetPx = sheetKey === null ? 0 : sheetRep.key === sheetKey && sheetRep.px > 0 ? sheetRep.px : initialSheetPx(rootHeight, sheetInitialSnap);
  const insets = useMemo(
    () => cameraInsets({ layout, rightSlotOpen: rightSlot !== null, showTimeline, sheetPx }),
    [layout, rightSlot, showTimeline, sheetPx],
  );
  const focusModels = useMemo<FocusModels>(
    () => ({ operations: L.operationsModel, hosting: L.hostingModel, campaigns: L.campaignsModel, movement: L.movementModel, actors: L.actorModel }),
    [L.operationsModel, L.hostingModel, L.campaignsModel, L.movementModel, L.actorModel],
  );
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const focusSeq = useRef(0);
  const focusPoints = useCallback((points: readonly LngLat[], opts: { instant?: boolean } = {}) => {
    if (points.length === 0) return; // unplaceable: select without moving the camera
    focusSeq.current += 1;
    setFocus({ id: focusSeq.current, points, instant: opts.instant ?? false });
  }, []);

  // What opened the drawer, so focus can come back to a control that still exists (see DrillDrawer).
  const searchOpenerRef = useRef<HTMLElement | null>(null);
  const panelToggleRef = useRef<HTMLButtonElement | null>(null);
  const openerKind = useRef<'search' | 'panel' | null>(null);
  const fallbackFocus = useCallback((): HTMLElement | null => {
    const search = searchOpenerRef.current;
    const panel = panelToggleRef.current;
    return openerKind.current === 'panel' ? panel ?? search : search ?? panel;
  }, []);

  const restorePanelFocus = useCallback(() => panelToggleRef.current, []);

  /** Select something that did NOT come from a click on the map: the camera follows it. */
  const selectTarget = useCallback((target: DrillTarget) => {
    update(targetPatch(target, layers));
    focusPoints(drillPoints(target, focusModels));
    setShowMobilePanel(false);
  }, [update, layers, focusPoints, focusModels]);

  const closeDrill = useCallback(() => update(drillToPatch(null)), [update]);

  // A click on the map selects without moving the camera.
  const handleMapSelect = useCallback((s: MapSelection | null) => {
    openerKind.current = null;
    update(drillToPatch(s ? (s.kind === 'node' ? { kind: 'node', node: s.node } : { kind: 'arc', arc: s.arc }) : null));
  }, [update]);
  const handleLensPick = useCallback((pick: LensPick) => {
    openerKind.current = null;
    update(selPatch(PICK_TO_SEL[pick.kind], pick.id));
  }, [update]);

  // Keyboard / SR path to node selection: the side panel's Top Threat Origins rows.
  const handleSelectNodeFromPanel = useCallback((node: ThreatPoint) => {
    openerKind.current = 'panel';
    update(drillToPatch({ kind: 'node', node }));
    const at = selectionLngLat({ kind: 'node', node });
    focusPoints(at ? [at] : []);
    setShowMobilePanel(false);
  }, [update, focusPoints]);
  const handlePanelSelect = useCallback((target: DrillTarget) => {
    openerKind.current = 'panel';
    selectTarget(target);
  }, [selectTarget]);

  // A shared link that restores a selection frames it once (instantly): the camera
  // otherwise opens on the default world view.
  const restoredRef = useRef(!(state.node || state.arc || state.sel));
  useEffect(() => {
    if (restoredRef.current || !drill) return;
    const pts = drillPoints(drill, focusModels);
    // A pending target (its query hasn't returned) has no position yet: wait for it.
    if (pts.length === 0 && isPending(drill)) return;
    restoredRef.current = true;
    focusPoints(pts, { instant: true });
  }, [drill, focusPoints, focusModels]);

  // Entering a lens with nothing selected frames what the lens draws, once: the fixed overview (Eurasia at zoom 2.2)
  // can leave the Pacific / the Americas off screen. Reset per lens; never after the person has moved the camera or
  // selected something (their view wins), and not again when the data refreshes.
  const fitRef = useRef<{ lens: LensId | null; done: boolean; moved: boolean }>({ lens: null, done: false, moved: false });
  if (fitRef.current.lens !== lens) fitRef.current = { lens, done: false, moved: false };
  const onUserCamera = useCallback(() => { fitRef.current.moved = true; }, []);
  const hasSelection = !!(drill || state.node || state.arc || state.sel);
  useEffect(() => {
    const f = fitRef.current;
    if (f.done || mapMode !== 'global') return;
    if (f.moved || hasSelection) { f.done = true; return; } // a selection frames itself; a moved camera is theirs
    const pts = lensFitPoints(lens, focusModels);
    if (pts.length === 0) return; // no data yet: wait for it
    f.done = true;
    focusPoints(pts, { instant: true });
  }, [lens, mapMode, hasSelection, focusModels, focusPoints]);

  // An actor has no single point: frame ALL of its attributed countries once its infrastructure loads.
  const actorFocused = useRef<string | null>(null);
  useEffect(() => {
    const m = L.actorModel;
    if (!m || m.empty || actorFocused.current === m.actorId) return;
    actorFocused.current = m.actorId;
    focusPoints(m.countries.map(c => c.position));
  }, [L.actorModel, focusPoints]);

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
  // ...except a link to an operation the default view hides (shared hosting / hub / scanning): that one is
  // resolved by turning `shared=1` on in the URL (replacing the entry), once per id, rather than dropped.
  const sharedRetried = useRef<string | null>(null);
  const sharedPending = useRef(false);
  useEffect(() => {
    if (drill) return;
    if (state.shared) sharedPending.current = false;
    else if (sel?.kind === 'op' && settled.op) {
      if (sharedRetried.current !== sel.id) {
        sharedRetried.current = sel.id;
        sharedPending.current = true;
        update({ shared: true });
        return;
      }
      if (sharedPending.current) return; // the URL update has not landed yet: do not drop the key under it
    }
    if (state.node && settled.nodes) update(drillToPatch(null));
    else if (state.arc && settled.arcs && settled.nodes) update(drillToPatch(null));
    else if (sel && sel.kind in settled && settled[sel.kind as keyof typeof settled]) {
      // A link we widened to shared=1 that still does not resolve: undo the widening with the drop (predictable URL).
      update(sel.kind === 'op' && sharedRetried.current === sel.id && state.shared ? { ...drillToPatch(null), shared: false } : drillToPatch(null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `settled` is derived from the listed query states
  }, [drill, state.node, state.arc, state.shared, sel, threatsQ.isFetching, threatsQ.data, arcsQ.isFetching, arcsQ.data, L.operationsQ.isFetching, L.operationsQ.data, L.providersQ.isFetching, L.providersQ.data, L.campaignsQ.isFetching, L.campaignsQ.data, L.movementsQ.isFetching, L.movementsQ.data, update]);

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
  const scrubbing = useRef(false);
  useEffect(() => { if (playing) clock.play(); else clock.pause(); }, [playing, clock]);
  useEffect(() => { clock.setSpeed(speed); }, [speed, clock]);
  const handleSeek = useCallback((t: number) => { clock.seek(t); setSeekVersion(v => v + 1); }, [clock]);
  const onScrubChange = useCallback((s: boolean) => { scrubbing.current = s; }, []);

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
    // Pings are the one thing that must not compete with scrubbing: while the playhead is
    // being dragged the sonar rings stay quiet (screen readers still hear the arrival).
    if (!scrubbing.current) {
      pingSeq.current += 1;
      setPings({ seq: pingSeq.current, items: fresh });
    }
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
    layers: mapLayers,
    operations: L.operationsModel,
    hosting: L.hostingModel,
    baseline: L.baselineModel,
    measure,
    bot: botModel,
    countries: L.geometry.countries,
    campaigns: L.campaignsModel,
    actors: L.actorModel,
    movement: L.movementModel,
    velocity: fast ? L.velocityModel : null,
    takedownCountries: takedownsOn ? L.takedownCountryModel : null,
    takedownProviders: takedownsOn ? L.takedownProviderModel : null,
    sel: lensSel,
  }), [mapLayers, L.operationsModel, L.hostingModel, L.baselineModel, measure, botModel, L.geometry.countries, L.campaignsModel, L.actorModel, L.movementModel, fast, L.velocityModel, takedownsOn, L.takedownCountryModel, L.takedownProviderModel, lensSel]);
  const sceneKey = `${lens}|${view}|${measure}`;

  // ─── Search ──
  const searchData = useMemo<SearchData>(() => ({
    threats: threatsQ.data, arcs: arcsQ.data, operations: L.operationsQ.data?.data.operations,
    providers: L.providers, actors: L.actorList, campaigns: L.campaigns,
  }), [threatsQ.data, arcsQ.data, L.operationsQ.data, L.providers, L.actorList, L.campaigns]);
  const handleSearchPick = useCallback((r: SearchResult) => {
    openerKind.current = 'search';
    selectTarget(r.target);
    setMobileSearchOpen(false);
  }, [selectTarget]);
  const activateSearch = useCallback(() => setSearching(true), []);

  /** The legend is open: someone is reading, so the globe holds still. */
  const [legendOpen, setLegendOpen] = useState(false);
  const [announceToggle, setAnnounceToggle] = useState('');
  const onShortcut = useLayerShortcuts(useCallback((id: LayerId) => {
    update({ layers: { [id]: !layers[id] } });
    setAnnounceToggle(`${id} ${layers[id] ? 'off' : 'on'}`);
  }, [update, layers]), mapMode === 'global' && !fast);

  const onPickActor = useCallback((id: string | null) => {
    if (!id) { update(drillToPatch(null)); return; }
    actorFocused.current = null;
    update(selPatch('actor', id));
  }, [update]);

  // ─── Layout geometry ──
  const timelineBottom = layout.bottomBand + 8;
  const { bottom: chipBottom, maxPanel: legendMaxPanel } = chipPlacement({
    rootHeight, wantBottom: timelineBottom + (showTimeline ? TIMELINE_H + 8 : 0), topInset: layout.topInset,
  });
  const rightClear = rightSlot ? DOCK_WIDTH + (layout.docked ? 16 : 28) : 16;
  const controlRightInset = rightSlot ? DOCK_WIDTH + (layout.docked ? 0 : 12) : 0;
  const threatLayersOn = mapLayers.nodes || mapLayers.particles || mapLayers.beams;
  const countryLabel = sel?.kind === 'country' ? countryName(sel.id) : null;
  const fastPulses = fast && !!L.velocityModel && L.velocityModel.points.some(p => p.hot);
  const motionOn = !reducedMotion && (mapLayers.particles || fastPulses || (mapMode === 'global' && (mapLayers.operations || mapLayers.hosting || mapLayers.campaigns || mapLayers.actors || mapLayers.movement)));

  // ─── Legend chip content ──
  const legendProps = {
    lens, layers: mapLayers, view, measure, colorBy, reducedMotion,
    takedowns: {
      window: tdWindow,
      countries: { model: L.takedownCountryModel, q: qState(L.takedownCountriesQ) },
      providers: { model: L.takedownProviderModel, q: qState(L.takedownProvidersQ) },
    },
    operations: { model: L.operationsModel, q: qState(L.operationsQ) },
    movement: { model: L.movementModel, q: qState(L.movementsQ), count: L.movements?.length ?? 0 },
    hosting: { model: L.hostingModel, q: qState(L.providersQ) },
    baseline: {
      model: L.baselineModel, q: qState(L.overindexQ), measure,
      snapshotDate: L.overindexQ.data?.meta.radar_snapshot_date ?? null,
      geometryError: L.geometry.error, period: L.overindexQ.data?.meta.period ?? null,
      bot: { model: botModel, q: { isLoading: botLoading, error: botError as Error | null, refetch: () => refetchBot() } },
    },
    campaigns: { model: L.campaignsModel, q: qState(L.campaignsQ) },
    velocity: { model: L.velocityModel, q: qState(L.velocityQ) },
    actors: {
      model: L.actorModel, list: L.actorList ? [...L.actorList] : [], listQ: qState(L.actorsQ),
      detailQ: actorId ? qState(L.actorDetailQ) : null, selectedId: actorId,
    },
    onPickActor,
  };
  const summary = legendSummary({
    lens, view, measure,
    nodes: threatsQ.data ? threatsQ.data.length : null,
    threats: threatsQ,
    velocity: { ...L.velocityQ, count: L.velocityModel ? L.velocityModel.points.length : null },
    takedowns: {
      countries: { ...L.takedownCountriesQ, count: L.takedownCountryModel ? L.takedownCountryModel.rows.size : null },
      // `unknown` (takedowns with no known host) is a row, not a host
      providers: { ...L.takedownProvidersQ, count: L.takedownProviderModel ? L.takedownProviderModel.withRate + L.takedownProviderModel.tooSmall : null },
    },
    operations: { ...L.operationsQ, count: L.operationsModel ? L.operationsModel.placedOps.size : null },
    movement: { ...L.movementsQ, count: L.movementModel ? L.movementModel.hops.filter(h => !h.id.endsWith(':w')).length + L.movementModel.pulses.length : null, events: L.movements?.length ?? 0 },
    hosting: { ...L.providersQ, count: L.hostingModel ? L.hostingModel.rings.length : null },
    baseline: { ...L.overindexQ, count: L.baselineModel ? L.baselineModel.rows.size : null },
    bot: { isLoading: botLoading, error: botError as Error | null, count: botModel ? botModel.rows.size : null },
    campaigns: { ...L.campaignsQ, count: L.campaignsModel ? L.campaignsModel.drawn.size : null },
    actors: { ...L.actorDetailQ, selected: !!actorId, countries: L.actorModel ? L.actorModel.countries.length : null, empty: !!L.actorModel && L.actorModel.empty },
  });

  // ─── Lens-aware panel content ──
  const panelSection = useMemo(() => {
    switch (lens) {
      case 'hosting': return takedownsOn ? takedownProviderRows(L.takedownProviderModel, L.providers, tdWindow) : hostingRows(L.providers);
      case 'operations': return operationRows(L.operationsQ.data?.data.operations, L.operationsModel ? linkedOperationIds(L.operationsModel) : undefined);
      case 'baseline': return takedownsOn ? takedownCountryRows(L.takedownCountryModel, tdWindow) : baselineRows(measure, L.overindex, botPoints);
      case 'campaigns': return campaignRows(L.campaigns);
      case 'movement': return movementRows(L.movements);
      case 'actors': return actorRows(L.actorList);
      case 'threats': return fast ? velocityRows(L.velocityModel) : null;
      default: return null;
    }
  }, [lens, fast, L.velocityModel, measure, takedownsOn, tdWindow, L.takedownProviderModel, L.takedownCountryModel, L.providers, L.operationsQ.data, L.overindex, botPoints, L.campaigns, L.movements, L.actorList]);
  const panelQuery = lens === 'hosting' ? (takedownsOn ? L.takedownProvidersQ : L.providersQ)
    : lens === 'operations' ? L.operationsQ
      : lens === 'baseline' ? (measure === 'bot' ? { isLoading: botLoading, error: botError as Error | null, refetch: () => refetchBot() } : takedownsOn ? L.takedownCountriesQ : L.overindexQ)
        : lens === 'campaigns' ? L.campaignsQ
          : lens === 'movement' ? L.movementsQ
            : lens === 'actors' ? L.actorsQ : fast ? L.velocityQ : null;
  // The Actors lens needs its list for the panel even before the legend asks for it.
  const ex = L.operationsQ.data?.meta?.excluded;
  const excludedTotal = ex ? (ex.shared_asn ?? 0) + (ex.hub_ip ?? 0) + (ex.ip_reputation ?? 0) : 0;
  const lensPanel = (placement: 'dock' | 'overlay' | 'sheet') => (
    panelSection && panelQuery ? (
      <LensPanel
        lens={lens}
        section={panelSection}
        loading={panelQuery.isLoading}
        error={!!panelQuery.error}
        onRetry={() => void panelQuery.refetch()}
        onSelect={handlePanelSelect}
        placement={placement}
        question={takedownsOn && (lens === 'hosting' || lens === 'baseline') ? TAKEDOWN_QUESTION[lens] : undefined}
        note={takedownNote}
        onPreview={lens === 'operations' ? onPanelPreview : undefined}
        aside={lens === 'operations' && (excludedTotal > 0 || state.shared) ? (
          <div className="flex flex-col gap-1.5 font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {excludedTotal > 0 && <span role="status">{lowEvidenceNote(excludedTotal, state.shared, L.operationsQ.data?.meta?.shared_returned)}</span>}
            <button
              type="button"
              onClick={() => update({ shared: !state.shared })}
              aria-pressed={state.shared}
              className="ds-focusable self-start rounded-md px-2 py-1 min-h-[32px]"
              style={{ background: 'none', border: '1px solid var(--border-base)', color: state.shared ? 'var(--amber-text)' : 'var(--text-secondary)', cursor: 'pointer' }}
            >
              Show low-evidence clusters
            </button>
          </div>
        ) : undefined}
      />
    ) : (
      <SidePanel
        period={period}
        source={source}
        visible
        mobile={placement === 'sheet'}
        placement={placement === 'overlay' ? 'overlay' : 'dock'}
        onSelectNode={handleSelectNodeFromPanel}
      />
    )
  );

  const filtersBody = (
    <>
      <div className="flex flex-col gap-1.5">
        <div className={FILTER_LABEL} style={{ color: 'var(--text-tertiary)' }}>Period</div>
        <PeriodSegment period={period} onChange={setPeriod} touch={phone} />
      </div>
      <div className="flex flex-col gap-1.5">
        <div className={FILTER_LABEL} style={{ color: 'var(--text-tertiary)' }}>Source</div>
        <SourceSelect source={source} onChange={setSource} touch={phone} disabledReason={fast ? FAST_SOURCE_NOTE : undefined} />
        {/* The select's own reason is a tooltip: there is no hover on touch, so it is also written out. */}
        {fast && <div className="font-mono text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{FAST_SOURCE_NOTE}</div>}
      </div>
      {isBotMode && (
        <div className="font-mono text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
          Period and source don&apos;t apply to bot share (daily Cloudflare Radar data).
        </div>
      )}
    </>
  );

  const railProps = {
    lens, layers, view, measure, colorBy, reducedMotion,
    onLayers: setLayers, onView: setView, onMeasure: setMeasure, onColorBy: setColorBy, canSeeTakedowns,
  };

  const searchEl = (extra: Partial<React.ComponentProps<typeof ObservatorySearch>> = {}) => (
    <ObservatorySearch
      data={searchData}
      onPick={handleSearchPick}
      onActivate={activateSearch}
      openerRef={searchOpenerRef}
      {...extra}
    />
  );

  // Fills the shell outlet (.v4-page--fill is a flex column) — no vh math, so
  // it tracks the real topbar + safe-area + platform-alert-banner height.
  return (
    <div ref={rootRef} className="relative flex-1 min-h-0 overflow-hidden" onKeyDown={onShortcut} data-tier={layout.tier}>
      {/* Full-screen map — bottom inset reserves the stats bar + ticker band below. */}
      <div
        className="absolute inset-0"
        style={{ bottom: layout.bottomBand }}
        aria-busy={isInitialLoading || isUpdating}
      >
        <ThreatMapV3
          threats={threats}
          arcs={arcsResolved}
          showBeams={mapLayers.beams}
          showParticles={mapLayers.particles}
          showNodes={mapLayers.nodes}
          colorBy={colorBy}
          mapMode={mapMode}
          projection={state.proj}
          onProjection={setProjection}
          onUserCamera={onUserCamera}
          spinHold={legendOpen}
          period={period}
          heatmapData={heatmapData}
          replayNowMs={replayNowMs}
          controlRightInset={controlRightInset}
          cameraInsets={insets}
          selection={selection}
          onSelect={handleMapSelect}
          onFatalChange={setMapFatal}
          focus={focus}
          lens={lensMapProps}
          sceneKey={sceneKey}
          onLensPick={handleLensPick}
          pings={pings}
          clock={clock}
          clockPlaying={playing}
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

      {/* New-threat announcements and control changes for screen readers. */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announceToggle}</div>

      {/* Subtle loading / updating pill over the map (no skeleton). */}
      {!isBotMode && (isInitialLoading || isUpdating) && (
        <div
          role="status"
          className="absolute left-1/2 -translate-x-1/2 px-3 py-1 rounded-full font-mono text-[10px] uppercase tracking-wider pointer-events-none"
          style={{
            top: layout.topInset,
            zIndex: Z_CHROME,
            background: 'var(--bg-card-deep)',
            border: '1px solid var(--border-base)',
            color: 'var(--amber-text)',
          }}
        >
          {isUpdating ? `Updating to ${periodLabel}…` : 'Loading…'}
        </div>
      )}

      {/* Bot share: loading / error / empty states over the map */}
      {isBotMode && (botLoading || botError || (botData && botPoints.length === 0)) && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ zIndex: Z_CHROME }}>
          <Card variant="elevated" padding="16px 24px" className="text-center pointer-events-auto" style={{ maxWidth: 280 }}>
            {botLoading ? (
              <div role="status" className="font-mono text-xs" style={{ color: 'var(--text-tertiary)' }}>Loading bot share&hellip;</div>
            ) : botError ? (
              <div role="alert">
                <div className="flex items-center justify-center gap-2 font-mono text-xs" style={{ color: 'var(--sev-critical-text)' }}>
                  <AlertTriangle size={13} /> Bot share failed to load
                </div>
                <div className="mt-2">
                  <Button variant="danger" size="sm" onClick={() => refetchBot()} icon={<RefreshCw size={11} />}>Retry</Button>
                </div>
              </div>
            ) : (
              <div role="status" className="font-mono text-xs" style={{ color: 'var(--text-tertiary)' }}>No bot-share data yet</div>
            )}
          </Card>
        </div>
      )}

      {/* ─── Toolbar ────────────────────────────────────────────
          Desktop / tablet: ONE 44px row. Phone: summary row, then the lens strip. */}
      {phone ? (
        <div className="absolute top-2 left-3 right-3 flex flex-col gap-2" style={{ zIndex: Z_TOOLBAR }}>
          <div className="flex items-center gap-2">
            <FiltersPopover period={period} source={source} touch align="left" className={layout.compact ? 'shrink-0' : 'flex-1 min-w-0'} triggerClassName={layout.compact ? undefined : 'w-full'}>
              {filtersBody}
              {mapMode !== 'heatmap' || lens === 'threats' ? (
                <div className="flex flex-col gap-2 pt-2" style={{ borderTop: '1px solid var(--border-base)' }}>
                  <ControlRail {...railProps} layout="panel" />
                </div>
              ) : null}
            </FiltersPopover>
            {/* Short viewport: the lens strip shares the row (one 48px band of chrome instead of two). */}
            {layout.compact && <LensStrip lens={lens} onChange={setLens} touch className="flex-1" />}
            <button
              type="button"
              ref={el => { if (el) searchOpenerRef.current = el; }}
              onClick={() => { setMobileSearchOpen(o => !o); activateSearch(); }}
              aria-label="Find on map"
              aria-expanded={mobileSearchOpen}
              className="ds-focusable shrink-0 inline-flex items-center justify-center rounded-xl w-12 h-12"
              style={{ background: 'var(--bg-card)', backdropFilter: 'blur(20px)', border: '1px solid var(--border-base)', boxShadow: 'var(--card-shadow)', color: mobileSearchOpen ? 'var(--amber-text)' : 'var(--text-secondary)', cursor: 'pointer' }}
            >
              <SearchIcon size={15} />
            </button>
            <RefreshButton onClick={handleRefresh} busy={isFetching} touch />
          </div>
          {!layout.compact && <LensStrip lens={lens} onChange={setLens} touch />}
          {mobileSearchOpen && (
            <ObservatorySearch data={searchData} onPick={handleSearchPick} onActivate={activateSearch} touch inline />
          )}
        </div>
      ) : (
        <>
          <div className="absolute top-2 left-3 right-3 flex items-center gap-2" style={{ zIndex: Z_TOOLBAR, height: 44 }} data-toolbar>
            <LensStrip lens={lens} onChange={setLens} className="flex-1" />
            {searchEl({ collapsed: layout.searchCollapsed, className: layout.searchCollapsed ? 'shrink-0' : 'w-[190px] shrink-0' })}
            {layout.filtersInPopover ? (
              <FiltersPopover period={period} source={source}>{filtersBody}</FiltersPopover>
            ) : (
              <>
                <PeriodSegment period={period} onChange={setPeriod} />
                <SourceSelect source={source} onChange={setSource} disabledReason={fast ? FAST_SOURCE_NOTE : undefined} />
              </>
            )}
            <RefreshButton onClick={handleRefresh} busy={isFetching} />
          </div>

          {/* Rail: the lens's option + threat traffic underneath. */}
          {(mapMode !== 'heatmap' || lens === 'threats') && (
            <div
              className="absolute left-3"
              // Stops above the legend chip on a short canvas and scrolls instead of running into it.
              style={{ top: RAIL_TOP, zIndex: Z_CHROME, maxHeight: railMaxHeight({ rootHeight, chipBottom }), overflowY: 'auto', scrollbarWidth: 'thin' }}
            >
              <ControlRail {...railProps} />
            </div>
          )}
        </>
      )}

      {/* ─── Load-error banner ──────────────────────────────────
          Only failures from queries the current view uses. */}
      {loadError && (
        <ObservatoryLoadError
          onRetry={retryFailed}
          right={rightClear}
          zIndex={Z_TOGGLE}
        />
      )}

      {/* ─── Legend chip (one per view) ─────────────────────── */}
      {/* On a phone the open sheet covers the bottom of the map, and with it the chip. */}
      {!(phone && (drill || showMobilePanel)) && <LegendChip
        {...legendProps}
        summary={summary}
        maxPanelHeight={legendMaxPanel}
        onOpenChange={setLegendOpen}
        notice={takedownNote}
        style={{ position: 'absolute', left: 12, bottom: chipBottom, zIndex: Z_CHROME + 2 }}
      />}

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
          onScrubChange={onScrubChange}
          window={replayWindow}
          reducedMotion={reducedMotion}
          periodLabel={periodLabel}
          countryLabel={countryLabel}
          series={fast ? 'velocity' : 'severity'}
          isMobile={phone}
          style={{ position: 'absolute', left: 12, right: phone ? 12 : rightClear + 44, bottom: timelineBottom, height: TIMELINE_H, zIndex: Z_CHROME }}
        />
      )}

      {/* ─── Stats bar ─────────────────────────────────────────────
          `bottom` sits flush on top of the ticker wrapper directly below —
          keep this in sync with that wrapper's `height` (desktop 40,
          mobile 72 — see the ticker wrapper below for why). */}
      <div
        className="absolute left-0 right-0 flex flex-wrap items-center justify-between gap-x-4 px-4 py-0.5"
        style={{
          bottom: layout.statsBottom,
          minHeight: 36,
          background: 'var(--bg-card-deep)',
          backdropFilter: 'blur(20px)',
          borderTop: '1px solid var(--border-base)',
          zIndex: Z_CHROME,
        }}
      >
        <div className="flex items-center gap-4 min-w-0">
          {fast ? (
            <div className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
              <span style={{ color: 'var(--amber-text)' }}>{periodLabel}</span>
              {' · '}
              <span style={{ color: 'var(--text-secondary)' }}>{(L.velocityModel?.total ?? 0).toLocaleString()}</span> fast-weaponized
              {' · '}
              <span style={{ color: 'var(--text-secondary)' }}>{L.velocityModel?.points.length ?? 0}</span> countries
            </div>
          ) : isBotMode ? (
            <div className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
              {/* Bot share fetches the 7-day Radar window (useBotTraffic(7)). */}
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
        <div className="font-mono text-[10px] flex flex-wrap items-center justify-end gap-x-3 min-w-0 ml-auto" style={{ color: 'var(--text-muted)' }}>
          {lensFootnote({ lens, reducedMotion, motionOn, fast }) && (
            <span style={{ color: reducedMotion ? 'var(--text-muted)' : 'var(--sev-info-text)' }}>{lensFootnote({ lens, reducedMotion, motionOn, fast })}</span>
          )}
          <MapAttribution />
        </div>
      </div>

      {/* ─── Event ticker ─────────────────────────────────────────
          EventTicker doesn't self-position; it fills whatever box this
          wrapper gives it. Desktop 40 / mobile 72 (touch target sizing)
          match the stats-bar `bottom` offset and the map's bottom inset above. */}
      {!layout.compact && (
        <div
          className="absolute bottom-0 left-0 right-0"
          style={{ height: layout.statsBottom, zIndex: Z_CHROME }}
        >
          <EventTicker />
        </div>
      )}

      {/* ─── Right slot (desktop / tablet): the drill drawer while something is selected, else the lens-aware panel ── */}
      {!phone && drill && (
        <DrillDrawer
          target={drill} data={drillData} onClose={closeDrill} onSelect={selectTarget}
          variant={layout.docked ? 'dock' : 'overlay'} canSeeTakedowns={canSeeTakedowns} fallbackFocus={fallbackFocus}
        />
      )}
      {!phone && !drill && panelOpen && lensPanel(layout.docked ? 'dock' : 'overlay')}

      {/* Panel toggle (the drawer has its own close button and Escape) */}
      {!phone && hasPanel && !drill && (
        <button
          type="button"
          ref={panelToggleRef}
          onClick={() => setPanelPref(!panelOpen)}
          aria-label={panelOpen ? 'Hide intelligence panel' : 'Show intelligence panel'}
          aria-expanded={panelOpen}
          className="ds-focusable absolute top-1/2 transform -translate-y-1/2"
          style={{
            right: panelOpen ? DOCK_WIDTH + (layout.docked ? 0 : 12) : 0,
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
          {panelOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
        </button>
      )}

      {/* ─── Phone: Intel FAB + peek sheets (non-modal: the map stays live above them) ── */}
      {phone && hasPanel && !drill && !showMobilePanel && (
        <button
          type="button"
          ref={panelToggleRef}
          onClick={() => setShowMobilePanel(true)}
          aria-label="Open intelligence panel"
          className="ds-focusable absolute flex items-center gap-1.5 font-mono text-[11px] font-bold uppercase tracking-wide"
          style={{
            bottom: chipBottom,
            right: 12,
            minHeight: 44,
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
          <SlidersHorizontal size={13} />
          Intel
        </button>
      )}
      {phone && (
        <PeekSheet open={!!drill} onClose={closeDrill} label={drill ? `${drill.kind} details` : 'Details'} onHeight={onDrillSheetHeight} restoreFocus={fallbackFocus} initialSnap={sheetInitialSnap}>
          {drill && <DrillDrawer target={drill} data={drillData} onClose={closeDrill} onSelect={selectTarget} variant="sheet" canSeeTakedowns={canSeeTakedowns} fallbackFocus={fallbackFocus} />}
        </PeekSheet>
      )}
      {phone && hasPanel && (
        <PeekSheet open={showMobilePanel && !drill} onClose={() => setShowMobilePanel(false)} label="Intelligence panel" onHeight={onPanelSheetHeight} restoreFocus={restorePanelFocus} initialSnap={sheetInitialSnap}>
          <div className="sticky top-0 z-[1] flex items-center justify-between px-4 pb-1" style={{ background: 'var(--bg-elevated-solid, var(--bg-elevated))' }}>
            <span className="font-mono text-[10px] uppercase tracking-[0.2em]" style={{ color: 'var(--text-tertiary)' }}>Intelligence</span>
            <button
              type="button"
              onClick={() => setShowMobilePanel(false)}
              aria-label="Close intelligence panel"
              title="Close"
              className="ds-focusable inline-flex items-center justify-center min-w-[44px] min-h-[44px]"
              style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer' }}
            >
              <PanelRightClose size={14} />
            </button>
          </div>
          {lensPanel('sheet')}
        </PeekSheet>
      )}
    </div>
  );
}
