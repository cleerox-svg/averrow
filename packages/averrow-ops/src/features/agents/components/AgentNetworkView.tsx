// AgentNetworkView v3 — zoomable + pannable full-mesh map with
// upstream feeds layer.
//
// Includes the threat-intel feeds cluster on the left edge (added
// 2026-05). Each enabled feed renders as a small node; edges flow:
//
//   [Feed sources] → sentinel → cartographer → nexus → …
//
// Same live-signal vocabulary applies to feed → sentinel edges:
// pulse when the feed pulled in the last 10 min, comm burst when
// both feed AND sentinel ran in the last 60s.
//
// Iteration 2 over the trigger-chain-only first cut. Now shows ALL
// 40 agents arranged in hand-positioned neighborhoods by category:
//   - Top centre: Flight Control (supervisor)
//   - Left half: Intelligence trigger chain + surveillance scanners
//   - Top right: Platform ops (navigator, enricher, cube_healer,
//     geoip_refresh, curator, watchdog)
//   - Right side: Sparrow (response)
//   - Bottom right: 13 sync agents in a 4×4 grid
//
// Each circle now uses the agent's bespoke <AgentIcon /> SVG (was a
// 2-letter initial). Names below the circle stay always-visible —
// at this density they're the most useful affordance.
//
// Live signal:
//   - Pulsing amber edge: upstream agent ran in last 10 min
//   - Comm burst (particle traveling along edge): upstream AND
//     downstream both ran within the last 60s — implies recent
//     event hand-off
//   - Running pulse (animated halo around node): agent's last_run_at
//     is within 60s
//   - Failure ring (red): circuit_state='tripped' OR last_run_status='failed'
//   - Selection halo: animated amber halo around selected node
//
// All visuals are pure SVG with CSS-var colors → flips with theme.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Agent } from '@/hooks/useAgents';
import { useFeeds } from '@/hooks/useFeeds';
import type { FeedOverview } from '@/hooks/useFeeds';
import { AGENT_METADATA, type AgentId } from '@/lib/agent-metadata';
import { AgentIcon } from '@/components/brand/AgentIcon';
import { ZoomIn, ZoomOut, Maximize2, Minimize2, RotateCcw } from 'lucide-react';

// Negative-X origin for the feeds cluster — keeps every existing
// agent LAYOUT entry stable. The visible viewport spans x = -120
// to (VIEWBOX_W - 120) so feeds at x = -100..-20 land in the
// new left margin.
const VIEWBOX_X = -120;
const VIEWBOX_W = 1400;
const VIEWBOX_H = 780;
const NODE_R    = 22;
const ICON_SIZE = 24;
const FEED_R    = 11;          // smaller — feeds are context, not focal
const FLY_WINDOW_MS     = 10 * 60 * 1000; // 10-min "in flight" window
const RUNNING_WINDOW_MS = 60 * 1000;       // 60s = "running right now"
const BURST_WINDOW_MS   = 60 * 1000;       // 60s correlation window for bursts

interface NodePos { x: number; y: number; }

// ─── Layout — hand-positioned neighborhoods by category ───────────
//
// Tweaks here move nodes; rebuild predictably. Keep groups visually
// separated (≥120px gap between cluster boundaries) so the viewer
// can identify "where do the sync agents live" at a glance.
const LAYOUT: Record<string, NodePos> = {
  // SUPERVISOR
  flight_control:           { x: 620, y:  60 },

  // INTELLIGENCE — trigger chain visible left → right
  sentinel:                 { x: 100, y: 200 },
  cartographer:             { x: 240, y: 200 },
  nexus:                    { x: 380, y: 200 },
  attributor:               { x: 380, y: 290 },
  analyst:                  { x: 520, y: 150 },
  observer:                 { x: 520, y: 240 },
  strategist:               { x: 520, y: 330 },
  news_watcher:             { x: 380, y: 380 },
  pathfinder:               { x: 660, y: 150 },
  narrator:                 { x: 660, y: 240 },
  notification_narrator:    { x: 660, y: 330 },
  seed_strategist:          { x: 660, y: 410 },
  auto_seeder:              { x: 780, y: 410 },

  // SURVEILLANCE — bottom left
  social_discovery:         { x: 100, y: 470 },
  lookalike_scanner:        { x: 240, y: 470 },
  app_store_monitor:        { x: 380, y: 470 },
  social_monitor:           { x: 100, y: 570 },
  dark_web_monitor:         { x: 240, y: 570 },

  // RESPONSE
  sparrow:                  { x: 780, y: 240 },

  // PLATFORM OPS — top right
  navigator:                { x: 920, y: 150 },
  enricher:                 { x: 1080, y: 150 },
  cube_healer:              { x: 920, y: 250 },
  geoip_refresh:            { x: 1080, y: 250 },
  watchdog:                 { x: 920, y: 350 },
  curator:                  { x: 1080, y: 350 },

  // SYNC AI — bottom right 4×4-ish grid
  public_trust_check:       { x:  900, y: 480 },
  url_scan:                 { x:  990, y: 480 },
  scan_report:              { x: 1080, y: 480 },
  brand_analysis:           { x: 1170, y: 480 },
  brand_report:             { x:  900, y: 560 },
  brand_deep_scan:          { x:  990, y: 560 },
  brand_enricher:           { x: 1080, y: 560 },
  honeypot_generator:       { x: 1170, y: 560 },
  admin_classify:           { x:  900, y: 640 },
  qualified_report:         { x:  990, y: 640 },
  evidence_assembler:       { x: 1080, y: 640 },
  social_ai_assessor:       { x: 1170, y: 640 },
  geo_campaign_assessment:  { x:  990, y: 720 },
};

// ─── Edges (trigger chain) ─────────────────────────────────────────
const EDGES: Array<[string, string]> = [
  ['sentinel',        'cartographer'],
  ['cartographer',    'nexus'],
  ['nexus',           'analyst'],
  ['nexus',           'observer'],
  ['nexus',           'attributor'],
  ['analyst',         'pathfinder'],
  ['observer',        'narrator'],
  ['observer',        'seed_strategist'],
  ['seed_strategist', 'auto_seeder'],
];

// ─── Supervision edges (Flight Control → workers) ─────────────────
//
// FC supervises the entire mesh, but rendering 40 dashed lines from
// one point would be visual noise. Show the headline supervised
// agents (pipeline backbone) and let the tooltip explain.
const SUPERVISION_TARGETS: string[] = [
  'sentinel', 'cartographer', 'nexus', 'analyst', 'observer',
  'sparrow', 'pathfinder',
];

// ─── Headers labelling each cluster region ────────────────────────
const CLUSTER_HEADERS: Array<{ x: number; y: number; label: string }> = [
  { x: -100, y: 150, label: 'Feeds' },
  { x:  100, y: 130, label: 'Intelligence' },
  { x:  100, y: 440, label: 'Surveillance' },
  { x:  920, y:  90, label: 'Platform Ops' },
  { x:  900, y: 450, label: 'Synchronous AI' },
];

// Compact human-readable status used in the feed-node tooltip.
function humanFeedStatus(f: FeedOverview): string {
  if (f.paused_reason === 'auto:consecutive_failures') return `Auto-paused (${f.consecutive_failures} failures)`;
  if (f.paused_reason === 'manual') return 'Paused (manual)';
  if (!f.enabled) return 'Disabled';
  if ((f.consecutive_failures ?? 0) >= 3) return `Failing (${f.consecutive_failures} consecutive)`;
  return 'Active';
}

interface AgentNetworkViewProps {
  agents:        Agent[];
  selectedAgent: string | null;
  onSelect:      (name: string) => void;
}

// Compact control button for the top-right control strip. Stops
// propagation so taps don't bubble to the SVG's pan handler.
function CtrlButton({
  onClick, disabled, children, ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick?.(e); }}
      onMouseDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      disabled={disabled}
      className="w-8 h-8 rounded grid place-items-center transition-colors disabled:opacity-40"
      style={{
        background: 'var(--bg-card-deep)',
        border:     '1px solid var(--border-base)',
        color:      'var(--text-secondary)',
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

export function AgentNetworkView({ agents, selectedAgent, onSelect }: AgentNetworkViewProps) {
  const byName = useMemo(() => {
    const m = new Map<string, Agent>();
    for (const a of agents) m.set(a.name, a);
    return m;
  }, [agents]);

  // ─── Upstream feeds layer ─────────────────────────────────────
  // Read the feed registry directly inside the network view.
  // Only enabled feeds participate — paused / disabled feeds
  // would clutter the picture without adding signal.
  const { data: feedsData = [] } = useFeeds();
  const visibleFeeds = useMemo(
    () => feedsData.filter(f => Boolean(f.enabled)),
    [feedsData]
  );
  // 2-column grid in the negative-x margin, sized to the feed count.
  const FEED_LAYOUT = useMemo(() => {
    const map: Record<string, NodePos> = {};
    const COLS = 2;
    const COL_X = [-100, -50];
    const TOP_Y = 180;
    const ROW_H = 38;
    visibleFeeds.forEach((f, i) => {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      map[f.feed_name] = { x: COL_X[col]!, y: TOP_Y + row * ROW_H };
    });
    return map;
  }, [visibleFeeds]);
  const feedByName = useMemo(() => {
    const m = new Map<string, FeedOverview>();
    for (const f of visibleFeeds) m.set(f.feed_name, f);
    return m;
  }, [visibleFeeds]);

  // ─── Zoom + pan + touch + fullscreen ────────────────────────────
  // SVG viewBox manipulation for zoom/pan (text stays sharp at any
  // zoom). Touch handlers for mobile: 1 finger drag = pan, 2 fingers
  // = pinch zoom + pan around the centroid. Wheel handler attached
  // via useEffect with passive:false so preventDefault works (React's
  // onWheel is passive in modern browsers, ignoring preventDefault).
  // Fullscreen mode pins the wrapper to the viewport via fixed
  // positioning — works everywhere including iOS Safari which has
  // patchy support for the native Fullscreen API on individual
  // elements.
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 3;
  const [zoom, setZoom] = useState(1);
  // Pan default starts at VIEWBOX_X so the negative-x feeds cluster
  // is visible on first load.
  const [pan, setPan]         = useState({ x: VIEWBOX_X, y: 0 });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const isPanning  = useRef(false);
  const panOrigin  = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const panMoved   = useRef(false);
  // Pinch state — distance + centroid between the two fingers at
  // the start of (and most recent) gesture frame.
  const pinchPrev  = useRef<{ dist: number; cx: number; cy: number } | null>(null);
  const svgRef     = useRef<SVGSVGElement | null>(null);

  function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

  // ESC exits fullscreen so users can't get stuck.
  useEffect(() => {
    if (!isFullscreen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setIsFullscreen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isFullscreen]);

  // Anchor a zoom change on a client-space point so the SVG content
  // under that point stays put. Used by both wheel + pinch.
  function anchoredZoom(nextZoom: number, anchorClientX: number, anchorClientY: number) {
    const svg = svgRef.current;
    if (!svg) { setZoom(nextZoom); return; }
    const rect = svg.getBoundingClientRect();
    const fracX = (anchorClientX - rect.left) / rect.width;
    const fracY = (anchorClientY - rect.top)  / rect.height;
    // Current viewBox under the anchor.
    const curVbW = VIEWBOX_W / zoom;
    const curVbH = VIEWBOX_H / zoom;
    const anchorVbX = pan.x + fracX * curVbW;
    const anchorVbY = pan.y + fracY * curVbH;
    // New viewBox dimensions after zoom; reposition pan to keep
    // anchor under the same client point.
    const nextVbW = VIEWBOX_W / nextZoom;
    const nextVbH = VIEWBOX_H / nextZoom;
    setZoom(nextZoom);
    setPan({
      x: anchorVbX - fracX * nextVbW,
      y: anchorVbY - fracY * nextVbH,
    });
  }

  // Native wheel listener (non-passive so preventDefault works).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 1 / 1.10 : 1.10;
      const next = clamp(zoom * delta, ZOOM_MIN, ZOOM_MAX);
      if (next === zoom) return;
      anchoredZoom(next, e.clientX, e.clientY);
    }
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, pan]);

  // Native touch listeners (non-passive so preventDefault stops the
  // browser's pinch-zoom/page-scroll defaults).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    function onTouchStart(e: TouchEvent) {
      if (e.touches.length === 1) {
        const t = e.touches[0]!;
        isPanning.current = true;
        panMoved.current  = false;
        panOrigin.current = { x: t.clientX, y: t.clientY, panX: pan.x, panY: pan.y };
      } else if (e.touches.length === 2) {
        e.preventDefault();
        const a = e.touches[0]!, b = e.touches[1]!;
        const dx = b.clientX - a.clientX;
        const dy = b.clientY - a.clientY;
        pinchPrev.current = {
          dist: Math.hypot(dx, dy),
          cx:   (a.clientX + b.clientX) / 2,
          cy:   (a.clientY + b.clientY) / 2,
        };
        // Cancel any in-progress single-finger pan when the second
        // finger lands so pinch takes over cleanly.
        isPanning.current = false;
      }
    }

    function onTouchMove(e: TouchEvent) {
      if (e.touches.length === 2 && pinchPrev.current) {
        e.preventDefault();
        const a = e.touches[0]!, b = e.touches[1]!;
        const dx = b.clientX - a.clientX;
        const dy = b.clientY - a.clientY;
        const dist = Math.hypot(dx, dy);
        const cx = (a.clientX + b.clientX) / 2;
        const cy = (a.clientY + b.clientY) / 2;

        // (1) Pinch zoom anchored on the gesture centroid.
        const ratio = dist / pinchPrev.current.dist;
        const next  = clamp(zoom * ratio, ZOOM_MIN, ZOOM_MAX);
        if (next !== zoom) anchoredZoom(next, cx, cy);

        // (2) Two-finger pan from centroid translation.
        const rect = svg!.getBoundingClientRect();
        const dxPx = cx - pinchPrev.current.cx;
        const dyPx = cy - pinchPrev.current.cy;
        const dxVb = dxPx * (VIEWBOX_W / next) / rect.width;
        const dyVb = dyPx * (VIEWBOX_H / next) / rect.height;
        setPan(p => ({ x: p.x - dxVb, y: p.y - dyVb }));

        pinchPrev.current = { dist, cx, cy };
        panMoved.current = true;
      } else if (e.touches.length === 1 && isPanning.current) {
        e.preventDefault();
        const t = e.touches[0]!;
        const rect = svg!.getBoundingClientRect();
        const dxPx = t.clientX - panOrigin.current.x;
        const dyPx = t.clientY - panOrigin.current.y;
        if (Math.abs(dxPx) > 3 || Math.abs(dyPx) > 3) panMoved.current = true;
        const dx = dxPx * (VIEWBOX_W / zoom) / rect.width;
        const dy = dyPx * (VIEWBOX_H / zoom) / rect.height;
        setPan({ x: panOrigin.current.panX - dx, y: panOrigin.current.panY - dy });
      }
    }

    function onTouchEnd(e: TouchEvent) {
      if (e.touches.length < 2) pinchPrev.current = null;
      if (e.touches.length === 0) isPanning.current = false;
    }

    svg.addEventListener('touchstart', onTouchStart, { passive: false });
    svg.addEventListener('touchmove',  onTouchMove,  { passive: false });
    svg.addEventListener('touchend',   onTouchEnd);
    svg.addEventListener('touchcancel', onTouchEnd);
    return () => {
      svg.removeEventListener('touchstart', onTouchStart);
      svg.removeEventListener('touchmove',  onTouchMove);
      svg.removeEventListener('touchend',   onTouchEnd);
      svg.removeEventListener('touchcancel', onTouchEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, pan]);

  // Mouse pan (unchanged from before — touch path is separate).
  function handlePanStart(e: React.MouseEvent<SVGSVGElement>) {
    if (e.button !== 0) return;
    isPanning.current = true;
    panMoved.current  = false;
    panOrigin.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  }
  function handlePanMove(e: React.MouseEvent<SVGSVGElement>) {
    if (!isPanning.current) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const dxPx = e.clientX - panOrigin.current.x;
    const dyPx = e.clientY - panOrigin.current.y;
    if (Math.abs(dxPx) > 3 || Math.abs(dyPx) > 3) panMoved.current = true;
    const dx = dxPx * (VIEWBOX_W / zoom) / rect.width;
    const dy = dyPx * (VIEWBOX_H / zoom) / rect.height;
    setPan({ x: panOrigin.current.panX - dx, y: panOrigin.current.panY - dy });
  }
  function handlePanEnd() { isPanning.current = false; }

  // Suppress node click that follows a pan drag — without this any
  // drag that happens to end over a node would also select it.
  function handleNodeClick(name: string) {
    if (panMoved.current) return;
    onSelect(name);
  }

  // Zoom buttons: zoom about the SVG centre so the visible content
  // stays put. Pre-fix this zoomed about (0,0) and the view jumped.
  function zoomBy(factor: number) {
    const svg = svgRef.current;
    const next = clamp(zoom * factor, ZOOM_MIN, ZOOM_MAX);
    if (next === zoom) return;
    if (!svg) { setZoom(next); return; }
    const rect = svg.getBoundingClientRect();
    anchoredZoom(next, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }
  function zoomIn()       { zoomBy(1.20); }
  function zoomOut()      { zoomBy(1 / 1.20); }
  function resetView()    { setZoom(1); setPan({ x: VIEWBOX_X, y: 0 }); }
  function toggleFullscreen() { setIsFullscreen(v => !v); }

  const vbW = VIEWBOX_W / zoom;
  const vbH = VIEWBOX_H / zoom;

  const now = Date.now();

  function ranWithin(name: string, ms: number): boolean {
    const a = byName.get(name);
    if (!a?.last_run_at) return false;
    return now - new Date(a.last_run_at).getTime() < ms;
  }

  // Edges where the upstream agent ran in the last 10 minutes
  const pulsingEdges = useMemo(() => {
    const set = new Set<string>();
    for (const [from, to] of EDGES) {
      if (ranWithin(from, FLY_WINDOW_MS)) set.add(`${from}→${to}`);
    }
    return set;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byName, now]);

  // Comm bursts — upstream AND downstream both ran in the last 60s
  const burstingEdges = useMemo(() => {
    const set = new Set<string>();
    for (const [from, to] of EDGES) {
      if (ranWithin(from, BURST_WINDOW_MS) && ranWithin(to, BURST_WINDOW_MS)) {
        set.add(`${from}→${to}`);
      }
    }
    return set;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byName, now]);

  // Highlight: 1-hop subgraph for the selected node
  function nodeOpacity(name: string): number {
    if (!selectedAgent) return 1;
    if (name === selectedAgent) return 1;
    const isNeighbour = EDGES.some(([f, t]) =>
      (f === selectedAgent && t === name) ||
      (t === selectedAgent && f === name)
    );
    if (isNeighbour) return 1;
    if (name === 'flight_control' && SUPERVISION_TARGETS.includes(selectedAgent)) return 0.6;
    return 0.18;
  }
  function edgeOpacity(from: string, to: string): number {
    if (!selectedAgent) return 0.55;
    if (from === selectedAgent || to === selectedAgent) return 1;
    return 0.08;
  }
  function supervisionOpacity(target: string): number {
    if (!selectedAgent) return 0.16;
    if (target === selectedAgent) return 0.7;
    return 0.05;
  }

  // Fullscreen mode: pin the wrapper to the viewport, full bg, top
  // z-index. CSS-based (not the Fullscreen API) so it works on iOS
  // Safari. Rendered through a React portal attached to document.body
  // so `position: fixed` escapes any backdrop-filter / transform on
  // an ancestor (the surrounding Card uses backdrop-filter for its
  // glass effect, which would otherwise scope `fixed` to the Card
  // box instead of the viewport — the original bug).
  const wrapperClass = isFullscreen
    ? 'fixed inset-0 z-50 p-3 flex flex-col'
    : 'w-full relative';
  const wrapperStyle: React.CSSProperties = isFullscreen
    ? { background: 'var(--bg-page)' }
    : {};

  const view = (
    <div className={wrapperClass} style={wrapperStyle}>
      {/* Zoom controls — top right, layered over the SVG. Touch-tap
          works because the buttons sit above the SVG (z-10) and
          stopPropagation guards against the SVG's pan handlers. */}
      <div
        className={isFullscreen
          ? 'absolute top-3 right-3 z-10 flex gap-1 items-center'
          : 'absolute top-2 right-2 z-10 flex gap-1 items-center'}
      >
        <span
          className="px-2 grid place-items-center font-mono text-[10px]"
          style={{ color: 'var(--text-tertiary)' }}
        >
          {Math.round(zoom * 100)}%
        </span>
        <CtrlButton onClick={zoomOut} disabled={zoom <= ZOOM_MIN} aria-label="Zoom out">
          <ZoomOut size={14} />
        </CtrlButton>
        <CtrlButton onClick={zoomIn} disabled={zoom >= ZOOM_MAX} aria-label="Zoom in">
          <ZoomIn size={14} />
        </CtrlButton>
        <CtrlButton onClick={resetView} aria-label="Reset view">
          <RotateCcw size={14} />
        </CtrlButton>
        <CtrlButton
          onClick={toggleFullscreen}
          aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        >
          {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </CtrlButton>
      </div>
      <svg
        ref={svgRef}
        viewBox={`${pan.x} ${pan.y} ${vbW} ${vbH}`}
        preserveAspectRatio="xMidYMid meet"
        className={isFullscreen
          ? 'w-full flex-1 select-none'
          : 'w-full h-auto select-none'}
        style={{
          maxHeight:   isFullscreen ? undefined : 760,
          cursor:      isPanning.current ? 'grabbing' : 'grab',
          touchAction: 'none', // disable browser pinch/pan so our handlers fire
        }}
        onMouseDown={handlePanStart}
        onMouseMove={handlePanMove}
        onMouseUp={handlePanEnd}
        onMouseLeave={handlePanEnd}
      >
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="9" refY="5"
            markerWidth="6" markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-tertiary)" />
          </marker>
          <marker
            id="arrow-amber"
            viewBox="0 0 10 10"
            refX="9" refY="5"
            markerWidth="6" markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--amber)" />
          </marker>
        </defs>

        {/* Cluster region labels */}
        {CLUSTER_HEADERS.map(h => (
          <text
            key={h.label}
            x={h.x}
            y={h.y}
            fontFamily="var(--font-mono)"
            fontSize={9}
            fontWeight={700}
            fill="var(--text-tertiary)"
            style={{ letterSpacing: '0.20em' }}
          >
            {h.label.toUpperCase()}
          </text>
        ))}

        {/* Supervision edges (Flight Control → workers) — dashed, muted */}
        {SUPERVISION_TARGETS.map(target => {
          const fc  = LAYOUT.flight_control;
          const pos = LAYOUT[target];
          if (!pos) return null;
          return (
            <line
              key={`sup-${target}`}
              x1={fc.x} y1={fc.y + NODE_R}
              x2={pos.x} y2={pos.y - NODE_R}
              stroke="var(--text-muted)"
              strokeWidth={1}
              strokeDasharray="3 4"
              opacity={supervisionOpacity(target)}
            />
          );
        })}

        {/* Feed → Sentinel edges (upstream ingest layer) */}
        {visibleFeeds.map(feed => {
          const fpos = FEED_LAYOUT[feed.feed_name];
          const tpos = LAYOUT.sentinel;
          if (!fpos || !tpos) return null;
          const lastCompletedMs = feed.last_completed
            ? Date.now() - new Date(feed.last_completed).getTime()
            : Infinity;
          const sentinelAgent = byName.get('sentinel');
          const sentinelRanRecently =
            sentinelAgent?.last_run_at &&
            Date.now() - new Date(sentinelAgent.last_run_at).getTime() < BURST_WINDOW_MS;
          const pulsing  = lastCompletedMs < FLY_WINDOW_MS;
          const bursting = lastCompletedMs < BURST_WINDOW_MS && sentinelRanRecently;
          // Edges fade when the user has selected an agent that
          // isn't sentinel (the only feed-edge target).
          const opacity =
            !selectedAgent      ? 0.45
            : selectedAgent === 'sentinel' ? 1
            :                                0.08;
          // Curve from feed (left, small) to sentinel (right, big).
          // Trim endpoints by node radii so arrowheads don't overlap.
          const dx = tpos.x - fpos.x;
          const dy = tpos.y - fpos.y;
          const len = Math.hypot(dx, dy);
          const ux = dx / len;
          const uy = dy / len;
          const x1 = fpos.x + ux * FEED_R;
          const y1 = fpos.y + uy * FEED_R;
          const x2 = tpos.x - ux * (NODE_R + 4);
          const y2 = tpos.y - uy * (NODE_R + 4);
          return (
            <g key={`feed-edge-${feed.feed_name}`} opacity={opacity}>
              <line
                x1={x1} y1={y1} x2={x2} y2={y2}
                stroke={pulsing ? 'var(--amber)' : 'var(--text-tertiary)'}
                strokeWidth={pulsing ? 1.6 : 0.9}
                strokeDasharray={pulsing ? undefined : '2 3'}
                markerEnd={pulsing ? 'url(#arrow-amber)' : 'url(#arrow)'}
              />
              {pulsing && (
                <line
                  x1={x1} y1={y1} x2={x2} y2={y2}
                  stroke="var(--amber)"
                  strokeWidth={5}
                  strokeLinecap="round"
                  opacity={0.20}
                >
                  <animate
                    attributeName="opacity"
                    values="0.05; 0.40; 0.05"
                    dur="2s"
                    repeatCount="indefinite"
                  />
                </line>
              )}
              {bursting && (
                <circle r={3} fill="var(--amber)">
                  <animateMotion
                    dur="1.4s"
                    repeatCount="indefinite"
                    path={`M ${x1} ${y1} L ${x2} ${y2}`}
                  />
                  <animate
                    attributeName="opacity"
                    values="0.0; 1.0; 1.0; 0.0"
                    keyTimes="0; 0.15; 0.85; 1"
                    dur="1.4s"
                    repeatCount="indefinite"
                  />
                </circle>
              )}
            </g>
          );
        })}

        {/* Feed nodes (small circles + labels in negative-x margin) */}
        {visibleFeeds.map(feed => {
          const pos = FEED_LAYOUT[feed.feed_name];
          if (!pos) return null;
          const op = !selectedAgent ? 1 : selectedAgent === 'sentinel' ? 1 : 0.30;
          const ageMs = feed.last_completed
            ? Date.now() - new Date(feed.last_completed).getTime()
            : Infinity;
          const recentlyPulled = ageMs < FLY_WINDOW_MS;
          const failing = (feed.consecutive_failures ?? 0) >= 3;
          const tint = failing ? 'var(--sev-high)' : 'var(--blue)';
          const title = `${feed.display_name || feed.feed_name}\n` +
                        `${humanFeedStatus(feed)}\n` +
                        `${feed.total_ingested.toLocaleString()} ingested · ${feed.total_pulls.toLocaleString()} pulls`;
          return (
            <g
              key={`feed-${feed.feed_name}`}
              opacity={op}
              transform={`translate(${pos.x},${pos.y})`}
            >
              <title>{title}</title>
              {/* Failure ring */}
              {failing && (
                <circle
                  r={FEED_R + 3}
                  fill="none"
                  stroke="var(--sev-critical)"
                  strokeWidth={1.2}
                  opacity={0.85}
                />
              )}
              {/* Recent-pull pulse halo */}
              {recentlyPulled && !failing && (
                <circle
                  r={FEED_R + 2}
                  fill="none"
                  stroke={tint}
                  strokeWidth={1.2}
                  opacity={0.6}
                >
                  <animate
                    attributeName="r"
                    values={`${FEED_R}; ${FEED_R + 6}; ${FEED_R}`}
                    dur="1.8s"
                    repeatCount="indefinite"
                  />
                  <animate
                    attributeName="opacity"
                    values="0.6; 0.0; 0.6"
                    dur="1.8s"
                    repeatCount="indefinite"
                  />
                </circle>
              )}
              <circle
                r={FEED_R}
                fill={tint}
                fillOpacity={0.18}
                stroke={tint}
                strokeWidth={1.2}
              />
              {/* No icon — too small to render. Show first letter
                  centered for at-a-glance identification. */}
              <text
                textAnchor="middle"
                dominantBaseline="central"
                fontFamily="var(--font-mono)"
                fontSize={9}
                fontWeight={700}
                fill={tint}
              >
                {(feed.display_name || feed.feed_name).slice(0, 2).toUpperCase()}
              </text>
              {/* Feed name to the left so it doesn't clash with the
                  sentinel label. Truncated at 12 chars. */}
              <text
                x={-(FEED_R + 4)}
                y={3}
                textAnchor="end"
                fontFamily="var(--font-mono)"
                fontSize={8}
                fill="var(--text-tertiary)"
                style={{ letterSpacing: '0.04em' }}
              >
                {(feed.display_name || feed.feed_name).slice(0, 12)}
              </text>
            </g>
          );
        })}

        {/* Trigger-chain edges */}
        {EDGES.map(([from, to]) => {
          const a = LAYOUT[from];
          const b = LAYOUT[to];
          if (!a || !b) return null;
          const pulsing  = pulsingEdges.has(`${from}→${to}`);
          const bursting = burstingEdges.has(`${from}→${to}`);
          const opacity = edgeOpacity(from, to);
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len = Math.hypot(dx, dy);
          const ux = dx / len;
          const uy = dy / len;
          const x1 = a.x + ux * NODE_R;
          const y1 = a.y + uy * NODE_R;
          const x2 = b.x - ux * (NODE_R + 4);
          const y2 = b.y - uy * (NODE_R + 4);
          const pathId = `path-${from}-${to}`;
          return (
            <g key={`edge-${from}-${to}`} opacity={opacity}>
              {/* Defined path used by both line + animateMotion */}
              <path
                id={pathId}
                d={`M ${x1} ${y1} L ${x2} ${y2}`}
                stroke={pulsing ? 'var(--amber)' : 'var(--text-tertiary)'}
                strokeWidth={pulsing ? 2 : 1.4}
                fill="none"
                markerEnd={pulsing ? 'url(#arrow-amber)' : 'url(#arrow)'}
              />
              {pulsing && (
                <line
                  x1={x1} y1={y1} x2={x2} y2={y2}
                  stroke="var(--amber)"
                  strokeWidth={6}
                  strokeLinecap="round"
                  opacity={0.25}
                >
                  <animate
                    attributeName="opacity"
                    values="0.05; 0.45; 0.05"
                    dur="2s"
                    repeatCount="indefinite"
                  />
                </line>
              )}
              {bursting && (
                <circle r={4} fill="var(--amber)">
                  <animateMotion
                    dur="1.4s"
                    repeatCount="indefinite"
                    path={`M ${x1} ${y1} L ${x2} ${y2}`}
                  />
                  <animate
                    attributeName="opacity"
                    values="0.0; 1.0; 1.0; 0.0"
                    keyTimes="0; 0.15; 0.85; 1"
                    dur="1.4s"
                    repeatCount="indefinite"
                  />
                </circle>
              )}
            </g>
          );
        })}

        {/* Nodes */}
        {Object.entries(LAYOUT).map(([name, pos]) => {
          const meta    = AGENT_METADATA[name as AgentId];
          const agent   = byName.get(name);
          const op      = nodeOpacity(name);
          const isSel   = selectedAgent === name;
          const isSupervisor = name === 'flight_control';
          const failing = agent?.circuit_state === 'tripped' || agent?.last_run_status === 'failed';
          const running = ranWithin(name, RUNNING_WINDOW_MS);
          const tint    = isSupervisor ? 'var(--amber)' : (meta?.color ?? 'var(--blue)');
          return (
            <g
              key={name}
              opacity={op}
              transform={`translate(${pos.x},${pos.y})`}
              style={{ cursor: 'pointer' }}
              onClick={() => handleNodeClick(name)}
            >
              {/* Selection halo (animated amber) */}
              {isSel && (
                <circle
                  r={NODE_R + 8}
                  fill="none"
                  stroke="var(--amber)"
                  strokeWidth={2}
                  opacity={0.7}
                >
                  <animate
                    attributeName="r"
                    values={`${NODE_R + 6}; ${NODE_R + 12}; ${NODE_R + 6}`}
                    dur="2s"
                    repeatCount="indefinite"
                  />
                </circle>
              )}
              {/* Running pulse (animated colored halo) */}
              {running && !isSel && (
                <circle
                  r={NODE_R + 4}
                  fill="none"
                  stroke={tint}
                  strokeWidth={2}
                  opacity={0.6}
                >
                  <animate
                    attributeName="r"
                    values={`${NODE_R + 2}; ${NODE_R + 10}; ${NODE_R + 2}`}
                    dur="1.6s"
                    repeatCount="indefinite"
                  />
                  <animate
                    attributeName="opacity"
                    values="0.7; 0.0; 0.7"
                    dur="1.6s"
                    repeatCount="indefinite"
                  />
                </circle>
              )}
              {/* Failure ring */}
              {failing && !isSel && (
                <circle
                  r={NODE_R + 4}
                  fill="none"
                  stroke="var(--sev-critical)"
                  strokeWidth={1.5}
                  opacity={0.8}
                />
              )}
              <circle
                r={NODE_R}
                fill={tint}
                fillOpacity={isSupervisor ? 0.20 : 0.16}
                stroke={tint}
                strokeWidth={isSupervisor ? 2 : 1.4}
              />
              {/* AgentIcon — embedded via foreignObject so the
                  bespoke per-agent SVG art renders inside the node */}
              <foreignObject
                x={-ICON_SIZE / 2}
                y={-ICON_SIZE / 2}
                width={ICON_SIZE}
                height={ICON_SIZE}
                style={{ color: tint }}
              >
                <div style={{
                  width: ICON_SIZE,
                  height: ICON_SIZE,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: tint,
                }}>
                  <AgentIcon agent={name} size={ICON_SIZE} />
                </div>
              </foreignObject>
              {/* Agent name below the node */}
              <text
                y={NODE_R + 14}
                textAnchor="middle"
                fontFamily="var(--font-mono)"
                fontSize={9}
                fontWeight={isSel ? 700 : 500}
                fill={isSel ? 'var(--text-primary)' : 'var(--text-secondary)'}
                style={{ letterSpacing: '0.06em' }}
              >
                {meta?.displayName ?? name}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="flex items-center gap-4 mt-2 font-mono text-[9px] tracking-wide uppercase flex-wrap" style={{ color: 'var(--text-tertiary)' }}>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-full" style={{ background: 'var(--amber)' }} />
          Supervisor
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-full" style={{ background: 'var(--blue)', opacity: 0.6 }} />
          Feed (upstream)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-6 h-px" style={{ background: 'var(--text-tertiary)' }} />
          Trigger edge
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-6 h-0.5 rounded" style={{ background: 'var(--amber)' }} />
          In flight (last 10m)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-2 h-2 rounded-full" style={{ background: 'var(--amber)' }} />
          Comm burst (both ran ≤ 60s)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-full border-2" style={{ borderColor: 'var(--amber)' }} />
          Running now (≤ 60s)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-6 h-px" style={{ background: 'var(--text-muted)', borderTop: '1px dashed var(--text-muted)' }} />
          Supervision
        </span>
      </div>
    </div>
  );

  // When fullscreen, render through a portal so the fixed-positioned
  // wrapper escapes the parent Card's backdrop-filter containing
  // block. typeof check guards SSR (document is undefined).
  if (isFullscreen && typeof document !== 'undefined') {
    return createPortal(view, document.body);
  }
  return view;
}
