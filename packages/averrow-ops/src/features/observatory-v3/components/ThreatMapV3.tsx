/**
 * ThreatMapV3 — GPU-driven particle animation via deck.gl TripsLayer.
 *
 * Design notes:
 *   - Particles use TripsLayer with a single `currentTime` uniform driven by a
 *     frame-rate-independent AnimationClock (lib/animation-clock.ts).
 *   - MapboxOverlay runs in overlaid mode (interleaved=false) on the FLAT map so
 *     particle redraws don't force basemap redraws. On the GLOBE it is interleaved
 *     (lib/projection.ts): deck then draws in MapLibre's own GL context, which is what
 *     gives the sphere its horizon clipping and depth. The overlay is rebuilt when the
 *     projection changes (interleaving is a constructor-time choice).
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
  buildTripData, arcPathFor, periodToMs, trailLengthFor, CYCLE_LENGTH,
  type TripDatum,
} from '../lib/trips';
import { AnimationClock } from '../lib/animation-clock';
import { classifyMapError, type MapErrorLike } from '../lib/map-errors';
import { hasValidPoint, hasValidArc, centerLngForFreeArea } from '../lib/geo';
import { usePrefersReducedMotion } from '../lib/use-motion';
import {
  effectiveProjection, globeCanvasBox, globeFitZoom, globeLabelOpacity, globeOverlayProps, maxZoomFor, overlayInterleaved, projectionSpec,
  FLAT_SKY, GLOBE_BACKDROP, GLOBE_SKY, type OcclusionProbe, type Projection,
} from '../lib/projection';
import { useIdleSpin, SPIN_EVENT_KEY } from '../lib/use-idle-spin';
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
  planCamera, phoneMinZoom, setLatRange, DEFAULT_MIN_ZOOM, WORLD_LAT_LIMIT, PHONE_LAT_LIMIT, FLY_MS, FLY_CURVE, NO_INSETS, type Insets,
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
export type LensMapProps = Omit<LensLayerInput, 'reducedMotion' | 'isMobile' | 'pick' | 'labels' | 'projection'>;

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
  /**
   * Requested projection (default flat). The map draws `effectiveProjection(projection, mapMode)`:
   * the density heatmap has no globe variant and stays flat.
   */
  projection?: Projection;
  /** Quiet time (ms) before the globe starts to drift; defaults to SPIN_IDLE_MS (tests and kiosks override it). */
  spinIdleMs?: number;
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

// ─── Overlay lifecycle ──────────────────────────────────────

/** The two ways the deck.gl overlay is attached: a separate canvas over the flat map, or interleaved into the globe's GL context. */
type OverlayKind = 'flat' | 'globe';
type OverlaySlots = Record<OverlayKind, MapboxOverlay | null>;

/**
 * Release a canvas's WebGL context NOW instead of waiting for GC. ONLY ever call this on a canvas an overlay
 * owns: never the map's own canvas (the interleaved overlay draws into that).
 */
export function releaseOwnedGl(canvas: HTMLCanvasElement | null | undefined): void {
  if (!canvas) return;
  try {
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGL2RenderingContext | WebGLRenderingContext | null;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch { /* context already gone, or a canvas without WebGL */ }
  try { canvas.remove(); } catch { /* detached */ }
}

/** Remove and finalize an overlay for good (map unmount); a separate-canvas overlay also gives its GL context back. */
function disposeOverlay(map: maplibregl.Map, overlay: MapboxOverlay, kind: OverlayKind): void {
  let ownCanvas: HTMLCanvasElement | null = null;
  if (kind === 'flat') {
    try { ownCanvas = overlay.getCanvas(); } catch { /* never attached */ }
  }
  try { map.removeControl(overlay as unknown as maplibregl.IControl); } catch { /* already removed */ }
  try { overlay.finalize(); } catch { /* already finalized */ }
  releaseOwnedGl(ownCanvas);
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
  mapMode, projection: requestedProjection = 'flat', spinIdleMs, period, heatmapData: heatmapIn = EMPTY_HEAT, replayNowMs,
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

  const projection = effectiveProjection(requestedProjection, mapMode);
  const isGlobe = projection === 'globe';
  const projectionRef = useRef(projection);
  projectionRef.current = projection;
  /**
   * The deck.gl overlays, one per kind, built lazily and then PARKED (layers emptied) when the other kind is active,
   * never finalized until the map goes. Interleaving is a constructor-time choice, so a flip needs the other kind, but
   * destroying and re-creating them leaks: deck.gl 9.2 / luma.gl 9.2 leave per-instance residue that a finalize does not
   * clear (heap-snapshot verified, 10 flat <-> globe round trips = 12 live WebGL contexts and ~1 MB of retained heap per trip):
   *   - luma's CanvasContext registers an anonymous one-shot `matchMedia('(resolution: ...)')` listener that `destroy()`
   *     never removes, which keeps the whole device + its canvas (+ that GL context) reachable;
   *   - `getDeckInstance` registers an anonymous `map.on('render')` closure over the deck that `removeDeckInstance` never
   *     removes (so a finalized globe deck, its layers and accessors stay referenced by the map).
   * Creating each kind at most once per map bounds both to one instance each.
   */
  const overlaysRef = useRef<OverlaySlots>({ flat: null, globe: null });
  /** Whether the ACTIVE overlay is the interleaved (globe) one. */
  const overlayInterleavedRef = useRef(false);
  /**
   * True only while the map-click path below invokes the layers' own `onClick` handlers. On the globe (interleaved
   * deck) deck's native tap recogniser is NOT trusted to deliver a click (see `onMapClick`), so a click that
   * arrives through it is ignored and the one from `map.on('click')` is the only one acted on.
   */
  const dispatchingClickRef = useRef(false);

  const [ownClock] = useState(() => new AnimationClock({ cycleLength: CYCLE_LENGTH }));
  const clock = clockProp ?? ownClock;

  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null);
  /** Country code of the pinned bot-share tooltip, if any. */
  const pinnedRef = useRef<string | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [tileIssue, setTileIssue] = useState(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  // Globe: the canvas is the area the chrome leaves free, so the planet is centred in it (see globeCanvasBox).
  const box = globeCanvasBox({ left: cameraInsets.left, right: cameraInsets.right }, projection);
  /** The map canvas's own size (equals `size` on the flat map). */
  const canvasSize = useMemo(
    () => (box.left === 0 && box.right === 0 ? size : { width: Math.max(0, size.width - box.left - box.right), height: size.height }),
    [size, box.left, box.right],
  );

  // Stable handler bag: layers close over THIS, never over props, so a parent
  // re-render (e.g. onSelect identity) can't invalidate the layer set.
  const latest = useRef({ onSelect, controlRightInset, cameraInsets, onLensPick, onPlayhead, lens, mapMode, canvas: { width: 0, height: 0 } });
  latest.current = { onSelect, controlRightInset, cameraInsets, onLensPick, onPlayhead, lens, mapMode, canvas: canvasSize };
  /** A click deck.gl delivered itself while the interleaved (globe) overlay is up: dropped, `onMapClick` owns clicks there. */
  const deckNativeClick = useCallback(() => overlayInterleavedRef.current && !dispatchingClickRef.current, []);
  const handlers = useMemo(() => ({
    hover: (info: Pick<ThreatPoint>) => setTooltip(info.object ? { x: info.x, y: info.y, threat: info.object } : null),
    hoverArc: (info: Pick<ArcData>) => setTooltip(info.object ? { x: info.x, y: info.y, arc: info.object } : null),
    clickNode: (info: Pick<ThreatPoint>) => {
      if (deckNativeClick()) return true;
      if (!info.object) return false;
      const sel: MapSelection = { kind: 'node', node: info.object };
      setTooltip(null);
      latest.current.onSelect?.(sel);
      return true;
    },
    clickArc: (info: Pick<ArcData>) => {
      if (deckNativeClick()) return true;
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
      if (deckNativeClick()) return true;
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
      if (deckNativeClick()) return;
      if (info.object) return;
      pinnedRef.current = null;
      setTooltip(null);
      latest.current.onSelect?.(null);
    },
  }), [deckNativeClick]);

  // Keep the zoom control clear of the panel overlaying the map's right edge.
  const applyControlInset = useCallback(() => {
    const ctrl = mapContainerRef.current?.querySelector<HTMLElement>('.maplibregl-ctrl-bottom-right');
    // On the globe the canvas already ends where the panel starts.
    if (ctrl) ctrl.style.right = projectionRef.current === 'globe' ? '0px' : `${latest.current.controlRightInset}px`;
  }, []);
  useEffect(applyControlInset, [controlRightInset, projection, applyControlInset]);
  // The canvas box changed (panel opened, globe on / off): the GL canvas must follow.
  useEffect(() => { mapRef.current?.resize(); }, [box.left, box.right]);

  // ─── Map initialization (once per mount; retry remounts) ──
  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container || mapRef.current) return;

    let map: maplibregl.Map;
    try {
      const ins = latest.current.cameraInsets;
      const globeStart = projectionRef.current === 'globe';
      map = new maplibregl.Map({
        container,
        style: MAP_STYLE,
        center: globeStart
          ? [15, 18]
          : isMobileRef.current
            ? [-30, 30]
            : [centerLngForFreeArea(10, ins.left, ins.right, 2.2), 25],
        zoom: globeStart
          ? globeFitZoom(container.clientWidth, container.clientHeight)
          : isMobileRef.current ? 0.6 : 2.2,
        pitch: isMobileRef.current || globeStart ? 0 : 20,
        bearing: 0,
        minZoom: isMobileRef.current ? phoneMinZoom(container.clientWidth) : undefined,
        maxZoom: maxZoomFor(projectionRef.current),
        canvasContextAttributes: { antialias: true },
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
      const slots = overlaysRef.current;
      overlaysRef.current = { flat: null, globe: null };
      deckRef.current = null;
      navControlRef.current = null;
      if (slots.globe) disposeOverlay(map, slots.globe, 'globe');
      if (slots.flat) disposeOverlay(map, slots.flat, 'flat');
      overlayInterleavedRef.current = false;
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
    setLatRange(map.transform, lat);
    // The globe needs no wide-world floor: one planet fits at `globeFitZoom`, and a little less is plenty.
    const floor = isGlobe
      ? Math.max(0, globeFitZoom(canvasSize.width, canvasSize.height) - 0.9)
      : isMobile ? phoneMinZoom(size.width) : DEFAULT_MIN_ZOOM;
    if (typeof map.setMinZoom === 'function') map.setMinZoom(floor);
  }, [isMobile, mapLoaded, size.width, canvasSize.width, canvasSize.height, isGlobe]);

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
    () => buildTripData(geoArcs, colorBy, isMobile, periodToMs(period), replayNowMs, projection),
    [geoArcs, colorBy, isMobile, period, replayNowMs, projection],
  );

  const selectedNode = selection?.kind === 'node' ? selection.node : null;
  const selectedArc = selection?.kind === 'arc' ? selection.arc : null;
  const selectedNodeId = selectedNode ? nodeKey(selectedNode) : null;
  const selectedArcId = selectedArc ? arcKey(selectedArc) : null;

  // ─── Static layers (rebuilt only when their data / style inputs change) ──
  const staticLayers = useMemo(() => {
    const layers: Layer[] = [];
    // The flat map draws the bezier corridor; the globe draws the true great circle, lifted off the surface.
    const arcPath = (d: ArcData) => arcPathFor(d, projection);

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
            getPath: arcPath,
            getColor: d => getArcColor(d, colorBy, 51 * lift),
            getWidth: beamWidth,
            widthUnits: 'pixels',
            widthMinPixels: isMobile ? 2 : 1,
            widthMaxPixels: isMobile ? 4 : 2,
            updateTriggers: { getColor: [colorBy, lift], getPath: projection },
          }),
          new PathLayer<ArcData>({
            id: 'beam-core',
            data: geoArcs,
            getPath: arcPath,
            getColor: d => getArcColor(d, colorBy, 76 * lift),
            getWidth: beamWidth,
            widthUnits: 'pixels',
            widthMinPixels: isMobile ? 2 : 1,
            widthMaxPixels: isMobile ? 3 : 1,
            updateTriggers: { getColor: [colorBy, lift], getPath: projection },
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
          getPath: arcPath,
          updateTriggers: { getPath: projection },
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
    isMobile, handlers, selectedNodeId, selectedArcId, projection,
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
    return { ...lens, labels, reducedMotion, isMobile, pick, projection };
  }, [lens, mapMode, labels, reducedMotion, isMobile, handlers, projection]);
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
    if (!map || !labelInputs || canvasSize.width === 0) {
      setLabels(prev => (prev === NO_LABELS ? prev : NO_LABELS));
      return;
    }
    // On the globe `project` also answers for points on the far side (behind the planet): they are not placeable.
    // MapLibre's own occlusion test decides that (right at any pitch); labels also thin out toward the limb.
    const centre = map.getCenter();
    const globe = projectionRef.current === 'globe';
    const transform = (map as unknown as { transform?: OcclusionProbe }).transform;
    const project: Project = ([lng, lat]) => {
      let fade = 1;
      if (globe) {
        fade = globeLabelOpacity([centre.lng, centre.lat], [lng, lat], transform);
        if (fade <= 0) return null;
      }
      const p = map.project([lng, lat]);
      return Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y, fade } : null;
    };
    const next = placeLensLabels(labelInputs, project, canvasSize);
    setLabels(prev => stablePlacement(prev, next));
  }, [labelInputs, canvasSize]);
  /** The latest placement, for callbacks that outlive a render (the post-flip `idle` handler). */
  const recomputeLabelsRef = useRef(recomputeLabels);
  recomputeLabelsRef.current = recomputeLabels;
  useEffect(() => { if (mapLoaded) recomputeLabels(); }, [mapLoaded, recomputeLabels]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    // The idle spin's own moves are tagged: it refreshes labels on a throttle instead of every frame.
    const onEnd = (e: { [key: string]: unknown }) => { if (!e[SPIN_EVENT_KEY]) recomputeLabels(); };
    map.on('moveend', onEnd);
    return () => { map.off('moveend', onEnd); };
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

  // ─── Projection: flat <-> globe ───────────────────────────
  // Declared BEFORE the overlay effect: the overlay reads the map's projection when it is built.
  const appliedProjection = useRef<Projection | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    const prev = appliedProjection.current;
    if (prev === projection) return;
    appliedProjection.current = projection;
    // First run on the flat map: nothing to change, the map is built flat.
    if (prev === null && projection === 'flat') return;
    map.setProjection(projectionSpec(projection));
    map.setMaxZoom(maxZoomFor(projection));
    if (projection === 'globe') map.setSky(GLOBE_SKY);
    else map.setSky(FLAT_SKY);
    if (prev !== null) {
      // A flip re-frames the world: the globe fits the planet in the canvas, the flat map returns to its overview.
      const c = map.getCenter();
      if (projection === 'globe') {
        const fit = latest.current.canvas;
        map.jumpTo({ center: [c.lng, Math.max(-45, Math.min(45, c.lat))], zoom: globeFitZoom(fit.width, fit.height), pitch: 0, bearing: 0 });
      } else {
        map.jumpTo({ center: [c.lng, Math.max(-50, Math.min(50, c.lat))], zoom: isMobileRef.current ? 0.6 : 2.2, pitch: isMobileRef.current ? 0 : 20, bearing: 0 });
      }
    }
    // Screen-space labels were placed under the previous projection: place them again once the new one has drawn.
    map.once('idle', () => recomputeLabelsRef.current());
  }, [projection, mapLoaded]);

  // ─── Push layers to deck (data / style changes, and the static frame) ──
  useEffect(() => {
    const map = mapRef.current;
    if (!mapLoaded || !map) return;
    const layers = compose(animSecondsRef.current, clock.currentTime);
    const kind: OverlayKind = overlayInterleaved(projection) ? 'globe' : 'flat';
    const slots = overlaysRef.current;
    const pickingRadius = isMobile ? PICK_RADIUS_TOUCH : PICK_RADIUS_FINE;
    // The other kind is parked, not destroyed (see overlaysRef): empty, and with no handler of its own.
    const parked = slots[kind === 'globe' ? 'flat' : 'globe'];
    if (parked && deckRef.current === parked) {
      parked.setProps({ layers: [], onClick: undefined });
      deckRef.current = null;
    }
    let overlay = slots[kind];
    if (overlay) {
      overlay.setProps({ layers, onClick: handlers.clickEmpty, pickingRadius });
    } else if (layers.length > 0) {
      const interleaved = kind === 'globe';
      overlay = new MapboxOverlay({
        interleaved,
        ...(interleaved ? globeOverlayProps() : {}),
        layers, onClick: handlers.clickEmpty, pickingRadius });
      map.addControl(overlay as unknown as maplibregl.IControl);
      slots[kind] = overlay;
    }
    deckRef.current = overlay;
    overlayInterleavedRef.current = kind === 'globe';
    // seekVersion: a scrub while the loop is stopped still repaints the new playhead.
  }, [mapLoaded, compose, clock, handlers, isMobile, seekVersion, projection]);

  // Globe clicks. On the flat map deck's overlay is fed by MapLibre's own mouse events, so a click is a MapLibre
  // `click` (any press length, small movement tolerance). The INTERLEAVED overlay listens to the canvas itself
  // (mjolnir.js), whose tap recogniser gives up after 250 ms and resolves the target from the last hover pick, so a long
  // press or a hover-then-click on a still pointer selected nothing. Route the globe through the same MapLibre `click`
  // and pick at the click point, then run the same handlers deck would (layer first; the empty-map handler when no layer
  // takes it), so a selection is identical in both modes. deck's own deliveries are dropped meanwhile (deckNativeClick).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    const onMapClick = (e: maplibregl.MapMouseEvent) => {
      const overlay = deckRef.current;
      if (!overlay || !overlayInterleavedRef.current) return;
      let info: PickingInfo | null = null;
      try {
        info = overlay.pickObject({ x: e.point.x, y: e.point.y, radius: isMobileRef.current ? PICK_RADIUS_TOUCH : PICK_RADIUS_FINE });
      } catch { /* deck not ready: treated as an empty click */ }
      dispatchingClickRef.current = true;
      try {
        const layer = info?.layer;
        const layerHandler = layer && (layer.onClick ?? layer.props.onClick);
        const handled = !!(info && layerHandler && layerHandler.call(layer, info, { srcEvent: e.originalEvent } as never));
        if (!handled) handlers.clickEmpty(info ?? ({ object: null } as PickingInfo));
      } finally {
        dispatchingClickRef.current = false;
      }
    };
    map.on('click', onMapClick);
    return () => { map.off('click', onMapClick); };
  }, [mapLoaded, handlers]);

  // Idle spin (globe only): drifts when nobody is interacting; stops on any input. Held while anything is selected.
  const lensSelected = !!lens && Object.values(lens.sel).some(Boolean);
  const { poke: pokeSpin } = useIdleSpin({
    mapRef, targetRef: rootRef, projection, ready: mapLoaded, reducedMotion,
    held: selection !== null || lensSelected, idleMs: spinIdleMs, onDrift: recomputeLabels,
  });

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
    pokeSpin(); // a requested camera move is an interaction: the globe waits before drifting again
    // On the globe the canvas already excludes the left / right chrome: only top and bottom remain as insets.
    const ci = latest.current.cameraInsets;
    const globeNow = projectionRef.current === 'globe';
    const plan = planCamera(focus.points, latest.current.canvas, globeNow ? { ...ci, left: 0, right: 0 } : ci);
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
    <div ref={rootRef} className="relative w-full h-full" style={isGlobe ? { background: GLOBE_BACKDROP } : undefined}>
      <div
        ref={mapContainerRef}
        className="absolute inset-y-0"
        data-projection={projection}
        style={{ left: box.left, right: box.right }}
      />

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
            // Pointer coordinates are the canvas's: on the globe the canvas starts `box.left` into this box.
            ...clampCardPosition({ x: tooltip.x + box.left, y: tooltip.y }, { width: 260, height: 110 }, { width: size.width, height: size.height }, 4, 10),
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
