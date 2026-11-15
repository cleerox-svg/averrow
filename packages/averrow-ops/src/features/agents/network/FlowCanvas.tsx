// Flow canvas: the staged data-flow picture (Canvas 2D).
//
// Monitors -> Ingest -> Enrich -> Correlate -> Narrate -> Respond, with the
// Flight Control badge across the top and the feed lane on the left.
// Positions come from the stage layout (model.ts), edges from the declared
// EDGES list, motion from the last-hour timeline (activity.ts): particles ride
// an edge only while its upstream run, pull or event is live, and their count
// follows records processed.
//
// Colours are design tokens read at runtime (useTokenColors), so the canvas
// follows theme and accent. Structure lines use --text-muted, not
// --border-base: border tokens are translucent and vanish on dark. Reduced
// motion (or the Pause control) draws a static frame. The frame loop stops
// when the tab is hidden or the canvas is scrolled offscreen, and slows to
// one repaint a second while nothing is running.

import { useCallback, useMemo, useRef } from 'react';
import { useTokenColors, type Rgba } from '@averrow/shared/theme';
import type { Agent } from '@/hooks/useAgents';
import type { FeedOverview } from '@/hooks/useFeeds';
import { AGENT_METADATA, type AgentId } from '@/lib/agent-metadata';
import {
  CRON_LABEL, EDGES, FEED_GROUP_LABEL, FEED_GROUP_NODE, FEED_NRD, FLIGHT_CONTROL, HUB_THREATS, SATELLITES,
  computeLayout, edgePath, hitTest, pointAt,
  type Layout, type LayoutNode, type NetworkEdge, type Placement, type Pt,
} from './model';
import {
  IDLE, activeMembers, edgeActivity, edgeParticles, laneActivity,
  type NodeActivity, type TimelineIndex,
} from './activity';
import { fitCanvas, useCanvasLoop, useIsVisible, useMountedElement } from './useCanvasLoop';

const TOKEN_NAMES = [
  '--bg-page', '--bg-card', '--bg-card-deep', '--border-base', '--text-primary', '--text-secondary',
  '--text-muted', '--primary', '--primary-text', '--primary-ink', '--sev-critical', '--healthy',
] as const;
export type TokenName = (typeof TOKEN_NAMES)[number];

// Plain fallbacks for environments with no stylesheet (tests). Real pages
// always resolve the tokens.
const FALLBACK: Record<TokenName, Rgba> = {
  '--bg-page': [10, 11, 14, 255], '--bg-card': [21, 22, 25, 255], '--bg-card-deep': [27, 28, 32, 255],
  '--border-base': [255, 255, 255, 28], '--text-primary': [246, 247, 247, 255],
  '--text-secondary': [194, 194, 196, 255], '--text-muted': [139, 140, 141, 255],
  '--primary': [76, 92, 248, 255], '--primary-text': [150, 172, 255, 255],
  '--primary-ink': [251, 252, 255, 255], '--sev-critical': [248, 113, 113, 255],
  '--healthy': [60, 184, 120, 255],
};

const HUB_TO_SENTINEL = EDGES.find((e) => e.from === HUB_THREATS && e.to === 'sentinel') as NetworkEdge;

export type Palette = (name: TokenName, alpha?: number) => string;

/** The token's own alpha is kept and multiplied (a translucent token stays
 *  translucent), so structure lines must not be built from --border-base. */
export function makePalette(colors: Record<string, Rgba | null>): Palette {
  return (name, alpha = 1) => {
    const c = colors[name] ?? FALLBACK[name];
    return `rgba(${c[0]},${c[1]},${c[2]},${(c[3] / 255) * alpha})`;
  };
}

/** Alpha channel of an rgba() string made by the palette. */
export function alphaOf(css: string): number {
  const m = /rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/.exec(css);
  return m ? parseFloat(m[1]!) : 1;
}

const SANS = '"Geist", ui-sans-serif, system-ui, sans-serif';
const MONO = '"Geist Mono", ui-monospace, SFMono-Regular, monospace';
/** Slowest-readable pulse: one cycle is about 2.8 s. */
const PULSE = 450;

export function agentLabel(id: string, agents?: ReadonlyMap<string, Agent>): string {
  const meta = AGENT_METADATA[id as AgentId];
  return meta?.displayName ?? agents?.get(id)?.display_name ?? id;
}

function fmtClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function fit(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

/** Text with a card-coloured halo so edges behind a label never cut it. */
function haloText(
  ctx: CanvasRenderingContext2D, c: Palette, text: string, x: number, y: number, fill: string,
): void {
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = c('--bg-card');
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

export interface DrawParams {
  layout: Layout;
  palette: Palette;
  zoom: number;
  agents: ReadonlyMap<string, Agent>;
  index: TimelineIndex;
  hasTimeline: boolean;
  now: number;
  focus: string | null;
  selected: string | null;
  dotHover: string | null;
  reducedMotion: boolean;
}

/** Visible edges for the current focus: spine always, detail only on focus. */
export function visibleEdges(focus: string | null): NetworkEdge[] {
  return EDGES.filter((e) => e.tier === 'spine' || (focus !== null && (e.from === focus || e.to === focus)));
}

export interface EdgeStyle { stroke: string; width: number; dash: number[] }

/** How an edge is stroked. Idle structure reads at >= ~0.28 alpha on dark. */
export function edgeStyle(
  e: Pick<NetworkEdge, 'mechanism' | 'tier'>,
  s: { live: boolean; touches: boolean; dim: boolean },
  c: Palette,
): EdgeStyle {
  if (e.mechanism === 'EVENT') {
    return {
      dash: [6, 5], width: s.live ? 2 : 1.6,
      stroke: s.dim ? c('--primary-text', 0.3) : c('--primary-text', s.live ? 0.95 : 0.75),
    };
  }
  if (e.tier === 'detail') return { dash: [3, 4], width: 1, stroke: c('--primary-text', 0.7) };
  if (e.mechanism === 'INLINE') {
    return {
      dash: [], width: s.live ? 1.8 : 1.2,
      stroke: s.dim ? c('--text-muted', 0.12) : s.live ? c('--primary', 0.85) : s.touches ? c('--primary-text', 0.7) : c('--text-muted', 0.45),
    };
  }
  // TABLE: the quietest link.
  return {
    dash: [], width: s.live ? 1.4 : 1,
    stroke: s.dim ? c('--text-muted', 0.12) : s.live ? c('--primary', 0.6) : s.touches ? c('--primary-text', 0.6) : c('--text-muted', 0.28),
  };
}

function nodeState(p: DrawParams, id: string): NodeActivity & { paused: boolean; tripped: boolean } {
  const a = p.agents.get(id);
  const act = p.hasTimeline ? laneActivity(p.index, id, p.now) : IDLE;
  const tripped = a?.circuit_state === 'tripped';
  const failed = act.failed || tripped || (!p.hasTimeline && a?.last_run_status === 'failed');
  const paused = a?.circuit_state === 'manual_pause' || a?.lifecycle === 'paused';
  return { ...act, failed, paused, tripped };
}

const pathCache = new WeakMap<Layout, Map<string, Pt[]>>();
function pathFor(layout: Layout, e: NetworkEdge, a: LayoutNode, t: LayoutNode): Pt[] {
  let m = pathCache.get(layout);
  if (!m) { m = new Map(); pathCache.set(layout, m); }
  const key = `${e.from}>${e.to}`;
  let path = m.get(key);
  if (!path) {
    path = e.from === FLIGHT_CONTROL
      ? [{ x: t.x, y: layout.badge.y + layout.badge.h }, { x: t.x, y: t.y - t.r - 2 }]
      : edgePath(layout, a, t);
    m.set(key, path);
  }
  return path;
}

function strokePath(ctx: CanvasRenderingContext2D, path: readonly Pt[]): void {
  ctx.beginPath();
  ctx.moveTo(path[0]!.x, path[0]!.y);
  for (let i = 1; i < path.length; i++) ctx.lineTo(path[i]!.x, path[i]!.y);
  ctx.stroke();
}

/** Draws one frame. Returns true while anything on it is animating. */
export function drawFlow(ctx: CanvasRenderingContext2D, p: DrawParams): boolean {
  const { layout, palette: c, now } = p;
  const focus = p.focus && layout.nodes[p.focus] ? p.focus : null;
  let busy = false;
  // Clear the whole scaled backing area: at zoom > 1 the layout-sized rect is
  // smaller than the canvas and would leave a smeared strip.
  ctx.clearRect(0, 0, layout.width * p.zoom, layout.height * p.zoom);
  ctx.save();
  ctx.scale(p.zoom, p.zoom);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Flight Control badge across the top.
  const b = layout.badge;
  ctx.fillStyle = c('--bg-card-deep');
  ctx.strokeStyle = c('--text-muted', 0.4);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(b.x, b.y, b.w, b.h, b.h / 2);
  ctx.fill();
  ctx.stroke();
  const fc = p.agents.get(FLIGHT_CONTROL);
  const fcFailed = fc?.circuit_state === 'tripped';
  const beat = p.reducedMotion ? 1 : 0.5 + 0.5 * Math.sin(now / PULSE);
  ctx.fillStyle = fcFailed ? c('--sev-critical') : c('--healthy', 0.35 + 0.65 * beat);
  ctx.beginPath();
  ctx.arc(b.x + 16, b.y + b.h / 2, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.textAlign = 'left';
  ctx.font = `600 10px ${MONO}`;
  ctx.fillStyle = c('--text-primary');
  ctx.fillText('FLIGHT CONTROL', b.x + 28, b.y + b.h / 2 + 4);
  ctx.font = `400 11px ${SANS}`;
  ctx.fillStyle = c('--text-muted');
  ctx.fillText('supervises every agent · restarts stalls · trips breakers', b.x + 138, b.y + b.h / 2 + 4);

  // Column labels.
  ctx.font = `500 10px ${MONO}`;
  ctx.fillStyle = c('--text-muted');
  for (const col of layout.columns) {
    ctx.textAlign = col.key === 'feeds' ? 'left' : 'center';
    ctx.fillText(col.label, col.x - (col.key === 'feeds' ? 8 : 0), 72);
  }

  // External-input hairline into the monitors column.
  const bus = layout.externalBus;
  const ext = layout.nodes['src:external'];
  if (bus && ext) {
    ctx.strokeStyle = c('--text-muted', 0.2);
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(ext.x + ext.r, ext.y);
    ctx.lineTo(bus.x, ext.y);
    ctx.lineTo(bus.x, bus.y1);
    ctx.stroke();
    for (const s of bus.stubs) {
      ctx.beginPath();
      ctx.moveTo(bus.x, s.y);
      ctx.lineTo(s.x, s.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // Feed group headings.
  ctx.textAlign = 'left';
  ctx.font = `500 10px ${SANS}`;
  for (const n of Object.values(layout.nodes)) {
    if (n.kind !== 'group') continue;
    const mine = layout.dotsByGroup[n.id];
    if (!mine?.length) continue;
    haloText(ctx, c, n.label, mine[0]!.x - 6, mine[0]!.y - 12, focus === n.id ? c('--text-primary') : c('--text-secondary'));
  }

  const edges = visibleEdges(focus);
  const rel = new Set<string>();
  if (focus) {
    rel.add(focus);
    for (const e of EDGES) {
      if (e.from === focus) rel.add(e.to);
      if (e.to === focus) rel.add(e.from);
    }
  }

  // Edges, quiet ones first so live and focused ones sit on top.
  const rank = (e: NetworkEdge) => (focus && (e.from === focus || e.to === focus) ? 3 : e.mechanism === 'TABLE' ? 0 : e.mechanism === 'INLINE' ? 1 : 2);
  const ordered = [...edges].sort((x, y) => rank(x) - rank(y));
  const particles: Pt[] = [];

  for (const e of ordered) {
    const a = layout.nodes[e.from];
    const t = layout.nodes[e.to];
    if (!a || !t) continue;
    const touches = !!focus && (e.from === focus || e.to === focus);
    const dim = !!focus && !touches;
    const act = p.hasTimeline ? edgeActivity(p.index, e, now) : IDLE;
    const path = pathFor(layout, e, a, t);
    const st = edgeStyle(e, { live: act.emitting, touches, dim }, c);
    ctx.setLineDash(st.dash);
    ctx.lineWidth = st.width;
    ctx.strokeStyle = st.stroke;
    strokePath(ctx, path);
    ctx.setLineDash([]);

    if (e.mechanism === 'EVENT') {
      const m = pointAt(path, 0.5);
      ctx.font = `500 10px ${MONO}`;
      ctx.textAlign = 'left';
      haloText(ctx, c, e.via ?? 'event', m.x + 6, m.y - 6, dim ? c('--text-muted', 0.4) : c('--primary-text'));
    }

    if (!dim) {
      for (const k of edgeParticles(e, act, now, p.reducedMotion)) particles.push(pointAt(path, k));
    }
  }
  if (particles.length) busy = true;

  // Feed dots: connector to the group anchor while a feed pulls.
  const activeByGroup = new Map<string, ReturnType<typeof activeMembers>>();
  if (p.hasTimeline) {
    for (const gid of Object.values(FEED_GROUP_NODE)) activeByGroup.set(gid, activeMembers(p.index, gid, now));
  }
  for (const d of layout.dots) {
    const gid = FEED_GROUP_NODE[d.group];
    const st = activeByGroup.get(gid)?.get(d.name);
    const hot = p.dotHover === d.name;
    const dim = !!focus && focus !== gid && !hot;
    const grp = layout.nodes[gid];
    if (st?.emitting && grp && !dim) {
      ctx.beginPath();
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(grp.x, grp.y);
      ctx.strokeStyle = c('--primary-text', 0.35);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(d.x, d.y, hot ? 5 : 4, 0, Math.PI * 2);
    ctx.fillStyle = st?.failed ? c('--sev-critical') : st?.running ? c('--primary-text') : c('--text-muted', dim ? 0.3 : 0.75);
    ctx.fill();
    if (st?.running) {
      busy = true;
      if (!p.reducedMotion) {
        ctx.beginPath();
        ctx.arc(d.x, d.y, 7 + Math.sin(now / PULSE), 0, Math.PI * 2);
        ctx.strokeStyle = c('--primary', 0.5);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  // Particles above edges.
  for (const pt of particles) {
    ctx.fillStyle = c('--primary-text', 0.25);
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = c('--primary-text');
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Nodes.
  for (const n of Object.values(layout.nodes)) {
    if (n.id === FLIGHT_CONTROL || n.kind === 'group') continue;
    const dim = !!focus && !rel.has(n.id);
    ctx.globalAlpha = dim ? 0.3 : 1;
    if (n.kind === 'agent') { if (drawAgentNode(ctx, p, n)) busy = true; }
    else drawPlainNode(ctx, p, n);
    ctx.globalAlpha = 1;
  }

  // Tooltip for the focused node or hovered feed dot.
  const tip = tooltipFor(p, focus);
  if (tip) drawTooltip(ctx, p, tip);

  ctx.restore();
  return busy && !p.reducedMotion;
}

function drawAgentNode(ctx: CanvasRenderingContext2D, p: DrawParams, n: LayoutNode): boolean {
  const { palette: c, now } = p;
  const st = nodeState(p, n.id);
  const sel = p.selected === n.id;
  const calm = p.reducedMotion;
  const satellite = SATELLITES.includes(n.id);

  if (st.running && !st.failed) {
    ctx.fillStyle = c('--primary', 0.18);
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r + 6 + (calm ? 0 : 2 * Math.sin(now / PULSE)), 0, Math.PI * 2);
    ctx.fill();
  }
  if (sel) {
    ctx.strokeStyle = c('--primary-text', 0.9);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r + 9, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = st.running && !st.failed ? c('--primary') : c('--bg-card-deep');
  ctx.strokeStyle = st.failed ? c('--sev-critical') : st.running ? c('--primary-text') : c('--text-muted', 0.45);
  ctx.lineWidth = st.failed ? 2.2 : 1.2;
  // Dashed = paused, or an inline step of its parent rather than a scheduled job.
  ctx.setLineDash(st.paused || satellite ? [3, 3] : []);
  ctx.beginPath();
  ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);

  if (st.running) {
    ctx.strokeStyle = c('--primary-text');
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r + 4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(st.progress, 0.04));
    ctx.stroke();
  }

  const cron = CRON_LABEL[n.id];
  if (cron) {
    ctx.font = `500 ${satellite ? 8 : cron.length > 3 ? 9 : 10}px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = st.running && !st.failed ? c('--primary-ink') : c('--text-muted');
    ctx.fillText(cron, n.x, n.y + 3);
  }
  ctx.font = `500 11px ${SANS}`;
  ctx.textAlign = 'center';
  haloText(ctx, c, fit(ctx, n.label, 118), n.x, n.y + n.r + 16, st.running ? c('--text-primary') : c('--text-secondary'));
  return st.running;
}

function drawPlainNode(ctx: CanvasRenderingContext2D, p: DrawParams, n: LayoutNode): void {
  const { palette: c } = p;
  if (n.kind === 'hub') {
    const emitting = p.hasTimeline && (edgeActivity(p.index, HUB_TO_SENTINEL, p.now).emitting);
    ctx.fillStyle = emitting ? c('--primary', 0.28) : c('--bg-card');
    ctx.strokeStyle = emitting ? c('--primary-text') : c('--text-muted', 0.45);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.roundRect(n.x - n.r, n.y - 15, n.r * 2, 30, 8);
    ctx.fill();
    ctx.stroke();
    ctx.font = `600 11px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = c('--text-primary');
    ctx.fillText('threats', n.x, n.y + 4);
    return;
  }
  // source (nrd_hagezi, abuse inbox, external input)
  const st = n.id === FEED_NRD && p.hasTimeline ? laneActivity(p.index, FEED_NRD, p.now) : IDLE;
  const external = n.id === 'src:external';
  ctx.fillStyle = st.failed ? c('--sev-critical') : st.running ? c('--primary-text') : c('--text-muted', external ? 0.45 : 0.85);
  ctx.beginPath();
  ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = `500 10px ${SANS}`;
  const left = n.col === -1;
  ctx.textAlign = left ? 'left' : 'center';
  const fill = c('--text-secondary');
  if (left) haloText(ctx, c, n.label, n.x + 12, n.y + 4, fill);
  else haloText(ctx, c, n.label, n.x, n.y + n.r + 14, fill);
}

interface Tip { x: number; y: number; r: number; l1: string; l2: string; bad: boolean }

function tooltipFor(p: DrawParams, focus: string | null): Tip | null {
  const { layout, now } = p;
  if (p.dotHover) {
    const d = layout.dots.find((x) => x.name === p.dotHover);
    if (!d) return null;
    const m = activeMembers(p.index, FEED_GROUP_NODE[d.group], now).get(d.name);
    const l2 = !p.hasTimeline ? 'no timeline data' : m ? (m.running ? 'pulling now' : m.failed ? 'last pull failed' : 'pulled in the last hour') : 'no pull in the last hour';
    return { x: d.x, y: d.y, r: 6, l1: `${d.name}  ·  ${FEED_GROUP_LABEL[d.group].toLowerCase()}`, l2, bad: !!m?.failed };
  }
  const id = focus;
  if (!id) return null;
  const n = layout.nodes[id];
  if (!n || n.kind === 'group' || id === FLIGHT_CONTROL) return null;
  if (n.kind !== 'agent') {
    const l2 = n.id === HUB_THREATS ? 'shared table every ingest feed writes' : n.id === 'src:external' ? 'public feeds and registries the monitors read' : 'source';
    return { x: n.x, y: n.y, r: n.r, l1: n.label, l2, bad: false };
  }
  const st = nodeState(p, id);
  const cron = CRON_LABEL[id];
  const l1 = `${n.label}${cron ? `  ·  ${cron}` : ''}`;
  let l2: string;
  if (!p.hasTimeline) {
    l2 = st.failed ? 'last run failed' : 'timeline unavailable';
  } else if (st.running) {
    l2 = `running since ${fmtClock(st.lastStartMs ?? now)} UTC`;
  } else if (st.lastStartMs !== null) {
    l2 = `last run ${fmtClock(st.lastStartMs)} UTC${st.failed ? ' · failed' : ' · ok'}`;
  } else {
    l2 = 'no run in the last hour';
  }
  return { x: n.x, y: n.y, r: n.r, l1, l2, bad: st.failed };
}

function drawTooltip(ctx: CanvasRenderingContext2D, p: DrawParams, tip: Tip): void {
  const { palette: c, layout } = p;
  ctx.font = `500 12px ${SANS}`;
  const w1 = ctx.measureText(tip.l1).width;
  ctx.font = `500 10px ${MONO}`;
  const w2 = ctx.measureText(tip.l2).width;
  const tw = Math.max(w1, w2) + 24;
  let x = tip.x + tip.r + 12;
  let y = tip.y - 52;
  if (x + tw > layout.width - 8) x = tip.x - tip.r - 12 - tw;
  if (y < 48) y = tip.y + tip.r + 10;
  ctx.fillStyle = c('--bg-page');
  ctx.strokeStyle = c('--primary-text');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x, y, tw, 44, 8);
  ctx.fill();
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.font = `500 12px ${SANS}`;
  ctx.fillStyle = c('--text-primary');
  ctx.fillText(tip.l1, x + 12, y + 18);
  ctx.font = `500 10px ${MONO}`;
  ctx.fillStyle = tip.bad ? c('--sev-critical') : c('--text-muted');
  ctx.fillText(tip.l2, x + 12, y + 34);
}

// ─── Component ────────────────────────────────────────────────────────
export interface FlowCanvasProps {
  byName: ReadonlyMap<string, Agent>;
  /** Enabled feeds only. */
  feeds: FeedOverview[];
  index: TimelineIndex;
  hasTimeline: boolean;
  getNow: () => number;
  hoverId: string | null;
  onHover: (id: string | null) => void;
  selected: string | null;
  onSelect: (name: string) => void;
  zoom: number;
  /** Container width in CSS px; the canvas is never narrower than the layout minimum. */
  width: number;
  /** True under the OS preference or the Pause control: a static frame, no loop. */
  reducedMotion: boolean;
  /** Placement is computed by the parent so the rails and canvas agree. */
  placement: Placement;
}

export function FlowCanvas({
  byName, feeds, index, hasTimeline, getNow, hoverId, onHover, selected, onSelect,
  zoom, width, reducedMotion, placement,
}: FlowCanvasProps) {
  const [canvasRef, setCanvasEl, canvasEl] = useMountedElement<HTMLCanvasElement>();
  const dotHoverRef = useRef<string | null>(null);
  const pointerType = useRef<string>('mouse');
  const armed = useRef<string | null>(null);
  const visible = useIsVisible(canvasEl);
  const { colors, version } = useTokenColors(TOKEN_NAMES);
  const palette = useMemo(() => makePalette(colors), [colors]);

  const layout = useMemo(
    () => computeLayout({ width, placement, feeds, labelOf: (id) => agentLabel(id, byName) }),
    [width, placement, feeds, byName],
  );

  const draw = useCallback((): boolean => {
    const canvas = canvasRef.current;
    if (!canvas) return false;
    const ctx = fitCanvas(canvas, layout.width * zoom, layout.height * zoom);
    if (!ctx) return false;
    return drawFlow(ctx, {
      layout, palette, zoom, agents: byName, index, hasTimeline, now: getNow(),
      focus: hoverId ?? selected, selected, dotHover: dotHoverRef.current, reducedMotion,
    });
  }, [layout, palette, zoom, byName, index, hasTimeline, getNow, hoverId, selected, reducedMotion]);

  // No timeline, reduced motion or Pause: draw once per change, no frame loop.
  useCanvasLoop(draw, !reducedMotion && hasTimeline, visible, [draw, version]);

  const pointer = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return hitTest(layout, (e.clientX - rect.left) / zoom, (e.clientY - rect.top) / zoom);
  };

  const sr = useMemo(() => {
    const now = getNow();
    const stateOf = (id: string): string => {
      const a = byName.get(id);
      const act = hasTimeline ? laneActivity(index, id, now) : IDLE;
      if (a?.circuit_state === 'tripped') return 'circuit tripped';
      if (act.running) return 'running';
      if (act.failed) return 'last run failed';
      if (a?.circuit_state === 'manual_pause' || a?.lifecycle === 'paused') return 'paused';
      return 'idle';
    };
    const ids = [...Object.values(placement.stages).flat(), ...placement.onDemand, ...placement.ops];
    return ids.map((id) => ({ id, label: agentLabel(id, byName), state: stateOf(id) }));
    // getNow is stable; the list refreshes with each timeline payload.
  }, [placement, byName, hasTimeline, index, getNow]);

  return (
    <div data-testid="flow-canvas" data-hover={hoverId ?? ''} className="agn-ring-within">
      <canvas
        ref={setCanvasEl}
        role="img"
        aria-label="Agent data-flow map. A text list of every agent and its current state follows."
        style={{
          display: 'block', width: layout.width * zoom, height: layout.height * zoom,
          cursor: hoverId && hoverId !== FLIGHT_CONTROL ? 'pointer' : 'default', touchAction: 'pan-x pan-y',
        }}
        onPointerDown={(e) => { pointerType.current = e.pointerType || 'mouse'; }}
        onPointerMove={(e) => {
          if (e.pointerType === 'touch') return; // touch is tap-to-preview, handled on click
          const hit = pointer(e);
          const dot = hit?.dot ?? null;
          if (dot !== dotHoverRef.current) { dotHoverRef.current = dot; draw(); }
          const id = hit?.id ?? null;
          if (id !== hoverId) onHover(id);
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === 'touch') return;
          dotHoverRef.current = null;
          if (hoverId !== null) onHover(null);
        }}
        onClick={(e) => {
          const hit = pointer(e);
          if (pointerType.current === 'touch') {
            // First tap previews (tooltip + neighbourhood), second tap selects.
            if (!hit) { armed.current = null; onHover(null); return; }
            if (armed.current === hit.id && byName.has(hit.id)) { armed.current = null; onSelect(hit.id); return; }
            armed.current = hit.id;
            dotHoverRef.current = hit.dot ?? null;
            onHover(hit.id);
            return;
          }
          if (hit && byName.has(hit.id)) onSelect(hit.id);
        }}
      />
      <ul className="sr-only" aria-label="Agents and their current state">
        {sr.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              aria-pressed={selected === r.id}
              onFocus={() => onHover(r.id)}
              onBlur={() => onHover(null)}
              onClick={() => onSelect(r.id)}
            >
              {r.label}: {r.state}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
