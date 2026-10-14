/**
 * ThreatMapV3 — GPU-driven particle animation via deck.gl TripsLayer.
 *
 * Design notes:
 *   - Particles use TripsLayer with a single `currentTime` uniform driven by a
 *     frame-rate-independent AnimationClock (lib/animation-clock.ts).
 *   - MapboxOverlay runs in overlaid mode (interleaved=false) so particle
 *     redraws don't force basemap redraws.
 *   - Layers are memoised on DATA IDENTITY. TanStack Query's structural sharing
 *     keeps arrays referentially stable across no-change refetches, and click
 *     handlers go through refs, so neither re-creates the layer set.
 *   - ONE rAF loop (anim/use-deck-frame.ts) drives everything animated: particle
 *     trails (TripsLayer currentTime), node heartbeats (PulseExtension), impact
 *     rings (RingExtension) and the lens layers. Per frame only UNIFORMS change
 *     (animTime, currentTime, opacity): every layer's `data` is a stable array
 *     (layers/lens-layers.test.ts pins this for the lens layers), attributes are
 *     re-read only when data changes or a ring is spawned. The loop runs only
 *     while something animates: a playing replay with particles, a breathing
 *     critical / high node, a lens layer with motion, a live ping or a lens
 *     cross-fade. A paused replay with only static content costs zero frames. It
 *     also stops when the tab is hidden or the map is off screen, and under
 *     reduced motion (then: static, with static beams standing in for particles).
 *   - Labels are placed in SCREEN space (lib/label-placement.ts) when the camera
 *     settles (`moveend`), never per frame.
 *   - A scene change (lens / option) cross-fades: the previous scene is kept
 *     ~200ms and faded out while the new one fades in over 240ms, both read from
 *     the frame clock (lib/motion.ts), not from a CSS timer.
 *   - Only FATAL errors (base style failed, WebGL context lost) replace the
 *     map; tile/source hiccups leave it up. Retry re-initialises the map.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { ScatterplotLayer, PathLayer } from '@deck.gl/layers';
import { HeatmapLayer } from '@deck.gl/aggregation-layers';
import type { Layer, PickingInfo } from '@deck.gl/core';
import { TripsLayer } from '@/lib/trips-layer';
import type { LngLat } from '@/lib/country-centroids';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import type { ThreatPoint, ArcData, HeatmapPoint } from '@/hooks/useObservatory';
import {
  getSeverityColor, getArcColor, heatmapWeight, sevText, typeLabel, HEATMAP_COLOR_RANGE,
  type ColorBy, type Rgba,
} from '../lib/map-colors';
import {
  buildTripData, getArcPath, periodToMs, trailLengthFor, CYCLE_LENGTH,
  type TripDatum,
} from '../lib/trips';
import { AnimationClock } from '../lib/animation-clock';
import { classifyMapError, type MapErrorLike } from '../lib/map-errors';
import { hasValidPoint, hasValidArc, centerLngForFreeArea } from '../lib/geo';
import { usePrefersReducedMotion } from '../lib/use-motion';
import {
  useDeckFrame, PulseExtension, RingExtension, RingBuffer, ringBufferLayerProps, ImpactRingSpawner,
  ArrivalScheduler, buildArrivalEvents, phaseForKey, pulseRateForSeverity, pulseAmpForSeverity,
  type PulseExtensionProps, type RingExtensionProps, type ArrivalEvent,
} from '../anim';
import {
  clampCardPosition, type MapSelection,
} from '../lib/selection';
import { nodeKey, arcKey, type MapMode } from '../lib/url-state';
import {
  buildLensBaseLayers, buildLensLayers, lensNeedsFrame, opNodePx, opsMaxThreats,
  type LensLayerInput, type LensPick, type LensHover, type LensPickHandlers,
} from '../layers/lens-layers';
import {
  edgeLabelSources, hostLabelSources, actorLabelSources, placeLensLabels, stablePlacement, NO_LABELS,
  type PlacedLabels, type PlaceInput, type Project,
} from '../layers/lens-labels';
import { highlightGroup } from '../lib/lens/operations';
import { botHover } from '../lib/lens/bot-share';
import type { PingItem } from '../lib/lens/live';
import {
  planCamera, phoneMinZoom, DEFAULT_MIN_ZOOM, WORLD_LAT_LIMIT, PHONE_LAT_LIMIT, FLY_MS, FLY_CURVE, NO_INSETS, type Insets,
} from '../lib/camera';
import {
  motionPolicy, breatheAmp, isLoudSeverity, lensFade, loopNeeded, splitFade, PING_COLOR, LENS_FADE_IN_MS,
} from '../lib/motion';

export type { MapMode } from '../lib/url-state';

// ─── Types ──────────────────────────────────────────────────
interface TooltipInfo {
  x: number;
  y: number;
  lens?: LensHover;
  threat?: ThreatPoint;
  arc?: ArcData;
}

type Pick<T> = PickingInfo<T>;

const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
/** Pointer-pick tolerance in px: nodes render as 1.5-9px dots, far below a usable hit target. */
const PICK_RADIUS_FINE = 8;
const PICK_RADIUS_TOUCH = 16;
const EMPTY_THREATS: ThreatPoint[] = [];
const EMPTY_ARCS: ArcData[] = [];
const EMPTY_HEAT: HeatmapPoint[] = [];
/** The loop keeps running this long after a trigger (ring life) so spawned rings can finish. */
const LOOP_HOLD_MS = 2800;

// Extensions are stateless; share one instance so deck's extension diff is trivially equal.
const PULSE_EXT = [new PulseExtension()];
const RING_EXT = [new RingExtension()];

// Node heartbeat accessors (module-level => stable identity across the per-frame layer rebuild).
// Nodes in the same country + threat type share a phase: a synchronised heartbeat per "operation".
const nodePhase = (d: ThreatPoint) => phaseForKey(`${d.country_code ?? ''}|${d.top_threat_type ?? ''}`);
const nodeRate = (d: ThreatPoint) => pulseRateForSeverity(d.top_severity);
/** Only critical / high nodes breathe (lib/motion.ts); everything else is still. */
const nodeAmp = (d: ThreatPoint) => breatheAmp(d.top_severity, pulseAmpForSeverity, { ambient: true });
const noAmp = () => 0;
const bloomRadius = (d: ThreatPoint) => Math.sqrt(Math.max(1, d.threat_count)) * 5400;
const glowRadius = (d: ThreatPoint) => Math.sqrt(Math.max(1, d.threat_count)) * 2900;
const bloomColor = (d: ThreatPoint) => getSeverityColor(d.top_severity || 'low', 6);
const glowColor = (d: ThreatPoint) => getSeverityColor(d.top_severity || 'low', 12);
const nodePosition = (d: ThreatPoint): [number, number] => [d.lng, d.lat];

/** Lens data + selection the map draws (everything except per-map concerns the map adds itself). */
export type LensMapProps = Omit<LensLayerInput, 'reducedMotion' | 'isMobile' | 'pick' | 'labels'>;

/** A batch of live pings. A new `seq` spawns the items' rings once. */
export interface PingBatch {
  seq: number;
  items: readonly PingItem[];
}

/**
 * Camera request. A NEW `id` frames ALL of `points` (MapLibre flyTo, <= FLY_MS;
 * jumpTo under reduced motion or `instant`), inside the area the overlays leave free.
 */
export interface MapFocus {
  id: number;
  points: ReadonlyArray<LngLat>;
  /** Skip the animation (initial URL restore). */
  instant?: boolean;
}

export { FLY_MS as FLY_DURATION_MS } from '../lib/camera';

// ─── Props ──────────────────────────────────────────────────
export interface ThreatMapV3Props {
  threats: ThreatPoint[];
  arcs: ArcData[];
  showBeams: boolean;
  showParticles: boolean;
  showNodes: boolean;
  colorBy: ColorBy;
  mapMode: MapMode;
  period: string; // 24h, 7d, 30d, 90d — drives timeline replay mapping
  heatmapData?: HeatmapPoint[];
  /** Replay window end (ms). One value for particles, movement and the timeline so they share a window. */
  replayNowMs?: number;
  /**
   * Right inset (px) of the zoom control: the width of whatever docks/overlays the
   * map's right edge (the open panel / drawer), so the control stays visible.
   */
  controlRightInset?: number;
  /**
   * What overlays the map on each side (rail, toolbar, drawer, timeline, sheet), px.
   * Camera moves frame their target in the area that is left free.
   */
  cameraInsets?: Insets;
  /** Currently selected node / arc (resolved against the current data), or null. */
  selection?: MapSelection | null;
  /** Called with a new selection on click/tap, or null to clear (empty-map click). */
  onSelect?: (selection: MapSelection | null) => void;
  /**
   * Animation clock. Defaults to an internal one; Phase B's replay timeline
   * passes its own to drive play / pause / speed / seek.
   */
  clock?: AnimationClock;
  /** Whether the replay is playing (a paused replay with nothing else moving needs no frames). */
  clockPlaying?: boolean;
  /** Phase B lens data. Omit (or all layers off) for the plain threat map. */
  lens?: LensMapProps;
  /** Changes when the lens / option changes: triggers the cross-fade. */
  sceneKey?: string;
  /** A lens object was clicked / tapped on the map. */
  onLensPick?: (pick: LensPick) => void;
  /** New live threats: a sonar ring at each origin (static highlight under reduced motion). */
  pings?: PingBatch | null;
  /** Called every animation frame with the replay playhead (clock units) — for DOM-only readouts, never React state. */
  onPlayhead?: (t: number) => void;
  /** Bump to repaint once after a seek while the loop is not running (reduced motion / hidden tab / paused). */
  seekVersion?: number;
  focus?: MapFocus | null;
  /** Notified when the map enters / leaves the fatal fallback (so the page can hide map-dependent overlays). */
  onFatalChange?: (fatal: boolean) => void;
}

// ─── Error boundary ─────────────────────────────────────────
class MapErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

function MapFallback({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center w-full h-full"
      style={{ background: 'var(--bg-page)' }}
    >
      <div className="font-mono text-xs uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>
        Map Unavailable
      </div>
      <div className="text-sm mb-4 max-w-md text-center px-4" style={{ color: 'var(--text-tertiary)' }}>
        {message}
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="ds-focusable font-mono text-xs px-4 py-2 rounded-lg"
          style={{
            background: 'color-mix(in srgb, var(--amber) 15%, transparent)',
            border: '1px solid var(--amber-border)',
            color: 'var(--amber-text)',
            cursor: 'pointer',
          }}
        >
          Retry
        </button>
      )}
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────
export function ThreatMapV3({ onFatalChange, ...props }: ThreatMapV3Props) {
  // `fatal` is set only for unrecoverable failures. Retrying bumps `initKey`,
  // which remounts the inner component and builds a brand-new map instance
  // (the old one was already torn down by the inner cleanup on unmount).
  const [fatal, setFatal] = useState<string | null>(null);
  const [initKey, setInitKey] = useState(0);
  const retry = useCallback(() => {
    setFatal(null);
    setInitKey(k => k + 1);
  }, []);
  useEffect(() => { onFatalChange?.(fatal !== null); }, [fatal, onFatalChange]);

  if (fatal) return <MapFallback message={fatal} onRetry={retry} />;

  return (
    <MapErrorBoundary key={initKey} fallback={<MapFallback message="The map failed to initialize." onRetry={retry} />}>
      <ThreatMapV3Inner {...props} onFatal={setFatal} />
    </MapErrorBoundary>
  );
}

function ThreatMapV3Inner({
  threats = EMPTY_THREATS, arcs: arcsIn = EMPTY_ARCS, showBeams, showParticles, showNodes, colorBy,
  mapMode, period, heatmapData: heatmapIn = EMPTY_HEAT, replayNowMs,
  controlRightInset = 0, cameraInsets = NO_INSETS,
  selection = null, onSelect, clock: clockProp, clockPlaying = true, onFatal, focus = null,
  lens, sceneKey = '', onLensPick, pings = null, onPlayhead, seekVersion = 0,
}: ThreatMapV3Props & { onFatal: (message: string) => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const deckRef = useRef<MapboxOverlay | null>(null);
  const navControlRef = useRef<maplibregl.NavigationControl | null>(null);
  const styleLoadedRef = useRef(false);

  const { isMobile } = useBreakpoint();
  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;

  const [ownClock] = useState(() => new AnimationClock({ cycleLength: CYCLE_LENGTH }));
  const clock = clockProp ?? ownClock;

  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null);
  /** Country code of the pinned bot-share tooltip, if any. */
  const pinnedRef = useRef<string | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [tileIssue, setTileIssue] = useState(false);
  const [size, setSize] = useState({ width: 0, height: 0 });

  // Stable handler bag: layers close over THIS, never over props, so a parent
  // re-render (e.g. onSelect identity) can't invalidate the layer set.
  const latest = useRef({ onSelect, controlRightInset, cameraInsets, onLensPick, onPlayhead, lens, mapMode });
  latest.current = { onSelect, controlRightInset, cameraInsets, onLensPick, onPlayhead, lens, mapMode };
  const handlers = useMemo(() => ({
    hover: (info: Pick<ThreatPoint>) => setTooltip(info.object ? { x: info.x, y: info.y, threat: info.object } : null),
    hoverArc: (info: Pick<ArcData>) => setTooltip(info.object ? { x: info.x, y: info.y, arc: info.object } : null),
    clickNode: (info: Pick<ThreatPoint>) => {
      if (!info.object) return false;
      const sel: MapSelection = { kind: 'node', node: info.object };
      setTooltip(null);
      latest.current.onSelect?.(sel);
      return true;
    },
    clickArc: (info: Pick<ArcData>) => {
      if (!info.object) return false;
      const sel: MapSelection = { kind: 'arc', arc: info.object };
      setTooltip(null);
      latest.current.onSelect?.(sel);
      return true;
    },
    hoverLens: (hover: LensHover | null) => {
      if (pinnedRef.current) return; // a pinned tooltip stays until dismissed
      setTooltip(hover ? { x: hover.x, y: hover.y, lens: hover } : null);
    },
    clickLens: (pick: LensPick, at?: { x: number; y: number }) => {
      // Bot-share scene: a tap PINS the country's tooltip (touch has no hover); tap again to dismiss.
      if (latest.current.mapMode === 'bot_density' && pick.kind === 'country' && at) {
        if (pinnedRef.current === pick.id) {
          pinnedRef.current = null;
          setTooltip(null);
        } else {
          const bot = latest.current.lens?.bot;
          const row = bot?.rows.get(pick.id);
          const h = row ? botHover(row, bot?.globalAvg ?? null) : { title: pick.id, lines: ['no Radar bot-share data'] };
          pinnedRef.current = pick.id;
          setTooltip({ x: at.x, y: at.y, lens: { x: at.x, y: at.y, ...h } });
        }
        return true;
      }
      setTooltip(null);
      latest.current.onLensPick?.(pick);
      return true;
    },
    // Map-level click: only reached for empty-map clicks (layer handlers return true).
    clickEmpty: (info: PickingInfo) => {
      if (info.object) return;
      pinnedRef.current = null;
      setTooltip(null);
      latest.current.onSelect?.(null);
    },
  }), []);

  // Keep the zoom control clear of the panel overlaying the map's right edge.
  const applyControlInset = useCallback(() => {
    const ctrl = mapContainerRef.current?.querySelector<HTMLElement>('.maplibregl-ctrl-bottom-right');
    if (ctrl) ctrl.style.right = `${latest.current.controlRightInset}px`;
  }, []);
  useEffect(applyControlInset, [controlRightInset, applyControlInset]);

  // ─── Map initialization (once per mount; retry remounts) ──
  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container || mapRef.current) return;

    let map: maplibregl.Map;
    try {
      const ins = latest.current.cameraInsets;
      map = new maplibregl.Map({
        container,
        style: MAP_STYLE,
        center: isMobileRef.current
          ? [-30, 30]
          : [centerLngForFreeArea(10, ins.left, ins.right, 2.2), 25],
        zoom: isMobileRef.current ? 0.6 : 2.2,
        pitch: isMobileRef.current ? 0 : 20,
        bearing: 0,
        minZoom: isMobileRef.current ? phoneMinZoom(container.clientWidth) : undefined,
        maxZoom: 12,
        antialias: true,
        attributionControl: false,
      });
    } catch (err) {
      onFatal(`Map initialization failed: ${err instanceof Error ? err.message : 'WebGL unavailable'}`);
      return;
    }
    mapRef.current = map;

    // Set on cleanup. Under React StrictMode (dev) the effect is mounted,
    // cleaned up and mounted again; `map.remove()` in that first cleanup
    // dispatches `webglcontextlost` on the OLD canvas. Events from a disposed
    // instance must never reach onFatal or they replace the healthy second map.
    let disposed = false;

    map.on('error', (e) => {
      if (disposed) return;
      const verdict = classifyMapError(e as unknown as MapErrorLike, {
        styleLoaded: styleLoadedRef.current,
        styleUrl: MAP_STYLE,
      });
      if (verdict === 'fatal') {
        onFatal(`Map initialization failed: ${e.error?.message || 'base map style unavailable'}`);
      } else {
        setTileIssue(true);
      }
    });
    map.on('idle', () => { if (!disposed) setTileIssue(false); });

    const canvas = map.getCanvas();
    const onContextLost = (e: Event) => {
      if (disposed) return;
      e.preventDefault();
      onFatal('WebGL context was lost. This can happen on mobile with large datasets.');
    };
    canvas.addEventListener('webglcontextlost', onContextLost);

    // `style.load`, not `load`: `load` also waits for sprite / tiles, so a
    // recoverable sprite 404 would leave the map "not loaded" forever.
    const markLoaded = () => {
      if (disposed) return;
      styleLoadedRef.current = true;
      setMapLoaded(true);
    };
    if (map.isStyleLoaded()) markLoaded();
    else map.once('style.load', markLoaded);

    return () => {
      disposed = true;
      canvas.removeEventListener('webglcontextlost', onContextLost);
      // Runs on unmount AND on the fatal path (onFatal swaps this component
      // for the fallback), so the WebGL context and deck resources are always released.
      setMapLoaded(false);
      styleLoadedRef.current = false;
      const overlay = deckRef.current;
      deckRef.current = null;
      navControlRef.current = null;
      if (overlay) {
        try { map.removeControl(overlay as unknown as maplibregl.IControl); } catch { /* already removed */ }
        try { overlay.finalize(); } catch { /* already finalized */ }
      }
      try { map.remove(); } catch { /* map failed mid-init */ }
      mapRef.current = null;
    };
  }, [onFatal]);

  // Zoom control follows the breakpoint (it was only ever added at first render).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    if (!isMobile && !navControlRef.current) {
      const ctrl = new maplibregl.NavigationControl({ showCompass: false });
      // Bottom-right, not top-right: the page's toolbar owns the top edge.
      map.addControl(ctrl, 'bottom-right');
      navControlRef.current = ctrl;
      applyControlInset();
    } else if (isMobile && navControlRef.current) {
      map.removeControl(navControlRef.current);
      navControlRef.current = null;
    }
  }, [isMobile, mapLoaded, applyControlInset]);

  // The phone's zoom floor follows the canvas width (a rotation changes how much world fits). The latitude
  // range is widened with it: otherwise MapLibre's "world must cover the canvas vertically" rule pins the
  // zoom at ~0.3 on a tall phone and a world-spanning target is clipped (see PHONE_LAT_LIMIT).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded || size.width === 0) return;
    const lat = isMobile ? PHONE_LAT_LIMIT : WORLD_LAT_LIMIT;
    if (map.transform) map.transform.latRange = [-lat, lat];
    if (typeof map.setMinZoom === 'function') map.setMinZoom(isMobile ? phoneMinZoom(size.width) : DEFAULT_MIN_ZOOM);
  }, [isMobile, mapLoaded, size.width]);

  // Track container size (resize, rotation, side-panel toggles) and keep the GL canvas in sync.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const update = () => {
      setSize(prev => (prev.width === el.clientWidth && prev.height === el.clientHeight ? prev : { width: el.clientWidth, height: el.clientHeight }));
      mapRef.current?.resize();
    };
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ─── Derived, identity-memoised data ──────────────────────
  // 0 is a valid coordinate: exclude only non-finite values and null island (0,0).
  const geoThreats = useMemo(() => threats.filter(hasValidPoint), [threats]);
  const geoArcs = useMemo(() => arcsIn.filter(hasValidArc), [arcsIn]);
  const geoHeat = useMemo(() => heatmapIn.filter(hasValidPoint), [heatmapIn]);
  const hasLoudNodes = useMemo(() => geoThreats.some(t => isLoudSeverity(t.top_severity)), [geoThreats]);
  const targetNodes = useMemo(() => {
    const byPos = new Map<string, ArcData>();
    for (const a of geoArcs) {
      const k = a.targetPosition.join(',');
      if (!byPos.has(k)) byPos.set(k, a);
    }
    return Array.from(byPos.values());
  }, [geoArcs]);

  const reducedMotion = usePrefersReducedMotion();
  const policy = useMemo(
    () => motionPolicy({ reducedMotion, particlesLayer: showParticles && mapMode === 'global' }),
    [reducedMotion, showParticles, mapMode],
  );
  // Reduced motion: the corridors the particles would have run along stay visible as static beams.
  const beamsOn = showBeams || policy.staticBeams;

  const tripData = useMemo(
    () => buildTripData(geoArcs, colorBy, isMobile, periodToMs(period), replayNowMs),
    [geoArcs, colorBy, isMobile, period, replayNowMs],
  );

  const selectedNode = selection?.kind === 'node' ? selection.node : null;
  const selectedArc = selection?.kind === 'arc' ? selection.arc : null;
  const selectedNodeId = selectedNode ? nodeKey(selectedNode) : null;
  const selectedArcId = selectedArc ? arcKey(selectedArc) : null;

  // ─── Static layers (rebuilt only when their data / style inputs change) ──
  const staticLayers = useMemo(() => {
    const layers: Layer[] = [];

    if (mapMode === 'global') {
      if (showNodes && geoThreats.length > 0) {
        layers.push(
          new ScatterplotLayer<ThreatPoint>({
            id: 'nodes-core',
            data: geoThreats,
            getPosition: d => [d.lng, d.lat],
            getRadius: d => Math.sqrt(Math.max(1, d.threat_count)) * 1440,
            getFillColor: d => getSeverityColor(d.top_severity?.toLowerCase() || 'low'),
            stroked: true, filled: true,
            radiusMinPixels: 1.5, radiusMaxPixels: 9,
            pickable: true,
            onHover: handlers.hover,
            onClick: handlers.clickNode,
          }),
        );
      }

      if (beamsOn && geoArcs.length > 0) {
        const beamWidth = isMobile ? 2.5 : 1;
        // Reduced motion stands the beams in for the particles, so they are a touch stronger.
        const lift = policy.staticBeams ? 1.5 : 1;
        layers.push(
          new PathLayer<ArcData>({
            id: 'beam-glow',
            data: geoArcs,
            getPath: getArcPath,
            getColor: d => getArcColor(d, colorBy, 51 * lift),
            getWidth: beamWidth,
            widthUnits: 'pixels',
            widthMinPixels: isMobile ? 2 : 1,
            widthMaxPixels: isMobile ? 4 : 2,
            updateTriggers: { getColor: [colorBy, lift] },
          }),
          new PathLayer<ArcData>({
            id: 'beam-core',
            data: geoArcs,
            getPath: getArcPath,
            getColor: d => getArcColor(d, colorBy, 76 * lift),
            getWidth: beamWidth,
            widthUnits: 'pixels',
            widthMinPixels: isMobile ? 2 : 1,
            widthMaxPixels: isMobile ? 3 : 1,
            updateTriggers: { getColor: [colorBy, lift] },
            pickable: true,
            onHover: handlers.hoverArc,
            onClick: handlers.clickArc,
          }),
        );
      }

      if (geoArcs.length > 0 && (beamsOn || showNodes)) {
        // Country-precision targets are only approximate: draw them fainter.
        const approx = (d: ArcData) => d.target_precision === 'country';
        layers.push(
          new ScatterplotLayer<ArcData>({
            id: 'targets-ring',
            data: targetNodes,
            getPosition: d => d.targetPosition,
            getRadius: 12000,
            getFillColor: d => [255, 255, 255, approx(d) ? 3 : 6] as Rgba,
            getLineColor: d => [255, 255, 255, approx(d) ? 20 : 40] as Rgba,
            lineWidthMinPixels: 1, stroked: true, radiusMinPixels: 3, radiusMaxPixels: 14,
          }),
          new ScatterplotLayer<ArcData>({
            id: 'targets-core',
            data: targetNodes,
            getPosition: d => d.targetPosition,
            getRadius: 3600,
            getFillColor: d => [255, 255, 255, approx(d) ? 25 : 45] as Rgba,
            radiusMinPixels: 1.5, radiusMaxPixels: 5,
          }),
        );
      }

      // Selection highlight
      if (selectedNode) {
        layers.push(new ScatterplotLayer<ThreatPoint>({
          id: 'selection-node',
          data: [selectedNode],
          getPosition: d => [d.lng, d.lat],
          radiusUnits: 'pixels',
          getRadius: 14,
          stroked: true, filled: false,
          lineWidthUnits: 'pixels', getLineWidth: 2,
          getLineColor: [229, 168, 50, 255],
        }));
      }
      if (selectedArc) {
        layers.push(new PathLayer<ArcData>({
          id: 'selection-arc',
          data: [selectedArc],
          getPath: getArcPath,
          getColor: [229, 168, 50, 230],
          getWidth: 2.5, widthUnits: 'pixels',
        }));
      }
    }

    if (mapMode === 'heatmap' && geoHeat.length > 0) {
      layers.push(new HeatmapLayer<HeatmapPoint>({
        id: 'heatmap-layer',
        data: geoHeat,
        getPosition: d => [d.lng, d.lat],
        getWeight: heatmapWeight,
        radiusPixels: 80, intensity: 2, threshold: 0.05, aggregation: 'SUM',
        colorRange: HEATMAP_COLOR_RANGE.map(c => [c[0], c[1], c[2], c[3]] as [number, number, number, number]),
      }));
    }

    return layers;
    // selectedNode/selectedArc are keyed by id so a data refetch that returns
    // an equal object doesn't rebuild.
  }, [
    geoThreats, geoArcs, targetNodes, beamsOn, policy.staticBeams, showNodes, colorBy, mapMode, geoHeat,
    isMobile, handlers, selectedNodeId, selectedArcId,
  ]);

  // Drop any stale hover tooltip when the scene changes (the hovered layer is gone).
  useEffect(() => { pinnedRef.current = null; setTooltip(null); }, [mapMode, sceneKey]);

  // ─── Animation ────────────────────────────────────────────
  const particlesOn = policy.flow && tripData.length > 0;
  /** Impact rings follow the particles: same toggle, same reduced-motion rule. */
  const ringsOn = particlesOn;
  const pulseOn = mapMode === 'global' && showNodes && hasLoudNodes && policy.ambient;

  const makeTrips = useCallback((currentTime: number) => new TripsLayer({
    id: 'particle-trails',
    data: tripData,
    getPath: (d: TripDatum) => d.path,
    getTimestamps: (d: TripDatum) => d.timestamps,
    getColor: (d: TripDatum) => d.color,
    currentTime,
    trailLength: trailLengthFor(isMobile),
    fadeTrail: true,
    widthMinPixels: isMobile ? 1.5 : 2,
    capRounded: true,
  }), [tripData, isMobile]);

  // Node bloom + glow breathe via PulseExtension: only critical / high nodes have an amplitude,
  // `animTime` (seconds) is the only per-frame input. Reduced motion => amp 0 (static).
  const makeGlow = useCallback((animTime: number): Layer[] => {
    if (mapMode !== 'global' || !showNodes || geoThreats.length === 0) return [];
    const shared = {
      data: geoThreats,
      getPosition: nodePosition,
      getPulsePhase: nodePhase,
      getPulseRate: nodeRate,
      getPulseAmp: reducedMotion ? noAmp : nodeAmp,
      updateTriggers: { getPulseAmp: reducedMotion },
      extensions: PULSE_EXT,
      animTime,
    };
    return [
      new ScatterplotLayer<ThreatPoint, PulseExtensionProps<ThreatPoint>>({
        ...shared, id: 'nodes-bloom', getRadius: bloomRadius, getFillColor: bloomColor,
        radiusMinPixels: 3, radiusMaxPixels: 24,
      }),
      new ScatterplotLayer<ThreatPoint, PulseExtensionProps<ThreatPoint>>({
        ...shared, id: 'nodes-glow', getRadius: glowRadius, getFillColor: glowColor,
        radiusMinPixels: 2, radiusMaxPixels: 14,
      }),
    ];
  }, [mapMode, showNodes, geoThreats, reducedMotion]);

  // Impact rings: a fixed 256-slot pool (typed arrays) behind ONE layer; arrivals
  // overwrite the oldest slot and bump `version`, so nothing is reallocated.
  const [ringBuffer] = useState(() => new RingBuffer());
  const spawner = useMemo(() => new ImpactRingSpawner(ringBuffer), [ringBuffer]);
  // Only critical / high arrivals earn a ring: the rest land quietly.
  const scheduler = useMemo(
    () => new ArrivalScheduler(buildArrivalEvents(tripData, CYCLE_LENGTH).filter(e => isLoudSeverity(e.severity)), CYCLE_LENGTH),
    [tripData],
  );
  // A new data set invalidates old rings (their targets may be gone).
  useEffect(() => { ringBuffer.clear(); spawner.reset(); }, [scheduler, ringBuffer, spawner]);

  const makeRings = useCallback((animTime: number) => new ScatterplotLayer<number, RingExtensionProps<number>>({
    id: 'impact-rings',
    ...ringBufferLayerProps(ringBuffer),
    getRadius: isMobile ? 16 : 22,
    radiusUnits: 'pixels',
    stroked: true,
    filled: false,
    lineWidthUnits: 'pixels',
    getLineWidth: 1.5,
    pickable: false,
    extensions: RING_EXT,
    ringFrom: 0.12,
    ringTo: 1,
    animTime,
  }), [ringBuffer, isMobile]);

  // ─── Phase B lenses ───────────────────────────────────────
  // Labels that fit at the current camera (placed when it settles, see recomputeLabels).
  const [labels, setLabels] = useState<PlacedLabels>(NO_LABELS);

  const lensInput = useMemo<LensLayerInput | null>(() => {
    if (!lens || mapMode === 'heatmap') return null;
    const pick: LensPickHandlers = { hover: handlers.hoverLens, click: handlers.clickLens };
    return { ...lens, labels, reducedMotion, isMobile, pick };
  }, [lens, mapMode, labels, reducedMotion, isMobile, handlers]);
  const lensBase = useMemo(() => (lensInput ? buildLensBaseLayers(lensInput) : []), [lensInput]);
  const lensAnimating = !!lensInput && policy.ambient && lensNeedsFrame(lensInput, { clockPlaying });

  // Label sources for the lenses that draw labels (memoised on model + selection).
  const labelInputs = useMemo<PlaceInput | null>(() => {
    if (!lens || mapMode === 'heatmap') return null;
    const ops = lens.layers.operations ? lens.operations : null;
    const host = lens.layers.hosting ? lens.hosting : null;
    const actors = lens.layers.actors ? lens.actors : null;
    if (!ops && !host && !actors) return null;
    const edges = ops ? edgeLabelSources(ops, highlightGroup(ops, lens.sel.opId) ?? '') : [];
    const hosts = host ? hostLabelSources(host, lens.sel.providerId ?? '') : [];
    const maxT = ops ? opsMaxThreats(ops) : 0;
    const actorLabels = actors && !actors.empty ? actorLabelSources(actors) : [];
    const nodes = [
      ...(ops ? ops.nodes.map(n => ({ position: n.position, radiusPx: opNodePx(n, maxT) })) : []),
      ...(host ? host.rings.map(r => ({ position: r.position, radiusPx: r.radiusPx, id: r.id })) : []),
      ...actorLabels.map(a => ({ position: a.position, radiusPx: a.radiusPx, id: a.id })),
    ];
    return { edges, hosts, actors: actorLabels, nodes };
  }, [lens, mapMode]);

  const recomputeLabels = useCallback(() => {
    const map = mapRef.current;
    if (!map || !labelInputs || size.width === 0) {
      setLabels(prev => (prev === NO_LABELS ? prev : NO_LABELS));
      return;
    }
    const project: Project = ([lng, lat]) => {
      const p = map.project([lng, lat]);
      return Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null;
    };
    const next = placeLensLabels(labelInputs, project, size);
    setLabels(prev => stablePlacement(prev, next));
  }, [labelInputs, size]);
  useEffect(() => { if (mapLoaded) recomputeLabels(); }, [mapLoaded, recomputeLabels]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    map.on('moveend', recomputeLabels);
    return () => { map.off('moveend', recomputeLabels); };
  }, [mapLoaded, recomputeLabels]);

  // Movement departures / landings: their own ring pool, fed by the replay clock like the particles.
  const movementOn = !!lensInput && lensInput.layers.movement && !!lensInput.movement && lensInput.movement.ringEvents.length > 0 && policy.ambient;
  const [moveBuffer] = useState(() => new RingBuffer(128));
  const moveSpawner = useMemo(() => new ImpactRingSpawner(moveBuffer, { duration: 2.2, cooldown: 0.2, maxPerFrame: 4 }), [moveBuffer]);
  const moveScheduler = useMemo(
    () => new ArrivalScheduler(lensInput?.movement?.ringEvents ?? [], CYCLE_LENGTH),
    [lensInput?.movement],
  );
  useEffect(() => { moveBuffer.clear(); moveSpawner.reset(); }, [moveScheduler, moveBuffer, moveSpawner]);

  // Live pings: sonar rings at the origin of newly-arrived threats, in their own colour.
  const [pingBuffer] = useState(() => new RingBuffer(64));
  const pingSpawner = useMemo(() => new ImpactRingSpawner(pingBuffer, { duration: 2.4, cooldown: 0.8, maxPerFrame: 4, alpha: 240 }), [pingBuffer]);
  /** Reduced motion: a brief, non-expanding highlight instead of the sonar ring. */
  const [staticPings, setStaticPings] = useState<Array<{ id: string; position: [number, number]; color: [number, number, number, number] }>>([]);

  const makeRingLayer = useCallback((id: string, buffer: RingBuffer, radiusPx: number, width: number, animTime: number) =>
    new ScatterplotLayer<number, RingExtensionProps<number>>({
      id,
      ...ringBufferLayerProps(buffer),
      getRadius: radiusPx,
      radiusUnits: 'pixels',
      stroked: true,
      filled: false,
      lineWidthUnits: 'pixels',
      getLineWidth: width,
      pickable: false,
      extensions: RING_EXT,
      ringFrom: 0.1,
      ringTo: 1,
      animTime,
    }), []);

  // ─── Scene cross-fade (lens / option change) ──────────────
  const lastSceneRef = useRef<Layer[]>([]);
  const outgoingRef = useRef<Layer[]>([]);
  const fadeStartRef = useRef<number | null>(null);
  const sceneKeyRef = useRef(sceneKey);
  const [fading, setFading] = useState(false);
  if (sceneKeyRef.current !== sceneKey) {
    // Render-phase on purpose: the outgoing scene must be captured BEFORE the new layers are composed.
    sceneKeyRef.current = sceneKey;
    if (!reducedMotion) {
      outgoingRef.current = lastSceneRef.current;
      fadeStartRef.current = typeof performance !== 'undefined' ? performance.now() : 0;
    }
  }
  useEffect(() => {
    if (reducedMotion || fadeStartRef.current === null) return;
    setFading(true);
    const timer = setTimeout(() => { setFading(false); outgoingRef.current = []; }, LENS_FADE_IN_MS + 60);
    return () => clearTimeout(timer);
  }, [sceneKey, reducedMotion]);

  /** Latest animation seconds, so non-frame pushes (data changes) stay in phase. */
  const animSecondsRef = useRef(0);
  const compose = useCallback((seconds: number, t: number): Layer[] => {
    const layers: Layer[] = [...lensBase, ...makeGlow(seconds), ...staticLayers];
    if (lensInput) layers.push(...buildLensLayers(lensInput, { seconds, t }));
    if (particlesOn) layers.push(makeTrips(t));
    if (ringsOn) layers.push(makeRings(seconds));
    if (movementOn) layers.push(makeRingLayer('movement-rings', moveBuffer, 26, 1.5, seconds));
    if (mapMode === 'global') layers.push(makeRingLayer('live-pings', pingBuffer, isMobile ? 26 : 34, 2, seconds));
    // Reduced-motion stand-in for the sonar ring: only where pings exist at all (the Threats scene).
    if (staticPings.length > 0 && reducedMotion && mapMode === 'global') {
      layers.push(new ScatterplotLayer<{ id: string; position: [number, number]; color: [number, number, number, number] }>({
        id: 'live-pings-static',
        data: staticPings,
        getPosition: d => d.position,
        getLineColor: d => d.color,
        getRadius: 16,
        radiusUnits: 'pixels',
        stroked: true,
        filled: false,
        lineWidthUnits: 'pixels',
        getLineWidth: 2,
        pickable: false,
      }));
    }
    lastSceneRef.current = layers;
    const fade = lensFade(typeof performance !== 'undefined' ? performance.now() : 0, fadeStartRef.current, reducedMotion);
    if (!fade.active) return layers;
    // Cross-fade: layers that are NEW in this scene ease in, layers that are GONE (kept ~200ms) ease out.
    // Layers in both scenes are left alone, so nothing flashes or draws doubled. `clone` keeps data identity.
    const outgoing = outgoingRef.current;
    const split = splitFade(layers.map(l => l.id), outgoing.map(l => l.id));
    const easeIn = new Set(split.fadeIn);
    const mixed = layers.map(l => (easeIn.has(l.id) ? l.clone({ opacity: fade.incoming }) : l));
    if (fade.outgoing > 0) {
      const easeOut = new Set(split.fadeOut);
      for (const l of outgoing) if (easeOut.has(l.id)) mixed.push(l.clone({ id: `out:${l.id}`, opacity: fade.outgoing, pickable: false }));
    }
    return mixed;
  }, [lensBase, lensInput, makeGlow, staticLayers, particlesOn, makeTrips, ringsOn, makeRings, movementOn, makeRingLayer, moveBuffer, pingBuffer, isMobile, mapMode, staticPings, reducedMotion]);

  // ─── Push layers to deck (data / style changes, and the static frame) ──
  useEffect(() => {
    const map = mapRef.current;
    if (!mapLoaded || !map) return;
    const layers = compose(animSecondsRef.current, clock.currentTime);
    if (deckRef.current) {
      deckRef.current.setProps({ layers, onClick: handlers.clickEmpty, pickingRadius: isMobile ? PICK_RADIUS_TOUCH : PICK_RADIUS_FINE });
    } else if (layers.length > 0) {
      const overlay = new MapboxOverlay({ interleaved: false, layers, onClick: handlers.clickEmpty, pickingRadius: isMobile ? PICK_RADIUS_TOUCH : PICK_RADIUS_FINE });
      map.addControl(overlay as unknown as maplibregl.IControl);
      deckRef.current = overlay;
    }
    // seekVersion: a scrub while the loop is stopped still repaints the new playhead.
  }, [mapLoaded, compose, clock, handlers, isMobile, seekVersion]);

  // The loop is held open for a while after anything that spawns rings, so they can finish expanding
  // even when nothing else needs frames (replay paused, no breathing nodes).
  const [hold, setHold] = useState(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdLoop = useCallback(() => {
    setHold(true);
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = setTimeout(() => { holdTimer.current = null; setHold(false); }, LOOP_HOLD_MS);
  }, []);
  useEffect(() => () => { if (holdTimer.current) clearTimeout(holdTimer.current); }, []);
  // Nothing animates under reduced motion (no rings, no pulses): don't spin the loop for the hold window.
  useEffect(() => { if (!reducedMotion) holdLoop(); }, [clockPlaying, holdLoop, reducedMotion]);

  // New pings: spawn once per batch.
  const lastPingSeq = useRef(0);
  useEffect(() => {
    if (!pings || pings.seq === lastPingSeq.current) return;
    lastPingSeq.current = pings.seq;
    const placed = pings.items.filter((p): p is PingItem & { position: [number, number] } => p.position !== null);
    if (placed.length === 0 || mapMode !== 'global') return;
    if (reducedMotion) {
      setStaticPings(placed.map(p => ({ id: p.id, position: p.position, color: PING_COLOR })));
      const timer = setTimeout(() => setStaticPings([]), 1600);
      // A scene / motion-preference change must not strand the highlight on screen.
      return () => { clearTimeout(timer); setStaticPings([]); };
    }
    pingSpawner.spawn(
      placed.map(p => ({ time: 0, lng: p.position[0], lat: p.position[1], color: PING_COLOR, key: `${p.position[0].toFixed(2)},${p.position[1].toFixed(2)}` })),
      animSecondsRef.current,
    );
    // The loop may be idle (replay paused, no breathing nodes): keep it up long enough for the ring.
    holdLoop();
  }, [pings, pingSpawner, reducedMotion, mapMode, holdLoop]);

  // ─── The one animation loop ───────────────────────────────
  const prevPlayheadRef = useRef<number | null>(null);
  const arrivalsScratch = useRef<ArrivalEvent[]>([]);
  const moveScratch = useRef<ArrivalEvent[]>([]);
  const onFrame = useCallback((t: number, frame: { seconds: number; dt: number }) => {
    animSecondsRef.current = frame.seconds;
    latest.current.onPlayhead?.(t);
    const overlay = deckRef.current;
    if (!overlay) return;
    if (ringsOn || movementOn) {
      const prev = frame.dt > 0 ? prevPlayheadRef.current : null; // first frame after (re)start has no baseline
      prevPlayheadRef.current = t;
      if (prev !== null) {
        if (ringsOn) {
          const arrivals = arrivalsScratch.current;
          arrivals.length = 0;
          scheduler.collect(prev, t, arrivals);
          if (arrivals.length > 0) spawner.spawn(arrivals, frame.seconds);
        }
        if (movementOn) {
          const moves = moveScratch.current;
          moves.length = 0;
          moveScheduler.collect(prev, t, moves);
          if (moves.length > 0) moveSpawner.spawn(moves, frame.seconds);
        }
      }
    }
    overlay.setProps({ layers: compose(frame.seconds, t) });
  }, [ringsOn, movementOn, scheduler, spawner, moveScheduler, moveSpawner, compose]);

  const needsLoop = loopNeeded({
    particles: particlesOn, movementRings: movementOn, clockPlaying, breathing: pulseOn, lensMotion: lensAnimating, fading, hold,
  });
  useDeckFrame(clock, mapLoaded && needsLoop, onFrame, { targetRef: rootRef });

  // ─── Camera: frame ALL of the target in the area the overlays leave free ──
  const focusId = focus?.id ?? null;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded || !focus) return;
    const plan = planCamera(focus.points, size, latest.current.cameraInsets);
    if (!plan) return; // nothing placeable: select without moving the camera
    const cam = map.cameraForBounds(
      [[plan.box.west, plan.box.south], [plan.box.east, plan.box.north]],
      { padding: plan.padding, maxZoom: plan.maxZoom },
    );
    if (!cam) return;
    const target = { center: cam.center, zoom: cam.zoom, bearing: cam.bearing ?? 0 };
    if (reducedMotion || focus.instant) map.jumpTo(target);
    else map.flyTo({ ...target, duration: FLY_MS, curve: FLY_CURVE, essential: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires once per request id
  }, [focusId, mapLoaded]);

  return (
    <div ref={rootRef} className="relative w-full h-full">
      <div ref={mapContainerRef} className="absolute inset-0" />

      {tileIssue && (
        <div
          role="status"
          className="absolute left-1/2 -translate-x-1/2 px-3 py-1 rounded-full font-mono text-[10px] pointer-events-none"
          style={{ top: isMobile ? 156 : 96, background: 'var(--bg-card-deep)', border: '1px solid var(--border-base)', color: 'var(--text-tertiary)', zIndex: 30 }}
        >
          Some map tiles are loading slowly
        </div>
      )}

      {tooltip && (!selection || tooltip.lens) && (
        <div
          className="absolute z-50 pointer-events-none rounded-lg px-3 py-2 text-xs max-w-xs"
          style={{
            ...clampCardPosition({ x: tooltip.x, y: tooltip.y }, { width: 260, height: 110 }, { width: size.width, height: size.height }, 4, 10),
            background: 'var(--bg-card-deep)',
            border: '1px solid var(--border-base)',
            backdropFilter: 'blur(12px)',
          }}
        >
          {tooltip.threat && (
            <>
              <div className="font-mono font-bold" style={{ color: 'var(--text-primary)' }}>
                {tooltip.threat.threat_count} threats
              </div>
              <div style={{ color: 'var(--text-tertiary)' }} className="mt-1">
                <span className="capitalize">{typeLabel(tooltip.threat.top_threat_type) || 'Mixed'}</span>
                {tooltip.threat.top_severity && (
                  <>
                    {' · '}
                    <span className="uppercase" style={{ color: sevText(tooltip.threat.top_severity) }}>
                      {tooltip.threat.top_severity}
                    </span>
                  </>
                )}
              </div>
              {tooltip.threat.country_code && (
                <div className="mt-0.5" style={{ color: 'var(--text-muted)' }}>{tooltip.threat.country_code}</div>
              )}
              <div className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                C:{tooltip.threat.critical} H:{tooltip.threat.high} M:{tooltip.threat.medium} L:{tooltip.threat.low}
              </div>
              <div className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>Click for details</div>
            </>
          )}
          {tooltip.lens && (
            <>
              <div className="font-mono font-bold" style={{ color: 'var(--text-primary)' }}>{tooltip.lens.title}</div>
              {tooltip.lens.lines.map((line, i) => (
                <div key={i} className="mt-0.5" style={{ color: i === 0 ? 'var(--text-tertiary)' : 'var(--text-muted)' }}>{line}</div>
              ))}
              {mapMode !== 'bot_density' && <div className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>Click for details</div>}
            </>
          )}
          {tooltip.arc && (
            <>
              <div className="font-mono font-bold capitalize" style={{ color: 'var(--text-primary)' }}>
                {typeLabel(tooltip.arc.threat_type)}
              </div>
              <div className="mt-1" style={{ color: 'var(--text-tertiary)' }}>
                {tooltip.arc.volume} threat{tooltip.arc.volume === 1 ? '' : 's'}
              </div>
              {tooltip.arc.brand_name && (
                <div className="mt-1" style={{ color: 'var(--amber-text)' }}>Target: {tooltip.arc.brand_name}</div>
              )}
              {tooltip.arc.source_region && (
                <div className="mt-0.5" style={{ color: 'var(--text-muted)' }}>From: {tooltip.arc.source_region}</div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
