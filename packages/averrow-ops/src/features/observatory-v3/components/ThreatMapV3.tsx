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
 *     trails (TripsLayer currentTime), node heartbeats (PulseExtension) and
 *     impact rings (RingExtension). Per frame only uniforms change; attributes
 *     are re-read only when data changes or a ring is spawned. It runs only
 *     while something is animating, the tab is visible, the map is on screen,
 *     and the user hasn't asked for reduced motion (then: static, no rings).
 *   - Only FATAL errors (base style failed, WebGL context lost) replace the
 *     map; tile/source hiccups leave it up. Retry re-initialises the map.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { ScatterplotLayer, PathLayer } from '@deck.gl/layers';
import { HeatmapLayer } from '@deck.gl/aggregation-layers';
import type { Layer, PickingInfo } from '@deck.gl/core';
import { useTheme } from '@/design-system/hooks';
import { TripsLayer } from '@/lib/trips-layer';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import type { ThreatPoint, ArcData, HeatmapPoint } from '@/hooks/useObservatory';
import {
  botColor, botRadius, botDensityDomain, botDensityTooltip, isAboveAverage,
  resolveScaleStops, RING_COLOR, OUTLINE_COLOR,
  type BotDensityPoint,
} from '../lib/bot-density';
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
import { hasValidPoint, hasValidArc } from '../lib/geo';
import { usePrefersReducedMotion } from '../lib/use-motion';
import {
  useDeckFrame, PulseExtension, RingExtension, RingBuffer, ringBufferLayerProps, ImpactRingSpawner,
  ArrivalScheduler, buildArrivalEvents, phaseForKey, pulseRateForSeverity, pulseAmpForSeverity,
  type PulseExtensionProps, type RingExtensionProps, type ArrivalEvent,
} from '../anim';
import {
  selectionKey, selectionLngLat, type MapSelection,
} from '../lib/selection';
import { nodeKey, arcKey, type MapMode } from '../lib/url-state';
import { MapDetailCard } from './MapDetailCard';

export type { MapMode } from '../lib/url-state';

// ─── Types ──────────────────────────────────────────────────
interface TooltipInfo {
  x: number;
  y: number;
  threat?: ThreatPoint;
  arc?: ArcData;
  bot?: BotDensityPoint;
}

type Pick<T> = PickingInfo<T>;

const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
/** Pointer-pick tolerance in px: nodes render as 1.5-9px dots, far below a usable hit target. */
const PICK_RADIUS_FINE = 8;
const PICK_RADIUS_TOUCH = 16;
const EMPTY_THREATS: ThreatPoint[] = [];
const EMPTY_ARCS: ArcData[] = [];
const EMPTY_HEAT: HeatmapPoint[] = [];

// Extensions are stateless; share one instance so deck's extension diff is trivially equal.
const PULSE_EXT = [new PulseExtension()];
const RING_EXT = [new RingExtension()];

// Node heartbeat accessors (module-level => stable identity across the per-frame layer rebuild).
// Nodes in the same country + threat type share a phase: a synchronised heartbeat per "operation".
const nodePhase = (d: ThreatPoint) => phaseForKey(`${d.country_code ?? ''}|${d.top_threat_type ?? ''}`);
const nodeRate = (d: ThreatPoint) => pulseRateForSeverity(d.top_severity);
const nodeAmp = (d: ThreatPoint) => pulseAmpForSeverity(d.top_severity);
const noAmp = () => 0;
const bloomRadius = (d: ThreatPoint) => Math.sqrt(Math.max(1, d.threat_count)) * 5400;
const glowRadius = (d: ThreatPoint) => Math.sqrt(Math.max(1, d.threat_count)) * 2900;
const bloomColor = (d: ThreatPoint) => getSeverityColor(d.top_severity || 'low', 6);
const glowColor = (d: ThreatPoint) => getSeverityColor(d.top_severity || 'low', 12);
const nodePosition = (d: ThreatPoint): [number, number] => [d.lng, d.lat];

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
  /** Bot-density mode only: countries joined to centroids. */
  botDensity?: BotDensityPoint[];
  /** Global bot share % (for the above-average marker + tooltip). */
  botGlobalAvg?: number | null;
  /**
   * Desktop zoom control right inset (px) — the width of whatever overlays
   * the map's right edge (the open SidePanel), so the control stays visible
   * and detail cards stay clear of it.
   */
  controlRightInset?: number;
  /** Currently selected node / arc (resolved against the current data), or null. */
  selection?: MapSelection | null;
  /** Called with a new selection on click/tap, or null to clear (empty-map click). */
  onSelect?: (selection: MapSelection | null) => void;
  /**
   * Animation clock. Defaults to an internal one; Phase B's replay timeline
   * passes its own to drive play / pause / speed / seek.
   */
  clock?: AnimationClock;
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
  mapMode, period, heatmapData: heatmapIn = EMPTY_HEAT,
  botDensity, botGlobalAvg = null, controlRightInset = 0,
  selection = null, onSelect, clock: clockProp, onFatal,
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
  /** Country code of the pinned bot-density tooltip, if any. */
  const pinnedRef = useRef<string | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [tileIssue, setTileIssue] = useState(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [anchor, setAnchor] = useState<{ key: string; x: number; y: number } | null>(null);

  // Colour stops are re-resolved after the theme attribute lands in the DOM.
  const { resolvedTheme } = useTheme();
  const [botStops, setBotStops] = useState(resolveScaleStops);
  useEffect(() => { setBotStops(resolveScaleStops()); }, [resolvedTheme]);
  const botStopsKey = botStops.map(c => c.join(',')).join('|');

  // Stable handler bag: layers close over THIS, never over props, so a parent
  // re-render (e.g. onSelect identity) can't invalidate the layer set.
  const latest = useRef({ onSelect, controlRightInset });
  latest.current = { onSelect, controlRightInset };
  const handlers = useMemo(() => ({
    hover: (info: Pick<ThreatPoint>) => setTooltip(info.object ? { x: info.x, y: info.y, threat: info.object } : null),
    hoverArc: (info: Pick<ArcData>) => setTooltip(info.object ? { x: info.x, y: info.y, arc: info.object } : null),
    clickNode: (info: Pick<ThreatPoint>) => {
      if (!info.object) return false;
      const sel: MapSelection = { kind: 'node', node: info.object };
      setAnchor({ key: selectionKey(sel), x: info.x, y: info.y });
      setTooltip(null);
      latest.current.onSelect?.(sel);
      return true;
    },
    clickArc: (info: Pick<ArcData>) => {
      if (!info.object) return false;
      const sel: MapSelection = { kind: 'arc', arc: info.object };
      setAnchor({ key: selectionKey(sel), x: info.x, y: info.y });
      setTooltip(null);
      latest.current.onSelect?.(sel);
      return true;
    },
    hoverBot: (info: Pick<BotDensityPoint>) => {
      if (pinnedRef.current) return; // a pinned tooltip stays until dismissed
      setTooltip(info.object ? { x: info.x, y: info.y, bot: info.object } : null);
    },
    // Tap/click pins the tooltip (touch has no hover); tap again to dismiss.
    clickBot: (info: Pick<BotDensityPoint>) => {
      const object = info.object;
      if (!object) return false;
      if (pinnedRef.current && pinnedRef.current === object.code) {
        pinnedRef.current = null;
        setTooltip(null);
      } else {
        pinnedRef.current = object.code;
        setTooltip({ x: info.x, y: info.y, bot: object });
      }
      return true; // handled — don't fall through to the map-level dismiss
    },
    // Map-level click: only reached for empty-map clicks (layer handlers return true).
    clickEmpty: (info: PickingInfo) => {
      if (info.object) return;
      pinnedRef.current = null;
      setTooltip(null);
      latest.current.onSelect?.(null);
    },
  }), []);

  // Keep the zoom control clear of the SidePanel overlaying the map's right edge.
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
      map = new maplibregl.Map({
        container,
        style: MAP_STYLE,
        center: isMobileRef.current ? [-30, 30] : [10, 25],
        zoom: isMobileRef.current ? 0.6 : 2.2,
        pitch: isMobileRef.current ? 0 : 20,
        bearing: 0,
        minZoom: isMobileRef.current ? 0.5 : undefined,
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
      // Bottom-right, not top-right: the page's LIVE/refresh cluster owns the top-right corner.
      map.addControl(ctrl, 'bottom-right');
      navControlRef.current = ctrl;
      applyControlInset();
    } else if (isMobile && navControlRef.current) {
      map.removeControl(navControlRef.current);
      navControlRef.current = null;
    }
  }, [isMobile, mapLoaded, applyControlInset]);

  // Track container size (resize, rotation, side-panel toggles) and keep the GL canvas in sync.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const update = () => {
      setSize({ width: el.clientWidth, height: el.clientHeight });
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
  const targetNodes = useMemo(() => {
    const byPos = new Map<string, ArcData>();
    for (const a of geoArcs) {
      const k = a.targetPosition.join(',');
      if (!byPos.has(k)) byPos.set(k, a);
    }
    return Array.from(byPos.values());
  }, [geoArcs]);

  const tripData = useMemo(
    () => buildTripData(geoArcs, colorBy, isMobile, periodToMs(period)),
    [geoArcs, colorBy, isMobile, period],
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

      if (showBeams && geoArcs.length > 0) {
        const beamWidth = isMobile ? 2.5 : 1;
        layers.push(
          new PathLayer<ArcData>({
            id: 'beam-glow',
            data: geoArcs,
            getPath: getArcPath,
            getColor: d => getArcColor(d, colorBy, 51),
            getWidth: beamWidth,
            widthUnits: 'pixels',
            widthMinPixels: isMobile ? 2 : 1,
            widthMaxPixels: isMobile ? 4 : 2,
            updateTriggers: { getColor: colorBy },
          }),
          new PathLayer<ArcData>({
            id: 'beam-core',
            data: geoArcs,
            getPath: getArcPath,
            getColor: d => getArcColor(d, colorBy, 76),
            getWidth: beamWidth,
            widthUnits: 'pixels',
            widthMinPixels: isMobile ? 2 : 1,
            widthMaxPixels: isMobile ? 3 : 1,
            updateTriggers: { getColor: colorBy },
            pickable: true,
            onHover: handlers.hoverArc,
            onClick: handlers.clickArc,
          }),
        );
      }

      if (geoArcs.length > 0 && (showBeams || showNodes)) {
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

    // Bot density mode: countries only — no nodes/arcs/particles/heatmap.
    if (mapMode === 'bot_density' && botDensity && botDensity.length > 0) {
      const domain = botDensityDomain(botDensity);
      const minPx = isMobile ? 4 : 5;
      const maxPx = isMobile ? 20 : 30;
      layers.push(new ScatterplotLayer<BotDensityPoint>({
        id: 'bot-density',
        data: botDensity,
        getPosition: d => d.position,
        getRadius: d => botRadius(d.traffic_pct, domain.maxTraffic, minPx, maxPx),
        radiusUnits: 'pixels',
        getFillColor: d => botColor(d.bot_pct, domain.minBot, domain.maxBot, botStops),
        stroked: true,
        lineWidthUnits: 'pixels',
        getLineWidth: d => (isAboveAverage(d.bot_pct, botGlobalAvg, d.bound) ? 2 : 0.5),
        getLineColor: d => (isAboveAverage(d.bot_pct, botGlobalAvg, d.bound) ? RING_COLOR : OUTLINE_COLOR),
        updateTriggers: {
          getFillColor: [botStopsKey, domain.minBot, domain.maxBot],
          getRadius: [domain.maxTraffic, minPx, maxPx],
          getLineWidth: [botGlobalAvg],
          getLineColor: [botGlobalAvg],
        },
        pickable: true,
        onHover: handlers.hoverBot,
        onClick: handlers.clickBot,
      }));
    }

    return layers;
    // selectedNode/selectedArc are keyed by id so a data refetch that returns
    // an equal object doesn't rebuild.
  }, [
    geoThreats, geoArcs, targetNodes, showBeams, showNodes, colorBy, mapMode, geoHeat,
    botDensity, botGlobalAvg, botStops, botStopsKey, isMobile, handlers, selectedNodeId, selectedArcId,
  ]);

  // Drop any stale hover tooltip when the mode changes (the hovered layer is gone).
  useEffect(() => { pinnedRef.current = null; setTooltip(null); }, [mapMode]);

  // ─── Animation ────────────────────────────────────────────
  const reducedMotion = usePrefersReducedMotion();
  const particlesOn = showParticles && mapMode === 'global' && tripData.length > 0 && !reducedMotion;
  /** Impact rings follow the particles: same toggle, same reduced-motion rule. */
  const ringsOn = particlesOn;
  const pulseOn = mapMode === 'global' && showNodes && geoThreats.length > 0 && !reducedMotion;

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

  // Node bloom + glow breathe via PulseExtension: severity sets rate/amplitude,
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
  const scheduler = useMemo(
    () => new ArrivalScheduler(buildArrivalEvents(tripData, CYCLE_LENGTH), CYCLE_LENGTH),
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

  /** Latest animation seconds, so non-frame pushes (data changes) stay in phase. */
  const animSecondsRef = useRef(0);
  const compose = useCallback((seconds: number, t: number): Layer[] => {
    const layers: Layer[] = [...makeGlow(seconds), ...staticLayers];
    if (particlesOn) layers.push(makeTrips(t));
    if (ringsOn) layers.push(makeRings(seconds));
    return layers;
  }, [makeGlow, staticLayers, particlesOn, makeTrips, ringsOn, makeRings]);

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
  }, [mapLoaded, compose, clock, handlers, isMobile]);

  // ─── The one animation loop ───────────────────────────────
  const prevPlayheadRef = useRef<number | null>(null);
  const arrivalsScratch = useRef<ArrivalEvent[]>([]);
  const onFrame = useCallback((t: number, frame: { seconds: number; dt: number }) => {
    animSecondsRef.current = frame.seconds;
    const overlay = deckRef.current;
    if (!overlay) return;
    if (ringsOn) {
      const prev = frame.dt > 0 ? prevPlayheadRef.current : null; // first frame after (re)start has no baseline
      prevPlayheadRef.current = t;
      if (prev !== null) {
        const arrivals = arrivalsScratch.current;
        arrivals.length = 0;
        scheduler.collect(prev, t, arrivals);
        if (arrivals.length > 0) spawner.spawn(arrivals, frame.seconds);
      }
    }
    overlay.setProps({ layers: compose(frame.seconds, t) });
  }, [ringsOn, scheduler, spawner, compose]);

  useDeckFrame(clock, mapLoaded && (particlesOn || pulseOn), onFrame, { targetRef: rootRef });

  // ─── Detail-card anchor: use the click point, else project the selection ──
  const selKey = selection ? selectionKey(selection) : null;
  useEffect(() => {
    if (!selection || !selKey) return;
    if (anchor?.key === selKey) return;
    const map = mapRef.current;
    if (!mapLoaded || !map) return;
    const p = map.project(selectionLngLat(selection));
    setAnchor({ key: selKey, x: p.x, y: p.y });
  }, [selKey, mapLoaded]);

  const cardAnchor = selection && anchor?.key === selKey ? anchor : null;

  return (
    <div ref={rootRef} className="relative w-full h-full">
      <div ref={mapContainerRef} className="absolute inset-0" />

      {tileIssue && (
        <div
          role="status"
          className="absolute left-1/2 -translate-x-1/2 top-3 px-3 py-1 rounded-full font-mono text-[10px] pointer-events-none"
          style={{ background: 'var(--bg-card-deep)', border: '1px solid var(--border-base)', color: 'var(--text-tertiary)', zIndex: 30 }}
        >
          Some map tiles are loading slowly
        </div>
      )}

      {tooltip && !selection && (
        <div
          className="absolute z-50 pointer-events-none rounded-lg px-3 py-2 text-xs max-w-xs"
          style={{
            left: Math.max(4, Math.min(tooltip.x + 10, size.width - 260)),
            top: Math.max(4, Math.min(tooltip.y + 10, size.height - 110)),
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
          {tooltip.bot && (
            <div className="font-mono" style={{ color: 'var(--text-primary)' }}>
              {botDensityTooltip(tooltip.bot, botGlobalAvg)}
            </div>
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

      {selection && cardAnchor && (
        <MapDetailCard
          selection={selection}
          anchor={cardAnchor}
          bounds={{ width: size.width, height: size.height, rightInset: controlRightInset }}
          onClose={() => latest.current.onSelect?.(null)}
        />
      )}
    </div>
  );
}
