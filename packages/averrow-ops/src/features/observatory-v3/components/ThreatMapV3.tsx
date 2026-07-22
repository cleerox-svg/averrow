/**
 * ThreatMapV3 — GPU-driven particle animation via deck.gl TripsLayer.
 *
 * Key differences from ThreatMap (v2):
 *   - Particles use TripsLayer with a single `currentTime` uniform (zero CPU per frame)
 *   - MapboxOverlay runs in overlaid mode (interleaved=false) so particle redraws
 *     don't force basemap redraws
 *   - WebGL context loss is handled gracefully with recovery UI
 *   - Mobile caps particle count at 500 and reduces trail length
 *   - Beams are off by default (toggleable)
 *   - Data equality check prevents unnecessary layer rebuilds on refetch
 */

import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { ScatterplotLayer, PathLayer } from '@deck.gl/layers';
import { TripsLayer } from '@/lib/trips-layer';
import { HeatmapLayer } from '@deck.gl/aggregation-layers';
import type { ThreatPoint, ArcData, HeatmapPoint } from '@/hooks/useObservatory';

// ─── Types ──────────────────────────────────────────────────
export type MapMode = 'global' | 'heatmap';

interface TooltipInfo {
  x: number;
  y: number;
  threat?: ThreatPoint;
  arc?: ArcData;
}

// ─── Color helpers ──────────────────────────────────────────
const SEVERITY_COLORS: Record<string, [number, number, number, number]> = {
  critical: [200, 60,  60,  255],
  high:     [251, 146, 60,  220],
  medium:   [250, 204, 21,  180],
  low:      [120, 160, 200, 160],
  info:     [90,  128, 168, 140],
};

const THREAT_TYPE_COLORS: Record<string, [number, number, number, number]> = {
  phishing:               [200, 60,  60,  220],
  credential_harvesting:  [251, 146, 60,  220],
  malware_distribution:   [167, 139, 250, 220],
  c2:                     [239, 68,  68,  255],
  malicious_ip:           [120, 160, 200, 180],
  web_attack:             [251, 113, 133, 200],
  brute_force:            [250, 204, 21,  200],
  spam_botnet_c2:         [34,  211, 238, 220],
  typosquatting:          [220, 170, 50,  200],
  scanning:               [120, 160, 200, 180],
  impersonation:          [232, 146, 60,  220],
};

function getSeverityColor(severity: string, alpha?: number): [number, number, number, number] {
  const c = SEVERITY_COLORS[severity?.toLowerCase()] || SEVERITY_COLORS.info;
  return alpha != null ? [c[0], c[1], c[2], alpha] : c;
}

function getTypeColor(type: string, alpha?: number): [number, number, number, number] {
  const c = THREAT_TYPE_COLORS[type] || [120, 160, 200, 180];
  return alpha != null ? [c[0], c[1], c[2], alpha] : c;
}

function getArcColor(
  d: { severity?: string | null; threat_type?: string | null },
  colorMode: 'severity' | 'type',
  alpha?: number,
): [number, number, number, number] {
  if (colorMode === 'severity') return getSeverityColor(d.severity ?? 'medium', alpha);
  return getTypeColor(d.threat_type ?? 'phishing', alpha);
}

// Theme-aware severity TEXT colors (tooltip labels only — the WebGL layers
// above keep using getSeverityColor's RGBA tuples, which must stay fixed).
const SEV_TEXT: Record<string, string> = {
  critical: 'var(--sev-critical-text)',
  high: 'var(--sev-high-text)',
  medium: 'var(--sev-medium-text)',
  low: 'var(--sev-low-text)',
  info: 'var(--sev-info-text)',
};

// ─── Bezier helpers ─────────────────────────────────────────
function computeBezierPath(srcLng: number, srcLat: number, tgtLng: number, tgtLat: number, segments = 30): [number, number][] {
  const midLng = (srcLng + tgtLng) / 2;
  const midLat = (srcLat + tgtLat) / 2;
  const dist = Math.sqrt(Math.pow(tgtLng - srcLng, 2) + Math.pow(tgtLat - srcLat, 2));
  const controlLng = midLng;
  const controlLat = midLat + dist * 0.3;
  const path: [number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const mt = 1 - t;
    path.push([
      mt * mt * srcLng + 2 * mt * t * controlLng + t * t * tgtLng,
      mt * mt * srcLat + 2 * mt * t * controlLat + t * t * tgtLat,
    ]);
  }
  return path;
}

// ─── Map style ──────────────────────────────────────────────
const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

// ─── TripsLayer data builder ────────────────────────────────
// Timeline replay model: the selected period (24h / 7d / 30d) is mapped
// onto the animation CYCLE_LENGTH. Each arc has a "life window" within
// the cycle, corresponding to when its threats actually occurred.
// Arcs fade in when their window starts and fade out when it ends.
//
// Result: arcs appear/disappear organically across the timeline, with
// only 15-25% of arcs active at any given moment. No more all-at-once
// bombardment.

// CYCLE_LENGTH: one full "replay" of the selected period.
// At 1.0 units/frame × 60fps = 60 units/sec, 3600 units = ~60 sec per cycle.
const CYCLE_LENGTH = 3600;

// TRIP_SPAN: time for one particle to traverse a single arc.
// 180 units = ~3 seconds per traversal.
const TRIP_SPAN = 180;

// Minimum/maximum life window for an arc within the cycle (as fraction).
// High-volume arcs "stay alive" longer; low-volume arcs appear as brief bursts.
const MIN_LIFE_RATIO = 0.08;   // 8% of cycle = ~5 seconds
const MAX_LIFE_RATIO = 0.35;   // 35% of cycle = ~21 seconds

const MOBILE_MAX_PARTICLES = 800;
const DESKTOP_MAX_PARTICLES = 6000;

interface TripDatum {
  path: [number, number][];
  timestamps: number[];
  color: [number, number, number, number];
}

// Deterministic hash of arc identity — stable "random" value per arc
function hashArc(arc: ArcData): number {
  const str = `${arc.threat_type ?? ''}|${arc.brand_name ?? arc.target_brand ?? ''}|${arc.sourcePosition[0].toFixed(1)},${arc.sourcePosition[1].toFixed(1)}`;
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0; // force int32
  }
  return Math.abs(h);
}

/**
 * Compute the arc's life window within the animation cycle.
 * If the arc has real timestamps, map them proportionally onto the cycle.
 * If not, fall back to hash-based positioning.
 */
function computeLifeWindow(
  arc: ArcData,
  windowStartMs: number,
  windowEndMs: number,
): { start: number; duration: number } {
  // Volume drives life duration — high-volume arcs feel more persistent
  const volumeRatio = Math.min(1, Math.sqrt((arc.volume || 1)) / 10);
  const lifeRatio = MIN_LIFE_RATIO + (MAX_LIFE_RATIO - MIN_LIFE_RATIO) * volumeRatio;
  const duration = lifeRatio * CYCLE_LENGTH;

  // If backend provided real timestamps, map them onto the cycle
  if (arc.first_seen && arc.last_seen && windowEndMs > windowStartMs) {
    const firstMs = new Date(arc.first_seen).getTime();
    const lastMs = new Date(arc.last_seen).getTime();
    const spanMs = windowEndMs - windowStartMs;

    // Fraction of the window where this arc's threats occurred (0 to 1)
    const startFrac = Math.max(0, Math.min(1, (firstMs - windowStartMs) / spanMs));
    const endFrac = Math.max(0, Math.min(1, (lastMs - windowStartMs) / spanMs));

    // Center the life window on the midpoint of this arc's activity
    const activityCenter = (startFrac + endFrac) / 2;
    const start = activityCenter * CYCLE_LENGTH - duration / 2;
    return {
      start: ((start % CYCLE_LENGTH) + CYCLE_LENGTH) % CYCLE_LENGTH,
      duration,
    };
  }

  // Fallback: use hash for stable "random" placement
  const hash = hashArc(arc);
  const maxStart = Math.max(1, CYCLE_LENGTH - duration);
  return { start: hash % maxStart, duration };
}

function buildTripData(
  arcs: ArcData[],
  colorBy: 'severity' | 'type',
  isMobile: boolean,
  periodMs: number,
): TripDatum[] {
  const trips: TripDatum[] = [];
  let totalParticles = 0;
  const maxParticles = isMobile ? MOBILE_MAX_PARTICLES : DESKTOP_MAX_PARTICLES;
  const perArcCap = isMobile ? 8 : 15;

  const now = Date.now();
  const windowStart = now - periodMs;

  for (const arc of arcs) {
    if (totalParticles >= maxParticles) break;
    const path = computeBezierPath(
      arc.sourcePosition[0], arc.sourcePosition[1],
      arc.targetPosition[0], arc.targetPosition[1],
    );
    const color = getArcColor(arc, colorBy, 220);

    // Number of particles scales with volume, capped per-arc
    const numParticles = Math.min(
      Math.max(2, Math.ceil((arc.volume || 1) * 0.6)),
      perArcCap,
    );

    // Compute this arc's life window within the cycle
    const { start, duration } = computeLifeWindow(arc, windowStart, now);

    // Severity-based speed variation (still keep this — adds organic feel)
    const sevSpeedMultiplier =
      arc.severity === 'critical' ? 1.20
      : arc.severity === 'high' ? 1.08
      : arc.severity === 'low' ? 0.85
      : 1.0;
    const tripSpan = TRIP_SPAN / sevSpeedMultiplier;

    // Spread particles across the life window
    // Leave TRIP_SPAN headroom at the end so the last particle completes before window ends
    const effectiveDuration = Math.max(TRIP_SPAN, duration - tripSpan);

    // Seamless loop: duplicate every arc's burst at +CYCLE_LENGTH/2 (wrapped).
    // This guarantees activity uniformly distributed across the cycle regardless
    // of where the arc's real-world timestamps placed its life window. Without
    // this offset, arcs clustering at one end of the cycle (e.g. all in the last
    // 6 hours of a 7-day window) leave the other half visibly empty — causing a
    // pause at the wrap boundary.
    const phaseOffsets = [0, CYCLE_LENGTH / 2];

    for (let j = 0; j < numParticles; j++) {
      if (totalParticles >= maxParticles) break;
      const offsetWithinLife = (j / Math.max(1, numParticles - 1)) * effectiveDuration;

      for (const phaseOffset of phaseOffsets) {
        if (totalParticles >= maxParticles) break;
        const tripStart = ((start + offsetWithinLife + phaseOffset) % CYCLE_LENGTH);
        trips.push({
          path,
          timestamps: path.map((_, idx) => tripStart + (idx / (path.length - 1)) * tripSpan),
          color,
        });
        totalParticles++;
      }
    }
  }
  return trips;
}

// Map period string → duration in ms
function periodToMs(period: string): number {
  switch (period) {
    case '24h': return 24 * 60 * 60 * 1000;
    case '7d':  return 7 * 24 * 60 * 60 * 1000;
    case '30d': return 30 * 24 * 60 * 60 * 1000;
    case '90d': return 90 * 24 * 60 * 60 * 1000;
    default: return 7 * 24 * 60 * 60 * 1000;
  }
}

// ─── Props ──────────────────────────────────────────────────
interface ThreatMapV3Props {
  threats: ThreatPoint[];
  arcs: ArcData[];
  showBeams: boolean;
  showParticles: boolean;
  showNodes: boolean;
  colorBy: 'severity' | 'type';
  mapMode: MapMode;
  period: string; // 24h, 7d, 30d, 90d — drives timeline replay mapping
  heatmapData?: HeatmapPoint[];
  onArcClick?: (arc: ArcData, x: number, y: number) => void;
}

// ─── Error boundary ─────────────────────────────────────────
interface MapErrorState { hasError: boolean; error: Error | null }

class MapErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  MapErrorState
> {
  constructor(props: { children: React.ReactNode; fallback: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error): MapErrorState {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

function MapFallback({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center w-full h-full" style={{ background: 'var(--bg-page)' }}>
      <div className="font-mono text-xs uppercase tracking-wider mb-3" style={{ color: 'var(--text-muted)' }}>
        Map Unavailable
      </div>
      <div className="text-sm mb-4 max-w-md text-center" style={{ color: 'var(--text-tertiary)' }}>
        {message}
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="font-mono text-xs px-4 py-2 rounded-lg"
          style={{
            background: 'rgba(229,168,50,0.15)',
            border: '1px solid rgba(229,168,50,0.30)',
            color: 'var(--amber)',
            cursor: 'pointer',
          }}
        >
          Reload Map
        </button>
      )}
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────
export function ThreatMapV3(props: ThreatMapV3Props) {
  const [contextLost, setContextLost] = useState(false);

  if (contextLost) {
    return <MapFallback message="WebGL context was lost. This can happen on mobile with large datasets." onRetry={() => setContextLost(false)} />;
  }

  return (
    <MapErrorBoundary fallback={<MapFallback message="The map failed to initialize." />}>
      <ThreatMapV3Inner {...props} onContextLost={() => setContextLost(true)} />
    </MapErrorBoundary>
  );
}

function ThreatMapV3Inner({
  threats, arcs, showBeams, showParticles, showNodes, colorBy,
  mapMode, period, heatmapData = [],
  onArcClick, onContextLost,
}: ThreatMapV3Props & { onContextLost: () => void }) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const deckRef = useRef<any>(null);
  const animFrameRef = useRef<number | null>(null);
  const currentTimeRef = useRef(0);
  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;

  // Track previous data to skip rebuilds on identical refetch
  const prevThreatsLenRef = useRef(0);
  const prevArcsLenRef = useRef(0);

  // ─── Map initialization (once) ────────────────────────────
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    try {
      const map = new maplibregl.Map({
        container: mapContainerRef.current,
        style: MAP_STYLE,
        center: isMobile ? [-30, 30] : [10, 25],
        zoom: isMobile ? 0.6 : 2.2,
        pitch: isMobile ? 0 : 20,
        bearing: 0,
        minZoom: isMobile ? 0.5 : undefined,
        maxZoom: 12,
        antialias: true,
        attributionControl: false,
      });

      map.on('error', (e) => setMapError(e.error?.message || 'Map rendering error'));

      if (!isMobile) {
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      }
      mapRef.current = map;

      // WebGL context loss handling
      const canvas = map.getCanvas();
      canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        onContextLost();
      });

      if (map.loaded()) setMapLoaded(true);
      else map.once('load', () => setMapLoaded(true));

      return () => {
        if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
        setMapLoaded(false);
        if (deckRef.current && mapRef.current) {
          try { mapRef.current.removeControl(deckRef.current); } catch { /* safe */ }
          deckRef.current = null;
        }
        map.remove();
        mapRef.current = null;
      };
    } catch (err) {
      setMapError(err instanceof Error ? err.message : 'Failed to initialize map');
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Pre-compute trip data for TripsLayer (memoized on arcs change) ───
  const tripData = useMemo(
    () => buildTripData(arcs, colorBy, isMobile, periodToMs(period)),
    [arcs, colorBy, isMobile, period],
  );

  // ─── Build static layers ──────────────────────────────────
  const buildStaticLayers = useCallback(() => {
    const layers: any[] = [];

    if (mapMode === 'global') {
      const filteredThreats = threats.filter(t => t.lat && t.lng);

      // Source nodes: triple pass
      if (showNodes && filteredThreats.length > 0) {
        layers.push(
          new ScatterplotLayer({
            id: 'nodes-bloom',
            data: filteredThreats,
            getPosition: (d: any) => [d.lng, d.lat],
            getRadius: (d: any) => Math.sqrt(Math.max(1, d.threat_count)) * 5400,
            getFillColor: (d: any) => getSeverityColor(d.top_severity || 'low', 6),
            radiusMinPixels: 3, radiusMaxPixels: 24,
          }),
          new ScatterplotLayer({
            id: 'nodes-glow',
            data: filteredThreats,
            getPosition: (d: any) => [d.lng, d.lat],
            getRadius: (d: any) => Math.sqrt(Math.max(1, d.threat_count)) * 2900,
            getFillColor: (d: any) => getSeverityColor(d.top_severity || 'low', 12),
            radiusMinPixels: 2, radiusMaxPixels: 14,
          }),
          new ScatterplotLayer({
            id: 'nodes-core',
            data: filteredThreats,
            getPosition: (d: any) => [d.lng, d.lat],
            getRadius: (d: any) => Math.sqrt(Math.max(1, d.threat_count)) * 1440,
            getFillColor: (d: any) => getSeverityColor(d.top_severity?.toLowerCase() || 'low'),
            stroked: true, filled: true,
            radiusMinPixels: 1.5, radiusMaxPixels: 9,
            pickable: true,
            onHover: ({ object, x, y }: any) => setTooltip(object ? { x, y, threat: object } : null),
          }),
        );
      }

      // Bezier beams (off by default, toggled on)
      if (showBeams && arcs.length > 0) {
        const arcDataWithPaths = arcs.map(a => ({
          ...a,
          bezierPath: computeBezierPath(
            a.sourcePosition[0], a.sourcePosition[1],
            a.targetPosition[0], a.targetPosition[1],
          ),
        }));

        layers.push(
          new PathLayer({
            id: 'beam-glow',
            data: arcDataWithPaths,
            getPath: (d: any) => d.bezierPath,
            getColor: (d: any) => getArcColor(d, colorBy, 51),
            getWidth: isMobile ? 2.5 : 1,
            widthUnits: 'pixels' as const,
            widthMinPixels: isMobile ? 2 : 1,
            widthMaxPixels: isMobile ? 4 : 2,
            updateTriggers: { getColor: colorBy },
          }),
          new PathLayer({
            id: 'beam-core',
            data: arcDataWithPaths,
            getPath: (d: any) => d.bezierPath,
            getColor: (d: any) => getArcColor(d, colorBy, 76),
            getWidth: isMobile ? 2.5 : 1,
            widthUnits: 'pixels' as const,
            widthMinPixels: isMobile ? 2 : 1,
            widthMaxPixels: isMobile ? 3 : 1,
            updateTriggers: { getColor: colorBy },
            pickable: true,
            onHover: ({ object, x, y }: any) => setTooltip(object ? { x, y, arc: object } : null),
            onClick: ({ object, x, y }: any) => { if (object && onArcClick) onArcClick(object, x, y); },
          }),
        );
      }

      // Target rings
      if (arcs.length > 0 && (showBeams || showNodes)) {
        const targetMap = new Map<string, ArcData>();
        arcs.forEach(a => { const k = a.targetPosition.join(','); if (!targetMap.has(k)) targetMap.set(k, a); });
        const targetNodes = Array.from(targetMap.values());

        layers.push(
          new ScatterplotLayer({
            id: 'targets-ring',
            data: targetNodes,
            getPosition: (d: any) => d.targetPosition,
            getRadius: 12000,
            getFillColor: [255, 255, 255, 6] as [number, number, number, number],
            getLineColor: [255, 255, 255, 40] as [number, number, number, number],
            lineWidthMinPixels: 1, stroked: true, radiusMinPixels: 3, radiusMaxPixels: 14,
          }),
          new ScatterplotLayer({
            id: 'targets-core',
            data: targetNodes,
            getPosition: (d: any) => d.targetPosition,
            getRadius: 3600,
            getFillColor: [255, 255, 255, 45] as [number, number, number, number],
            radiusMinPixels: 1.5, radiusMaxPixels: 5,
          }),
        );
      }
    }

    // Heatmap mode
    if (mapMode === 'heatmap' && heatmapData.length > 0) {
      layers.push(new (HeatmapLayer as any)({
        id: 'heatmap-layer',
        data: heatmapData,
        getPosition: (d: any) => [d.lng, d.lat],
        getWeight: (d: any) => ({ critical: 5, high: 3, medium: 2, low: 1 }[d.severity as string] ?? 1),
        radiusPixels: 80, intensity: 2, threshold: 0.05, aggregation: 'SUM' as const,
        colorRange: [
          [0, 212, 255, 0], [0, 212, 255, 80], [0, 212, 255, 160],
          [251, 146, 60, 180], [200, 60, 60, 220], [255, 50, 50, 255],
        ],
      }));
    }

    return layers;
  }, [threats, arcs, showBeams, showNodes, colorBy, mapMode, heatmapData, onArcClick, isMobile]);

  // ─── Update overlay + start particle animation ────────────
  useEffect(() => {
    if (!mapLoaded || !mapRef.current) return;

    // Skip rebuild if data hasn't actually changed (refetch returned same size)
    const threatsChanged = threats.length !== prevThreatsLenRef.current;
    const arcsChanged = arcs.length !== prevArcsLenRef.current;
    prevThreatsLenRef.current = threats.length;
    prevArcsLenRef.current = arcs.length;

    const staticLayers = buildStaticLayers();

    // Build initial layer set (static + trips if particles enabled)
    const allLayers = showParticles && tripData.length > 0 && mapMode === 'global'
      ? [
          ...staticLayers,
          new TripsLayer({
            id: 'particle-trails',
            data: tripData,
            getPath: (d: TripDatum) => d.path,
            getTimestamps: (d: TripDatum) => d.timestamps,
            getColor: (d: TripDatum) => d.color,
            currentTime: currentTimeRef.current,
            // Trail length tied to TRIP_SPAN — longer trail = more visible tail per particle
            trailLength: isMobile ? TRIP_SPAN * 0.35 : TRIP_SPAN * 0.50,
            fadeTrail: true,
            widthMinPixels: isMobile ? 1.5 : 2,
            capRounded: true,
          }),
        ]
      : staticLayers;

    if (deckRef.current) {
      deckRef.current.setProps({ layers: allLayers });
    } else if (allLayers.length > 0) {
      const overlay = new MapboxOverlay({ interleaved: false, layers: allLayers });
      mapRef.current.addControl(overlay as any);
      deckRef.current = overlay;
    }

    // ─── Particle animation loop (GPU-driven via currentTime) ───
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }

    if (showParticles && tripData.length > 0 && mapMode === 'global' && deckRef.current) {
      const staticLayersRef = staticLayers; // stable for this effect lifecycle

      function animate() {
        // 1.0 units per frame × 60fps = 60 units/sec
        // With CYCLE_LENGTH=1200, full cycle takes ~20 seconds
        // With TRIP_SPAN=300, each particle traversal takes ~5 seconds
        currentTimeRef.current = (currentTimeRef.current + 1.0) % CYCLE_LENGTH;

        if (deckRef.current) {
          deckRef.current.setProps({
            layers: [
              ...staticLayersRef,
              new TripsLayer({
                id: 'particle-trails',
                data: tripData,             // Same reference — no buffer recompute
                getPath: (d: TripDatum) => d.path,
                getTimestamps: (d: TripDatum) => d.timestamps,
                getColor: (d: TripDatum) => d.color,
                currentTime: currentTimeRef.current,  // Only this changes
                // Trail length tied to TRIP_SPAN — longer trail = more visible tail per particle
            trailLength: isMobile ? TRIP_SPAN * 0.35 : TRIP_SPAN * 0.50,
                fadeTrail: true,
                widthMinPixels: isMobile ? 1.5 : 2,
                capRounded: true,
              }),
            ],
          });
        }

        animFrameRef.current = requestAnimationFrame(animate);
      }

      animFrameRef.current = requestAnimationFrame(animate);
    }

    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
    };
  }, [mapLoaded, buildStaticLayers, showParticles, tripData, mapMode, isMobile]);

  if (mapError) {
    return <MapFallback message={`Map initialization failed: ${mapError}`} onRetry={() => window.location.reload()} />;
  }

  return (
    <div className="relative w-full h-full">
      <div ref={mapContainerRef} className="absolute inset-0" />

      {tooltip && (
        <div
          className="absolute z-50 pointer-events-none rounded-lg px-3 py-2 text-xs max-w-xs"
          style={{
            left: tooltip.x + 10, top: tooltip.y + 10,
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
                <span className="capitalize">{tooltip.threat.top_threat_type?.replace(/_/g, ' ') || 'Mixed'}</span>
                {tooltip.threat.top_severity && (
                  <> {' \u00b7 '}
                    <span className="uppercase" style={{ color: SEV_TEXT[tooltip.threat.top_severity?.toLowerCase() ?? ''] ?? 'var(--sev-low-text)' }}>
                      {tooltip.threat.top_severity}
                    </span>
                  </>
                )}
              </div>
              {tooltip.threat.country_code && (
                <div className="mt-0.5" style={{ color: 'var(--text-muted)' }}>{tooltip.threat.country_code}</div>
              )}
              <div className="mt-1 text-[9px]" style={{ color: 'var(--text-muted)' }}>
                C:{tooltip.threat.critical} H:{tooltip.threat.high} M:{tooltip.threat.medium} L:{tooltip.threat.low}
              </div>
            </>
          )}
          {tooltip.arc && (
            <>
              <div className="font-mono font-bold capitalize" style={{ color: 'var(--text-primary)' }}>
                {tooltip.arc.threat_type?.replace(/_/g, ' ')}
              </div>
              <div className="mt-1" style={{ color: 'var(--text-tertiary)' }}>{tooltip.arc.volume} threat{tooltip.arc.volume > 1 ? 's' : ''}</div>
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
