import React, { useEffect, useRef, useState, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { ScatterplotLayer, PathLayer } from '@deck.gl/layers';
import { HeatmapLayer } from '@deck.gl/aggregation-layers';
import type { ThreatPoint, ArcData, HeatmapPoint } from '@/hooks/useObservatory';
import type { Operation } from '@/hooks/useOperations';
import { cn } from '@/lib/cn';

// ─── WebGL availability check ──────────────────────────────
function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

// ─── Local error boundary for map component ────────────────
interface MapErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class MapErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  MapErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode; fallback: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): MapErrorBoundaryState {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

// ─── WebGL unavailable fallback ────────────────────────────
function WebGLFallback({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center w-full h-full bg-cockpit">
      <div className="font-mono text-xs text-contrail/70 uppercase tracking-wider mb-3">
        Map Unavailable
      </div>
      <div className="text-contrail/50 text-sm mb-4 max-w-md text-center">
        {message}
      </div>
      <div className="text-white/40 text-xs">
        Threat data is still available in other views.
      </div>
    </div>
  );
}

// ─── Types ──────────────────────────────────────────────────
export type MapMode = 'global' | 'operations' | 'heatmap';

interface TooltipInfo {
  x: number;
  y: number;
  threat?: ThreatPoint;
  arc?: ArcData;
}

interface ClickedArc {
  arc: ArcData;
  x: number;
  y: number;
}

interface ClickedCluster {
  cluster: Operation;
  x: number;
  y: number;
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
  if (colorMode === 'severity') {
    return getSeverityColor(d.severity ?? 'medium', alpha);
  }
  return getTypeColor(d.threat_type ?? 'phishing', alpha);
}

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

function bezierInterp(srcLng: number, srcLat: number, tgtLng: number, tgtLat: number, t: number): [number, number] {
  const midLng = (srcLng + tgtLng) / 2;
  const midLat = (srcLat + tgtLat) / 2;
  const dist = Math.sqrt(Math.pow(tgtLng - srcLng, 2) + Math.pow(tgtLat - srcLat, 2));
  const controlLng = midLng;
  const controlLat = midLat + dist * 0.3;
  const mt = 1 - t;
  return [
    mt * mt * srcLng + 2 * mt * t * controlLng + t * t * tgtLng,
    mt * mt * srcLat + 2 * mt * t * controlLat + t * t * tgtLat,
  ];
}

// ─── Country centroids ──────────────────────────────────────
const COUNTRY_CENTROIDS: Record<string, [number, number]> = {
  CN: [104.1954, 35.8617],
  PK: [69.3451, 30.3753],
  IN: [78.9629, 20.5937],
  US: [-95.7129, 37.0902],
  NL: [5.2913, 52.1326],
  DE: [10.4515, 51.1657],
  GB: [-3.4360, 55.3781],
  RU: [105.3188, 61.5240],
  BR: [-51.9253, -14.2350],
  ZA: [22.9375, -30.5595],
  SG: [103.8198, 1.3521],
  JP: [138.2529, 36.2048],
  FR: [2.2137, 46.2276],
  AU: [133.7751, -25.2744],
  KR: [127.7669, 35.9078],
  CA: [-106.3468, 56.1304],
  ID: [113.9213, -0.7893],
  VN: [108.2772, 14.0583],
  TH: [100.9925, 15.8700],
  UA: [31.1656, 48.3794],
  TR: [35.2433, 38.9637],
  IT: [12.5674, 41.8719],
  ES: [-3.7492, 40.4637],
  PL: [19.1451, 51.9194],
  MX: [-102.5528, 23.6345],
  NG: [8.6753, 9.0820],
  EG: [30.8025, 26.8206],
  BD: [90.3563, 23.6850],
  PH: [121.7740, 12.8797],
  HK: [114.1694, 22.3193],
};

function getClusterPosition(countries: string[]): [number, number] {
  const primary = countries[0];
  return COUNTRY_CENTROIDS[primary] ?? [0, 20];
}

function parseJsonArray(val: string | null): string[] {
  if (!val) return [];
  try { return JSON.parse(val) as string[]; }
  catch { return []; }
}

// ─── Map style ──────────────────────────────────────────────
const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

// ─── Props ──────────────────────────────────────────────────
interface ThreatMapProps {
  threats: ThreatPoint[];
  arcs: ArcData[];
  showBeams: boolean;
  showParticles: boolean;
  showNodes: boolean;
  colorBy: 'severity' | 'type';
  mapMode: MapMode;
  operations?: Operation[];
  heatmapData?: HeatmapPoint[];
  onArcClick?: (arc: ArcData, x: number, y: number) => void;
  onClusterClick?: (cluster: Operation, x: number, y: number) => void;
}

export function ThreatMap(props: ThreatMapProps) {
  if (!isWebGLAvailable()) {
    return <WebGLFallback message="WebGL is not supported in this browser. The threat map requires WebGL to render." />;
  }

  return (
    <MapErrorBoundary
      fallback={<WebGLFallback message="The map failed to initialize. This may be due to a WebGL or graphics driver issue." />}
    >
      <ThreatMapInner {...props} />
    </MapErrorBoundary>
  );
}

function ThreatMapInner({
  threats, arcs, showBeams, showParticles, showNodes, colorBy,
  mapMode, operations = [], heatmapData = [],
  onArcClick, onClusterClick,
}: ThreatMapProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const deckRef = useRef<any>(null);
  const baseLayersRef = useRef<any[]>([]);
  const particlesRef = useRef<Array<{ arc: number; t: number; speed: number }>>([]);
  const animFrameRef = useRef<number | null>(null);
  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    try {
      const isMobileViewport = window.innerWidth < 768;

      const map = new maplibregl.Map({
        container: mapContainerRef.current,
        style: MAP_STYLE,
        center: isMobileViewport ? [-30, 30] : [10, 25],
        zoom: isMobileViewport ? 0.6 : 2.2,
        pitch: isMobileViewport ? 0 : 20,
        bearing: 0,
        minZoom: isMobileViewport ? 0.5 : undefined,
        maxZoom: 12,
        antialias: true,
        attributionControl: false,
      });

      map.on('error', (e) => {
        setMapError(e.error?.message || 'Map rendering error');
      });

      if (!isMobileViewport) {
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      }
      mapRef.current = map;

      if (map.loaded()) {
        setMapLoaded(true);
      } else {
        map.once('load', () => setMapLoaded(true));
      }

      return () => {
        setMapLoaded(false);
        map.remove();
        mapRef.current = null;
      };
    } catch (err) {
      setMapError(err instanceof Error ? err.message : 'Failed to initialize map');
    }
  }, []);

  const buildBaseLayers = useCallback(() => {
    const layers: any[] = [];

    // ═══ GLOBAL MODE ═══
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
            radiusMinPixels: 3,
            radiusMaxPixels: 24,
          })
        );
        layers.push(
          new ScatterplotLayer({
            id: 'nodes-glow',
            data: filteredThreats,
            getPosition: (d: any) => [d.lng, d.lat],
            getRadius: (d: any) => Math.sqrt(Math.max(1, d.threat_count)) * 2900,
            getFillColor: (d: any) => getSeverityColor(d.top_severity || 'low', 12),
            radiusMinPixels: 2,
            radiusMaxPixels: 14,
          })
        );
        layers.push(
          new ScatterplotLayer({
            id: 'nodes-core',
            data: filteredThreats,
            getPosition: (d: any) => [d.lng, d.lat],
            getRadius: (d: any) => Math.sqrt(Math.max(1, d.threat_count)) * 1440,
            getFillColor: (d: any) => getSeverityColor(d.top_severity?.toLowerCase() || 'low'),
            stroked: true,
            filled: true,
            radiusMinPixels: 1.5,
            radiusMaxPixels: 9,
            pickable: true,
            onHover: ({ object, x, y }: any) => {
              setTooltip(object ? { x, y, threat: object } : null);
            },
          })
        );
      }

      // Bezier beams: dual pass
      if (showBeams && arcs.length > 0) {
        const arcDataWithPaths = arcs.map(a => ({
          ...a,
          bezierPath: computeBezierPath(
            a.sourcePosition[0], a.sourcePosition[1],
            a.targetPosition[0], a.targetPosition[1]
          ),
        }));

        const isMobileViewport = window.innerWidth < 768;

        layers.push(
          new PathLayer({
            id: 'beam-glow',
            data: arcDataWithPaths,
            getPath: (d: any) => d.bezierPath,
            getColor: (d: any) => getArcColor(d, colorBy, 51),
            getWidth: (d: any) => isMobileViewport ? 2.5 : Math.max(1, Math.min(3, (d.volume || 1) * 0.3)),
            widthUnits: 'pixels',
            widthMinPixels: isMobileViewport ? 2 : 1,
            widthMaxPixels: isMobileViewport ? 4 : 2,
            updateTriggers: { getColor: colorBy },
          })
        );
        layers.push(
          new PathLayer({
            id: 'beam-core',
            data: arcDataWithPaths,
            getPath: (d: any) => d.bezierPath,
            getColor: (d: any) => getArcColor(d, colorBy, 76),
            getWidth: isMobileViewport ? 2.5 : 1,
            widthUnits: 'pixels',
            widthMinPixels: isMobileViewport ? 2 : 1,
            widthMaxPixels: isMobileViewport ? 3 : 1,
            updateTriggers: { getColor: colorBy },
            pickable: true,
            onHover: ({ object, x, y }: any) => {
              setTooltip(object ? { x, y, arc: object } : null);
            },
            onClick: ({ object, x, y }: any) => {
              if (object && onArcClick) {
                onArcClick(object, x, y);
              }
            },
          })
        );
      }

      // Target destination rings
      if (arcs.length > 0 && (showBeams || showNodes)) {
        const targetMap = new Map<string, ArcData>();
        arcs.forEach(a => {
          const k = a.targetPosition.join(',');
          if (!targetMap.has(k)) targetMap.set(k, a);
        });
        const targetNodes = Array.from(targetMap.values());

        layers.push(
          new ScatterplotLayer({
            id: 'targets-ring',
            data: targetNodes,
            getPosition: (d: any) => d.targetPosition,
            getRadius: 12000,
            getFillColor: [255, 255, 255, 6] as [number, number, number, number],
            getLineColor: [255, 255, 255, 40] as [number, number, number, number],
            lineWidthMinPixels: 1,
            stroked: true,
            radiusMinPixels: 3,
            radiusMaxPixels: 14,
          })
        );
        layers.push(
          new ScatterplotLayer({
            id: 'targets-core',
            data: targetNodes,
            getPosition: (d: any) => d.targetPosition,
            getRadius: 3600,
            getFillColor: [255, 255, 255, 45] as [number, number, number, number],
            radiusMinPixels: 1.5,
            radiusMaxPixels: 5,
          })
        );
      }
    }

    // ═══ OPERATIONS MODE ═══
    if (mapMode === 'operations' && operations.length > 0) {
      // Outer glow ring — pixel-based for visibility at world zoom
      layers.push(
        new ScatterplotLayer({
          id: 'operations-clusters',
          data: operations,
          getPosition: (d: any) => getClusterPosition(parseJsonArray(d.countries ?? '[]')),
          getRadius: (d: any) => Math.max(20, Math.min(80, Math.sqrt(d.threat_count) * 2.5)),
          radiusUnits: 'pixels' as any,
          radiusMinPixels: 20,
          radiusMaxPixels: 80,
          getFillColor: (d: any) => {
            if (d.agent_notes?.includes('ACCELERATING')) return [251, 146, 60, 35] as [number, number, number, number];
            if (d.agent_notes?.includes('PIVOT')) return [0, 212, 255, 25] as [number, number, number, number];
            return [200, 60, 60, 30] as [number, number, number, number];
          },
          getLineColor: (d: any) => {
            if (d.agent_notes?.includes('ACCELERATING')) return [251, 146, 60, 220] as [number, number, number, number];
            if (d.agent_notes?.includes('PIVOT')) return [0, 212, 255, 200] as [number, number, number, number];
            return [200, 60, 60, 200] as [number, number, number, number];
          },
          stroked: true,
          lineWidthMinPixels: 1.5,
          lineWidthMaxPixels: 2,
          pickable: true,
          onClick: ({ object, x, y }: any) => {
            if (object && onClusterClick) {
              onClusterClick(object, x, y);
            }
          },
        })
      );
      // Inner bright dot — layered on top
      layers.push(
        new ScatterplotLayer({
          id: 'operations-clusters-inner',
          data: operations,
          getPosition: (d: any) => getClusterPosition(parseJsonArray(d.countries ?? '[]')),
          getRadius: (d: any) => Math.max(6, Math.min(20, Math.sqrt(d.threat_count))),
          radiusUnits: 'pixels' as any,
          radiusMinPixels: 6,
          radiusMaxPixels: 20,
          getFillColor: (d: any) => {
            if (d.agent_notes?.includes('ACCELERATING')) return [251, 146, 60, 240] as [number, number, number, number];
            if (d.agent_notes?.includes('PIVOT')) return [0, 212, 255, 220] as [number, number, number, number];
            return [200, 60, 60, 240] as [number, number, number, number];
          },
          stroked: false,
          pickable: true,
          onClick: ({ object, x, y }: any) => {
            if (object && onClusterClick) {
              onClusterClick(object, x, y);
            }
          },
        })
      );
    }

    // ═══ HEATMAP MODE ═══
    if (mapMode === 'heatmap' && heatmapData.length > 0) {
      const heatmapProps = {
        id: 'heatmap-layer',
        data: heatmapData,
        getPosition: (d: any) => [d.lng, d.lat],
        getWeight: (d: any) => {
          const weights: Record<string, number> = { critical: 5, high: 3, medium: 2, low: 1 };
          return weights[d.severity] ?? 1;
        },
        radiusPixels: 80,
        intensity: 2,
        threshold: 0.05,
        aggregation: 'SUM' as const,
        colorRange: [
          [0, 212, 255, 0],
          [0, 212, 255, 80],
          [0, 212, 255, 160],
          [251, 146, 60, 180],
          [200, 60, 60, 220],
          [255, 50, 50, 255],
        ],
      };
      layers.push(new (HeatmapLayer as any)(heatmapProps));
    }

    return layers;
  }, [threats, arcs, showBeams, showNodes, colorBy, mapMode, operations, heatmapData, onArcClick, onClusterClick]);

  // Update overlay when data/settings change — only after map is loaded
  useEffect(() => {
    if (!mapLoaded || !mapRef.current) return;

    const layers = buildBaseLayers();
    baseLayersRef.current = layers;

    if (deckRef.current) {
      // Update existing overlay in place — no remove/add thrash
      deckRef.current.setProps({ layers });
    } else if (layers.length > 0) {
      const overlay = new MapboxOverlay({ interleaved: true, layers });
      mapRef.current.addControl(overlay as any);
      deckRef.current = overlay;
    }
  }, [mapLoaded, threats, arcs, showBeams, showNodes, showParticles, colorBy, mapMode, operations, heatmapData, buildBaseLayers]);

  // Particle animation (only in global mode)
  useEffect(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }

    if (!showParticles || arcs.length === 0 || mapMode !== 'global') return;

    const particles: Array<{ arc: number; t: number; speed: number }> = [];
    arcs.forEach((_, i) => {
      const n = Math.max(3, Math.ceil(((arcs[i] as any).volume || 1) * 0.5));
      for (let j = 0; j < n; j++) {
        particles.push({
          arc: i,
          t: Math.random(),
          speed: 0.004 + Math.random() * 0.002,
        });
      }
    });
    particlesRef.current = particles;

    function animate() {
      const ps = particlesRef.current;
      ps.forEach(p => {
        p.t += p.speed;
        if (p.t > 1.05) p.t = -0.05;
      });

      if (deckRef.current && mapRef.current) {
        const glowData: Array<{ pos: [number, number]; col: [number, number, number, number] }> = [];
        const coreData: Array<{ pos: [number, number]; col: [number, number, number, number] }> = [];

        ps.forEach(p => {
          const arc = arcs[p.arc];
          if (!arc) return;
          const tc = Math.max(0, Math.min(1, p.t));
          const [lon, lat] = bezierInterp(
            arc.sourcePosition[0], arc.sourcePosition[1],
            arc.targetPosition[0], arc.targetPosition[1], tc
          );
          const col = getArcColor(arc, colorBy, 14);
          glowData.push({ pos: [lon, lat], col });
          coreData.push({ pos: [lon, lat], col: [255, 255, 255, 160] });
        });

        const particleLayers = [
          new ScatterplotLayer({
            id: 'particle-glow',
            data: glowData,
            getPosition: (d: any) => d.pos,
            radiusUnits: 'pixels' as any,
            getRadius: 2,
            getFillColor: (d: any) => d.col,
          }),
          new ScatterplotLayer({
            id: 'particle-core',
            data: coreData,
            getPosition: (d: any) => d.pos,
            radiusUnits: 'pixels' as any,
            getRadius: 1.2,
            getFillColor: (d: any) => d.col,
          }),
        ];

        deckRef.current.setProps({
          layers: [...baseLayersRef.current, ...particleLayers],
        });
      }

      animFrameRef.current = requestAnimationFrame(animate);
    }

    animFrameRef.current = requestAnimationFrame(animate);
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [arcs, showParticles, colorBy, mapMode]);

  if (mapError) {
    return <WebGLFallback message={`Map initialization failed: ${mapError}`} />;
  }

  return (
    <div className="relative w-full h-full">
      <div ref={mapContainerRef} className="absolute inset-0" />

      {tooltip && (
        <div
          className="absolute z-50 pointer-events-none bg-cockpit/95 border border-white/10 rounded-lg px-3 py-2 text-xs max-w-xs"
          style={{ left: tooltip.x + 10, top: tooltip.y + 10 }}
        >
          {tooltip.threat && (
            <>
              <div className="font-mono font-bold text-parchment">
                {tooltip.threat.threat_count} threats
              </div>
              <div className="text-contrail/60 mt-1">
                <span className="capitalize">{tooltip.threat.top_threat_type?.replace(/_/g, ' ') || 'Mixed'}</span>
                {tooltip.threat.top_severity && (
                  <>
                    {' \u00b7 '}
                    <span className="uppercase" style={{ color: `rgb(${getSeverityColor(tooltip.threat.top_severity).slice(0, 3).join(',')})` }}>
                      {tooltip.threat.top_severity}
                    </span>
                  </>
                )}
              </div>
              {tooltip.threat.country_code && (
                <div className="text-white/55 mt-0.5">{tooltip.threat.country_code}</div>
              )}
              <div className="text-white/50 mt-1 text-[9px]">
                C:{tooltip.threat.critical} H:{tooltip.threat.high} M:{tooltip.threat.medium} L:{tooltip.threat.low}
              </div>
            </>
          )}
          {tooltip.arc && (
            <>
              <div className="font-mono font-bold text-parchment capitalize">
                {tooltip.arc.threat_type?.replace(/_/g, ' ')}
              </div>
              <div className="text-contrail/60 mt-1">{tooltip.arc.volume} threat{tooltip.arc.volume > 1 ? 's' : ''}</div>
              {tooltip.arc.brand_name && (
                <div className="text-accent mt-1">Target: {tooltip.arc.brand_name}</div>
              )}
              {tooltip.arc.source_region && (
                <div className="text-white/55 mt-0.5">From: {tooltip.arc.source_region}</div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
