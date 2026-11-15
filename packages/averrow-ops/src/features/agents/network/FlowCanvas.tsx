// Flow canvas: the staged data-flow picture (Canvas 2D).
//
// Sources -> Ingest -> Enrich -> Correlate -> Narrate -> Respond, with the
// Flight Control badge across the top. Positions come from the stage layout
// (model.ts), edges from the declared EDGES list, motion from the last-hour
// timeline (activity.ts): particles ride an edge only while its upstream run
// or pull is live, and their count follows records processed.
//
// Colours are design tokens read at runtime (useTokenColors), so the canvas
// follows theme and accent. Reduced motion draws a static frame. The frame
// loop stops when the tab is hidden or the canvas is scrolled offscreen.

import { useCallback, useMemo, useRef } from 'react';
import { useTokenColors, type Rgba } from '@averrow/shared/theme';
import type { Agent } from '@/hooks/useAgents';
import type { FeedOverview } from '@/hooks/useFeeds';
import { AGENT_METADATA, type AgentId } from '@/lib/agent-metadata';
import {
  CRON_LABEL, EDGES, FEED_GROUP_LABEL, FEED_GROUP_NODE, FEED_NRD, FLIGHT_CONTROL, HUB_THREATS,
  bezierAt, computeLayout, edgeCurve, hitTest,
  type Layout, type LayoutNode, type NetworkEdge, type Placement,
} from './model';
import {
  IDLE, activeMembers, edgeActivity, edgeParticles, laneActivity,
  type NodeActivity, type TimelineIndex,
} from './activity';
import { fitCanvas, useCanvasLoop, useIsVisible } from './useCanvasLoop';

const TOKEN_NAMES = [
  '--bg-page', '--bg-card', '--bg-card-deep', '--border-base', '--text-primary', '--text-secondary',
  '--text-muted', '--primary', '--primary-text', '--primary-ink', '--sev-critical', '--healthy',
] as const;
type TokenName = (typeof TOKEN_NAMES)[number];

// Plain fallbacks for environments with no stylesheet (tests). Real pages
// always resolve the tokens.
const FALLBACK: Record<TokenName, Rgba> = {
  '--bg-page': [10, 11, 14, 255], '--bg-card': [21, 22, 25, 255], '--bg-card-deep': [27, 28, 32, 255],
  '--border-base': [42, 43, 49, 255], '--text-primary': [246, 247, 247, 255],
  '--text-secondary': [194, 194, 196, 255], '--text-muted': [139, 140, 141, 255],
  '--primary': [76, 92, 248, 255], '--primary-text': [150, 172, 255, 255],
  '--primary-ink': [251, 252, 255, 255], '--sev-critical': [248, 113, 113, 255],
  '--healthy': [60, 184, 120, 255],
};

const HUB_TO_SENTINEL = EDGES.find((e) => e.from === HUB_THREATS && e.to === 'sentinel') as NetworkEdge;

export type Palette = (name: TokenName, alpha?: number) => string;

export function makePalette(colors: Record<string, Rgba | null>): Palette {
  return (name, alpha = 1) => {
    const c = colors[name] ?? FALLBACK[name];
    return `rgba(${c[0]},${c[1]},${c[2]},${(c[3] / 255) * alpha})`;
  };
}

const SANS = '"Geist", ui-sans-serif, system-ui, sans-serif';
const MONO = '"Geist Mono", ui-monospace, SFMono-Regular, monospace';

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
  retiredCount?: number;
}

/** Visible edges for the current focus: spine always, detail only on focus. */
export function visibleEdges(focus: string | null): NetworkEdge[] {
  return EDGES.filter((e) => e.tier === 'spine' || (focus !== null && (e.from === focus || e.to === focus)));
}

function nodeState(p: DrawParams, id: string): NodeActivity & { paused: boolean; tripped: boolean } {
  const a = p.agents.get(id);
  const act = p.hasTimeline ? laneActivity(p.index, id, p.now) : IDLE;
  const tripped = a?.circuit_state === 'tripped';
  const failed = act.failed || tripped || (!p.hasTimeline && a?.last_run_status === 'failed');
  const paused = a?.circuit_state === 'manual_pause' || a?.lifecycle === 'paused';
  return { ...act, failed, paused, tripped };
}

export function drawFlow(ctx: CanvasRenderingContext2D, p: DrawParams): void {
  const { layout, palette: c, now, focus } = p;
  ctx.clearRect(0, 0, layout.width, layout.height);
  ctx.save();
  ctx.scale(p.zoom, p.zoom);
  ctx.lineCap = 'round';

  // Flight Control badge across the top.
  const b = layout.badge;
  ctx.fillStyle = c('--bg-card-deep');
  ctx.strokeStyle = c('--border-base');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(b.x, b.y, b.w, b.h, b.h / 2);
  ctx.fill();
  ctx.stroke();
  const fc = p.agents.get(FLIGHT_CONTROL);
  const fcFailed = fc?.circuit_state === 'tripped';
  const beat = p.reducedMotion ? 1 : 0.5 + 0.5 * Math.sin(now / 450);
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

  // Feed group headings.
  ctx.textAlign = 'left';
  for (const n of Object.values(layout.nodes)) {
    if (n.kind !== 'group') continue;
    const mine = layout.dots.filter((d) => FEED_GROUP_NODE[d.group] === n.id);
    if (!mine.length) continue;
    const top = Math.min(...mine.map((d) => d.y));
    const lit = focus === n.id;
    ctx.font = `500 10px ${SANS}`;
    ctx.fillStyle = lit ? c('--text-primary') : c('--text-secondary');
    ctx.fillText(n.label, mine[0]!.x - 6, top - 12);
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
  const particles: Array<{ x: number; y: number; k: number }> = [];

  for (const e of ordered) {
    const a = layout.nodes[e.from];
    const t = layout.nodes[e.to];
    if (!a || !t) continue;
    const touches = !!focus && (e.from === focus || e.to === focus);
    const dim = !!focus && !touches;
    const act = p.hasTimeline ? edgeActivity(p.index, e, now) : IDLE;
    const live = act.emitting;

    let curve: number[];
    if (e.from === FLIGHT_CONTROL) {
      curve = [t.x, layout.badge.y + layout.badge.h, t.x, layout.badge.y + layout.badge.h + 12, t.x, t.y - t.r - 14, t.x, t.y - t.r - 2];
    } else {
      curve = edgeCurve(a, t);
    }

    ctx.beginPath();
    ctx.moveTo(curve[0]!, curve[1]!);
    ctx.bezierCurveTo(curve[2]!, curve[3]!, curve[4]!, curve[5]!, curve[6]!, curve[7]!);
    if (e.mechanism === 'EVENT') {
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = live ? 2 : 1.6;
      ctx.strokeStyle = dim ? c('--primary', 0.25) : c('--primary-text', live ? 0.95 : 0.75);
    } else if (e.tier === 'detail') {
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = c('--primary-text', 0.7);
    } else if (e.mechanism === 'INLINE') {
      ctx.setLineDash([]);
      ctx.lineWidth = live ? 1.8 : 1.2;
      ctx.strokeStyle = dim ? c('--border-base', 0.4) : live ? c('--primary', 0.85) : touches ? c('--primary-text', 0.7) : c('--border-base');
    } else {
      // TABLE: the quietest link.
      ctx.setLineDash([]);
      ctx.lineWidth = live ? 1.4 : 0.9;
      ctx.strokeStyle = dim ? c('--border-base', 0.25) : live ? c('--primary', 0.6) : touches ? c('--primary-text', 0.6) : c('--border-base', 0.7);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    if (e.mechanism === 'EVENT') {
      const m = bezierAt(curve, 0.5);
      ctx.font = `500 10px ${MONO}`;
      ctx.textAlign = 'left';
      ctx.fillStyle = dim ? c('--text-muted', 0.4) : c('--primary-text');
      ctx.fillText(e.via ?? 'event', m.x + 6, m.y - 6);
    }

    if (!dim) {
      for (const k of edgeParticles(e, act, now, p.reducedMotion)) {
        const pt = bezierAt(curve, k);
        particles.push({ x: pt.x, y: pt.y, k });
      }
    }
  }

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
    if (st?.running && !p.reducedMotion) {
      ctx.beginPath();
      ctx.arc(d.x, d.y, 7 + Math.sin(now / 160), 0, Math.PI * 2);
      ctx.strokeStyle = c('--primary', 0.5);
      ctx.lineWidth = 1;
      ctx.stroke();
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
    if (n.kind === 'agent') drawAgentNode(ctx, p, n);
    else drawPlainNode(ctx, p, n);
    ctx.globalAlpha = 1;
  }

  // Tooltip for the focused node or hovered feed dot.
  const tip = tooltipFor(p);
  if (tip) drawTooltip(ctx, p, tip);

  ctx.restore();
}

function drawAgentNode(ctx: CanvasRenderingContext2D, p: DrawParams, n: LayoutNode): void {
  const { palette: c, now } = p;
  const st = nodeState(p, n.id);
  const sel = p.selected === n.id;
  const calm = p.reducedMotion;

  if (st.running && !st.failed) {
    ctx.fillStyle = c('--primary', 0.18);
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r + 6 + (calm ? 0 : 2 * Math.sin(now / 160)), 0, Math.PI * 2);
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
  ctx.strokeStyle = st.failed ? c('--sev-critical') : st.running ? c('--primary-text') : c('--border-base');
  ctx.lineWidth = st.failed ? 2.2 : 1.2;
  ctx.setLineDash(st.paused ? [3, 3] : []);
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
  if (cron && n.r >= 14) {
    ctx.font = `500 ${cron.length > 3 ? 9 : 10}px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = st.running && !st.failed ? c('--primary-ink') : c('--text-muted');
    ctx.fillText(cron, n.x, n.y + 3.5);
  }
  ctx.font = `500 11px ${SANS}`;
  ctx.textAlign = 'center';
  ctx.fillStyle = st.running ? c('--text-primary') : c('--text-secondary');
  ctx.fillText(fit(ctx, n.label, 118), n.x, n.y + n.r + 16);
}

function drawPlainNode(ctx: CanvasRenderingContext2D, p: DrawParams, n: LayoutNode): void {
  const { palette: c } = p;
  if (n.kind === 'hub') {
    const emitting = p.hasTimeline && (edgeActivity(p.index, HUB_TO_SENTINEL, p.now).emitting);
    ctx.fillStyle = emitting ? c('--primary', 0.28) : c('--bg-card');
    ctx.strokeStyle = emitting ? c('--primary-text') : c('--border-base');
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
  // source (nrd_hagezi, abuse inbox)
  const st = n.id === FEED_NRD && p.hasTimeline ? laneActivity(p.index, FEED_NRD, p.now) : IDLE;
  ctx.fillStyle = st.failed ? c('--sev-critical') : st.running ? c('--primary-text') : c('--text-muted', 0.85);
  ctx.beginPath();
  ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = `500 10px ${SANS}`;
  ctx.textAlign = n.id === FEED_NRD ? 'left' : 'center';
  ctx.fillStyle = c('--text-secondary');
  if (n.id === FEED_NRD) ctx.fillText(n.label, n.x + 12, n.y + 4);
  else ctx.fillText(n.label, n.x, n.y + n.r + 14);
}

interface Tip { x: number; y: number; r: number; l1: string; l2: string; bad: boolean }

function tooltipFor(p: DrawParams): Tip | null {
  const { layout, now } = p;
  if (p.dotHover) {
    const d = layout.dots.find((x) => x.name === p.dotHover);
    if (!d) return null;
    const m = activeMembers(p.index, FEED_GROUP_NODE[d.group], now).get(d.name);
    const l2 = !p.hasTimeline ? 'no timeline data' : m ? (m.running ? 'pulling now' : m.failed ? 'last pull failed' : 'pulled in the last hour') : 'no pull in the last hour';
    return { x: d.x, y: d.y, r: 6, l1: `${d.name}  ·  ${FEED_GROUP_LABEL[d.group].toLowerCase()}`, l2, bad: !!m?.failed };
  }
  const id = p.focus;
  if (!id) return null;
  const n = layout.nodes[id];
  if (!n || n.kind === 'group' || id === FLIGHT_CONTROL) return null;
  if (n.kind !== 'agent') return { x: n.x, y: n.y, r: n.r, l1: n.label, l2: n.id === HUB_THREATS ? 'shared table every ingest feed writes' : 'source', bad: false };
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
  agents: Agent[];
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
  reducedMotion: boolean;
  /** Placement is computed by the parent so the rails and canvas agree. */
  placement: Placement;
}

export function FlowCanvas({
  agents, feeds, index, hasTimeline, getNow, hoverId, onHover, selected, onSelect,
  zoom, width, reducedMotion, placement,
}: FlowCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dotHoverRef = useRef<string | null>(null);
  const visible = useIsVisible(canvasRef);
  const { colors, version } = useTokenColors(TOKEN_NAMES);
  const palette = useMemo(() => makePalette(colors), [colors]);

  const byName = useMemo(() => new Map(agents.map((a) => [a.name, a])), [agents]);
  const layout = useMemo(
    () => computeLayout({ width, placement, feeds, labelOf: (id) => agentLabel(id, byName) }),
    [width, placement, feeds, byName],
  );

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = fitCanvas(canvas, layout.width * zoom, layout.height * zoom);
    if (!ctx) return;
    drawFlow(ctx, {
      layout, palette, zoom, agents: byName, index, hasTimeline, now: getNow(),
      focus: hoverId ?? selected, selected, dotHover: dotHoverRef.current, reducedMotion,
    });
  }, [layout, palette, zoom, byName, index, hasTimeline, getNow, hoverId, selected, reducedMotion]);

  // No timeline means no motion: draw once per change, never a frame loop.
  useCanvasLoop(draw, !reducedMotion && hasTimeline, visible, [draw, version]);

  const pointer = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const hit = hitTest(layout, (e.clientX - rect.left) / zoom, (e.clientY - rect.top) / zoom);
    return hit;
  };

  const sr = useMemo(() => {
    const rows: Array<{ id: string; label: string; state: string }> = [];
    const stateOf = (id: string, lifecycle?: string): string => {
      if (lifecycle === 'retired') return 'retired';
      const a = byName.get(id);
      const act = hasTimeline ? laneActivity(index, id, getNow()) : IDLE;
      if (a?.circuit_state === 'tripped') return 'circuit tripped';
      if (act.running) return 'running';
      if (act.failed) return 'last run failed';
      if (a?.circuit_state === 'manual_pause') return 'paused';
      return 'idle';
    };
    const ids = [
      ...Object.values(placement.stages).flat(), ...placement.onDemand, ...placement.ops,
    ];
    for (const id of ids) rows.push({ id, label: agentLabel(id, byName), state: stateOf(id) });
    return rows;
    // getNow is stable; the list refreshes with each timeline payload.
  }, [placement, byName, hasTimeline, index, getNow]);

  return (
    <div data-testid="flow-canvas" data-hover={hoverId ?? ''}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="Agent data-flow map. A text list of every agent and its current state follows."
        style={{
          display: 'block', width: layout.width * zoom, height: layout.height * zoom,
          cursor: hoverId && hoverId !== FLIGHT_CONTROL ? 'pointer' : 'default', touchAction: 'pan-x pan-y',
        }}
        onPointerMove={(e) => {
          const hit = pointer(e);
          const dot = hit?.dot ?? null;
          if (dot !== dotHoverRef.current) { dotHoverRef.current = dot; if (reducedMotion || !hasTimeline) draw(); }
          const id = hit?.id ?? null;
          if (id !== hoverId) onHover(id);
        }}
        onPointerLeave={() => {
          if (dotHoverRef.current) { dotHoverRef.current = null; }
          if (hoverId !== null) onHover(null);
        }}
        onClick={(e) => {
          const hit = pointer(e);
          if (hit && byName.has(hit.id)) onSelect(hit.id);
        }}
      />
      <ul className="sr-only" aria-label="Agents and their current state">
        {sr.map((r) => (
          <li key={r.id}>
            <button type="button" onClick={() => onSelect(r.id)}>{r.label}: {r.state}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
