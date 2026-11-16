// Run tape: one lane per agent, one bar per run over the last hour (Canvas 2D).
// Sits under the Flow canvas and shares its hover: hovering a bar lights the
// node above, hovering a node lights its lane.
//
// A running bar is never signalled by colour alone: it keeps the normal fill,
// gains a bright outline and a solid end cap at the NOW edge. An open run
// older than the snapshot's trust window is drawn neutral and dashed: it may
// have finished since.
//
// Replay: the axis is fixed, a playhead replaces the NOW marker, a run that
// spans the playhead is split there (the part before it reads as in progress,
// the part after it is a ghost, so its final status is not shown early), and
// runs that start after the playhead are ghosts. The time scale above the
// lanes is a keyboard-operable slider; the canvas itself keeps pan/scroll.

import { useCallback, useMemo, useRef } from 'react';
import { useTokenColors } from '@averrow/shared/theme';
import type { Span, TimelineIndex } from './activity';
import { makePalette } from './FlowCanvas';
import { fitCanvas, useCanvasLoop, useIsVisible, useMountedElement } from './useCanvasLoop';
import {
  TAPE_TOP, TAPE_WINDOW_MS, barsForLane, buildTapeLanes, mergeQuantumMs, tapeGeometry, tapeHitTest, tapeTickMs,
  type TapeLane,
} from './tape';
import type { Placement } from './model';
import { fmtHM, fmtHMS } from './replay';
import type { Identity } from './colors';

const TOKENS = [
  '--bg-page', '--bg-card-deep', '--border-base', '--text-primary', '--text-secondary', '--text-muted',
  '--primary', '--primary-text', '--sev-critical', '--sev-medium',
] as const;
const FALLBACK_PARTIAL = 'rgba(251,191,36,1)';
const SANS = '"Geist", ui-sans-serif, system-ui, sans-serif';
const MONO = '"Geist Mono", ui-monospace, SFMono-Regular, monospace';
const PULSE = 450;

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  return `${Math.round(s / 60)}m`;
}

/** Status of a run as of `now` (the live clock or the replay playhead). */
export function statusWord(s: Span, now: number, capMs: number): string {
  if (s.endMs === null) return s.suspect || now > capMs ? 'status unknown' : 'running';
  if (s.endMs > now) return 'running'; // spans the playhead
  return s.status === 'success' ? 'ok' : s.status;
}

export interface TapeReplay {
  /** The fixed time axis anchor (the live axis frozen when replay began). */
  anchorMs: number;
  /** Earliest and latest playhead position. */
  startMs: number;
  endMs: number;
  playing: boolean;
}

export interface RunTapeProps {
  placement: Placement;
  index: TimelineIndex;
  status: 'loading' | 'error' | 'ready';
  /** The view time: the live clock, or the replay playhead. */
  getNow: () => number;
  hoverId: string | null;
  onHover: (id: string | null) => void;
  selected: string | null;
  onSelect: (name: string) => void;
  labelOf: (id: string) => string;
  width: number;
  /** True under the OS preference or the animation control. */
  reducedMotion: boolean;
  /** Replay mode (memoise this object). */
  replay?: TapeReplay | null;
  /** Changes whenever the shown playhead changes: redraws static frames and
   *  refreshes the text equivalent. */
  viewVersion?: number;
  /** Pointer on the time scale scrubs (and enters replay when live). */
  onScrub?: (ms: number) => void;
  /** Keys on the time-scale slider (the parent owns the replay state). */
  onSliderKey?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  sliderRef?: React.Ref<HTMLDivElement>;
  /** The axis length: 1h (default) or 24h. */
  windowMs?: number;
  /** Identity colours: lane bars wear their agent's colour. */
  identity?: Identity;
}

export function RunTape({
  placement, index, status, getNow, hoverId, onHover, selected, onSelect, labelOf, width, reducedMotion,
  replay = null, viewVersion = 0, onScrub, onSliderKey, sliderRef, windowMs = TAPE_WINDOW_MS, identity,
}: RunTapeProps) {
  const [, setCanvasEl, canvasEl] = useMountedElement<HTMLCanvasElement>();
  const spanHover = useRef<{ lane: string; span: Span } | null>(null);
  const ghost = useRef<number | null>(null);
  const scrubbing = useRef(false);
  const visible = useIsVisible(canvasEl);
  const { colors, version } = useTokenColors(TOKENS);
  const palette = useMemo(() => makePalette(colors), [colors]);
  // A partial run is a warning status: medium severity, never the accent.
  const partial = (a = 1) => {
    const c = colors['--sev-medium'];
    return c ? `rgba(${c[0]},${c[1]},${c[2]},${(c[3] / 255) * a})` : FALLBACK_PARTIAL;
  };

  const { lanes, quiet } = useMemo(() => buildTapeLanes(placement, index, labelOf), [placement, index, labelOf]);
  const hasData = status === 'ready' && lanes.length > 0;
  const windowWord = windowMs > TAPE_WINDOW_MS ? 'last 24 hours' : 'last hour';
  // While the replay clock runs the frame loop reads the playhead itself; the
  // version only matters when it is not running (steps, scrubs).
  const drawKey = replay?.playing ? 0 : viewVersion;

  const draw = useCallback((): boolean => {
    const canvas = canvasEl;
    if (!canvas || !hasData) return false;
    // `now` is the view time (live clock or playhead); `anchor` fixes the axis.
    const now = getNow();
    const anchor = replay ? replay.anchorMs : now;
    const phase = Date.now();
    const g = tapeGeometry(width, lanes.length, anchor, windowMs);
    const quantum = mergeQuantumMs(windowMs, g.x1 - g.gx);
    const ctx = fitCanvas(canvas, g.width, g.height);
    if (!ctx) return false;
    const c = palette;
    let busy = false;
    ctx.clearRect(0, 0, g.width, g.height);
    // Ghost outlines need a little more contrast on the light theme.
    const ghostStrokeAlpha = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light' ? 0.7 : 0.55;

    // Playhead pill geometry first, so tick labels can step aside.
    const xn = g.x(now);
    // In live mode the NOW pill is the box a tick label must clear.
    let pill: { lx: number; lw: number };
    if (replay) {
      ctx.font = `600 10px ${MONO}`;
      const lw = ctx.measureText(fmtHMS(now)).width + 10;
      const rightSide = xn > g.x1 - 70;
      pill = { lx: rightSide ? xn - 10 - lw : xn + 10, lw };
    } else {
      pill = { lx: xn - 18, lw: 36 };
    }

    // Time grid.
    ctx.font = `500 10px ${MONO}`;
    ctx.textAlign = 'center';
    const step = tapeTickMs(windowMs);
    for (let t = Math.ceil(g.startMs / step) * step; t < g.endMs; t += step) {
      const x = g.x(t);
      ctx.strokeStyle = c('--text-muted', 0.18);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, TAPE_TOP - 8);
      ctx.lineTo(x, g.height - 8);
      ctx.stroke();
      // Skip a label that would run into the playhead / NOW pill or off the canvas.
      const hidden = (x + 16 > pill.lx - 6 && x - 16 < pill.lx + pill.lw + 6) || x + 17 > g.width;
      if (!hidden) {
        ctx.fillStyle = c('--text-muted');
        ctx.fillText(fmtHM(t), x, 16);
      }
    }

    lanes.forEach((lane, i) => {
      const y = g.top + i * g.lh;
      const lit = hoverId === lane.id || (spanHover.current?.lane === lane.id);
      if (lit) {
        ctx.fillStyle = c('--primary', 0.14);
        ctx.fillRect(0, y, g.width, g.lh);
      } else if (i % 2 === 0) {
        ctx.fillStyle = c('--text-muted', 0.07);
        ctx.fillRect(0, y, g.width, g.lh);
      }
      ctx.font = `${lit || selected === lane.id ? 600 : 500} 11px ${SANS}`;
      ctx.textAlign = 'right';
      ctx.fillStyle = lane.muted ? c('--text-muted') : lit ? c('--text-primary') : c('--text-secondary');
      // Truncate the name, never the tag: the tag says why the lane is muted.
      const tag = lane.tag ? ` · ${lane.tag}` : '';
      const room = g.gx - 18 - ctx.measureText(tag).width;
      let name = lane.label;
      while (name.length > 1 && ctx.measureText(name).width > room) name = name.slice(0, -1);
      if (name !== lane.label) name = `${name.trimEnd()}…`;
      ctx.fillText(`${name}${tag}`, g.gx - 10, y + g.lh / 2 + 4);

      let lastGhost: { x0: number; x1: number } | null = null;
      const ghostBar = (x0: number, x1: number, radii: number | number[]) => {
        // Many tiny ghosts in one lane (grouped feed pulls) would hatch it: skip
        // one that mostly overlaps the previous ghost, and leave a 1px gap.
        if (lastGhost) {
          const overlap = Math.min(x1, lastGhost.x1) - Math.max(x0, lastGhost.x0);
          if (overlap > 0.8 * Math.max(x1 - x0, 1)) return;
        }
        lastGhost = { x0, x1 };
        ctx.beginPath();
        ctx.roundRect(x0 + 0.5, y + 4, Math.max(x1 - x0 - 1, 3), g.lh - 8, radii);
        ctx.fillStyle = c('--text-muted', 0.1);
        ctx.fill();
        ctx.setLineDash([3, 2]);
        ctx.strokeStyle = c('--text-muted', ghostStrokeAlpha);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
      };

      // Lane colour: the agent's identity (feed groups: their own), muted lanes dimmer.
      const laneCss = (a: number) => (identity ? identity.css(lane.id, a) : c('--primary', a));
      // Retired / on-demand lanes sit back; on 24h they drop to about 60% of that.
      const barAlpha = lane.muted ? (windowMs > TAPE_WINDOW_MS ? 0.33 : 0.55) : 0.8;
      if (identity) {
        ctx.fillStyle = laneCss(1);
        ctx.beginPath();
        ctx.arc(g.gx - 4, y + g.lh / 2, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }

      for (const s of barsForLane(index, lane.id, quantum)) {
        const open = s.endMs === null;
        const stale = open && (!!s.suspect || (!replay && now > index.capMs));
        const end = s.endMs ?? (replay ? replay.endMs : Math.min(anchor, index.capMs));
        if (end < g.startMs || s.startMs > g.endMs) continue;
        const xa = g.x(Math.max(s.startMs, g.startMs));
        const xb = g.x(Math.min(end, g.endMs));
        const w = Math.max(xb - xa, s.status === 'failed' ? 3 : windowMs > TAPE_WINDOW_MS ? 1.5 : 3);
        const radii = s.clipped ? [0, 3, 3, 0] : 3;

        if (replay && s.startMs > now) {
          ghostBar(xa, xb, radii); // has not started yet at the playhead
        } else if (replay && !stale && (open ? end >= now : end > now)) {
          // Spans the playhead: in progress up to it, ghost after it.
          const xp = Math.min(Math.max(g.x(now), xa + 3), xb);
          ctx.beginPath();
          ctx.roundRect(xa, y + 4, Math.max(xp - xa, 3), g.lh - 8, radii);
          ctx.fillStyle = laneCss(barAlpha);
          ctx.fill();
          ctx.strokeStyle = c('--primary-text');
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.fillStyle = c('--primary-text');
          ctx.fillRect(Math.max(xp - 3, xa), y + 2, 3, g.lh - 4);
          if (xb > xp + 1) ghostBar(xp, xb, [0, 3, 3, 0]);
          if (!reducedMotion) {
            busy = true;
            ctx.fillStyle = c('--primary-text', 0.25 + 0.25 * Math.sin(phase / PULSE));
            ctx.beginPath();
            ctx.arc(xp, y + g.lh / 2, 7, 0, Math.PI * 2);
            ctx.fill();
          }
        } else {
          const running = !replay && open && !stale;
          ctx.beginPath();
          ctx.roundRect(xa, y + 4, w, g.lh - 8, radii);
          if (stale) {
            ctx.fillStyle = c('--text-muted', 0.3);
            ctx.fill();
            ctx.setLineDash([3, 2]);
            ctx.strokeStyle = c('--text-muted', 0.8);
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.setLineDash([]);
          } else {
            if (s.status === 'failed') {
              // Failure: a 2px red outline and a diagonal stripe, never a solid
              // fill, so a red-family lane colour (solid = ok) cannot hide it.
              ctx.fillStyle = c('--sev-critical', 0.16);
              ctx.fill();
              ctx.strokeStyle = c('--sev-critical');
              ctx.lineWidth = 2;
              ctx.stroke();
              if (w >= 6) {
                ctx.beginPath();
                ctx.moveTo(xa + 2, y + g.lh - 5);
                ctx.lineTo(xa + w - 2, y + 5);
                ctx.stroke();
              }
            } else if (s.status === 'partial') {
              // Partial: a hatched amber bar, so an amber-family lane cannot hide it.
              ctx.fillStyle = partial(0.22);
              ctx.fill();
              ctx.save();
              ctx.clip();
              ctx.strokeStyle = partial(0.95);
              ctx.lineWidth = 1.4;
              ctx.beginPath();
              for (let hx = xa - g.lh; hx < xa + w; hx += 4) {
                ctx.moveTo(hx, y + g.lh - 4);
                ctx.lineTo(hx + g.lh - 8, y + 4);
              }
              ctx.stroke();
              ctx.restore();
              ctx.strokeStyle = partial(1);
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.roundRect(xa, y + 4, w, g.lh - 8, radii);
              ctx.stroke();
            } else {
              ctx.fillStyle = laneCss(barAlpha);
              ctx.fill();
              if (w >= 4) {
                // A thin neutral inner edge: solid with an edge always means ok.
                ctx.strokeStyle = c('--text-primary', 0.2);
                ctx.lineWidth = 1;
                ctx.stroke();
              }
            }
          }
          if (running) {
            // Outline + solid end cap: running reads without relying on colour.
            ctx.strokeStyle = c('--primary-text');
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.fillStyle = c('--primary-text');
            ctx.fillRect(Math.max(xb - 3, xa), y + 2, 3, g.lh - 4);
            if (!reducedMotion) {
              busy = true;
              ctx.fillStyle = c('--primary-text', 0.25 + 0.25 * Math.sin(phase / PULSE));
              ctx.beginPath();
              ctx.arc(xb, y + g.lh / 2, 7, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
        if (spanHover.current?.span === (s.rep ?? s)) {
          ctx.strokeStyle = c('--text-primary');
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.roundRect(xa, y + 4, w, g.lh - 8, 3);
          ctx.stroke();
        }
      }
    });

    // NOW marker, or the replay playhead.
    if (replay && pill) {
      ctx.strokeStyle = c('--primary-text');
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(xn, 22);
      ctx.lineTo(xn, g.height - 6);
      ctx.stroke();
      ctx.fillStyle = c('--primary-text');
      ctx.beginPath();
      ctx.moveTo(xn - 6, 6);
      ctx.lineTo(xn + 6, 6);
      ctx.lineTo(xn, 20);
      ctx.closePath();
      ctx.fill();
      // Label on a page-coloured pill so it never collides with the ticks.
      ctx.font = `600 10px ${MONO}`;
      ctx.fillStyle = c('--bg-page');
      ctx.beginPath();
      ctx.roundRect(pill.lx, 4, pill.lw, 15, 4);
      ctx.fill();
      ctx.strokeStyle = c('--primary-text');
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.textAlign = 'left';
      ctx.fillStyle = c('--text-primary');
      ctx.fillText(fmtHMS(now), pill.lx + 5, 15);
    } else {
      ctx.strokeStyle = c('--text-primary');
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(xn, 22);
      ctx.lineTo(xn, g.height - 6);
      ctx.stroke();
      ctx.fillStyle = c('--text-primary');
      ctx.beginPath();
      ctx.roundRect(xn - 18, 4, 36, 15, 4);
      ctx.fill();
      ctx.font = `600 9px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = c('--bg-page');
      ctx.fillText('NOW', xn, 15);
    }

    // Hover ghost on the time scale: where a click would put the playhead.
    const gh = ghost.current;
    if (gh !== null && !scrubbing.current) {
      const gx = g.x(gh);
      ctx.strokeStyle = c('--text-muted', 0.7);
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(gx, 22);
      ctx.lineTo(gx, g.height - 6);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = `500 10px ${MONO}`;
      const lw = ctx.measureText(fmtHMS(gh)).width + 10;
      const lx = Math.min(Math.max(gx - lw / 2, g.gx), g.x1 - lw);
      ctx.fillStyle = c('--bg-page');
      ctx.beginPath();
      ctx.roundRect(lx, 24, lw, 14, 4);
      ctx.fill();
      ctx.strokeStyle = c('--text-muted', 0.7);
      ctx.stroke();
      ctx.textAlign = 'left';
      ctx.fillStyle = c('--text-secondary');
      ctx.fillText(fmtHMS(gh), lx + 5, 34);
    }

    // Tooltip for the hovered bar.
    const h = spanHover.current;
    if (h) {
      const li = lanes.findIndex((l) => l.id === h.lane);
      const s = h.span;
      const l1 = `${lanes[li]?.label ?? h.lane}  ·  ${statusWord(s, now, index.capMs)}${s.endMs === null ? '' : `  ·  ${fmtDuration(s.endMs - s.startMs)}`}`;
      const l2 = `${fmtHM(s.startMs)} UTC  ·  ${s.records.toLocaleString()} records${s.error ? `  ·  ${s.error.slice(0, 60)}` : ''}`;
      ctx.font = `500 12px ${SANS}`;
      const w1 = ctx.measureText(l1).width;
      ctx.font = `500 10px ${MONO}`;
      const tw = Math.max(w1, ctx.measureText(l2).width) + 24;
      let x = g.x(s.startMs) + 8;
      if (x + tw > g.width - 8) x = g.width - 8 - tw;
      x = Math.max(g.gx, x);
      let y = g.top + li * g.lh - 50;
      if (y < 24) y = g.top + (li + 1) * g.lh + 4;
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
      ctx.fillText(l1, x + 12, y + 18);
      ctx.font = `500 10px ${MONO}`;
      ctx.fillStyle = s.status === 'failed' ? c('--sev-critical') : c('--text-muted');
      ctx.fillText(l2, x + 12, y + 34);
    }
    return busy || (!!replay?.playing && !reducedMotion);
    // drawKey: see above.
  }, [canvasEl, hasData, getNow, width, lanes, palette, hoverId, selected, index, reducedMotion, colors, replay, drawKey, windowMs, identity]);

  // The pulse and NOW line move: a frame loop while any open run is within
  // its trust window (draw reports it), a slow repaint otherwise.
  useCanvasLoop(draw, !reducedMotion && hasData, visible, [draw, version]);

  const srRuns = useMemo(() => {
    const now = getNow();
    return lanes.map((lane) => ({
      lane,
      // Runs that start after the playhead have not happened yet.
      runs: (index.lanes.get(lane.id) ?? []).filter((s) => s.startMs <= now).slice(-8).reverse().map((s) => (
        `${statusWord(s, now, index.capMs)}, started ${fmtHM(s.startMs)} UTC, ${s.records.toLocaleString()} records`
      )),
    })).filter((r) => r.runs.length > 0 || !replay);
    // getNow is stable; the list refreshes with each payload and playhead step.
  }, [lanes, index, getNow, viewVersion, replay]);

  if (status !== 'ready' || lanes.length === 0) {
    return (
      <div
        data-testid="run-tape-empty"
        className="font-mono text-[11px] px-3 py-4"
        style={{ color: 'var(--text-tertiary)', minHeight: 180 }}
      >
        {status === 'loading' && <span role="status">Loading the {windowWord} of runs…</span>}
        {status === 'error' && 'Run timeline unavailable. The map above still shows structure.'}
        {status === 'ready' && <span role="status">No agent runs or feed pulls in the {windowWord}.</span>}
      </div>
    );
  }

  const anchorNow = () => (replay ? replay.anchorMs : getNow());
  const geomNow = () => tapeGeometry(width, lanes.length, anchorNow(), windowMs);
  const locate = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const anchor = anchorNow();
    const g = tapeGeometry(width, lanes.length, anchor, windowMs);
    return tapeHitTest(g, lanes, index, anchor, e.clientX - rect.left, e.clientY - rect.top, mergeQuantumMs(windowMs, g.x1 - g.gx));
  };

  // Slider values: the view time within the playable range.
  const viewNow = getNow();
  const minMs = replay ? replay.startMs : viewNow - windowMs;
  const maxMs = replay ? replay.endMs : viewNow;
  const valueNow = Math.min(Math.max(viewNow, minMs), maxMs);

  const msAt = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return geomNow().t(e.clientX - rect.left);
  };
  const endScrub = (e: React.PointerEvent<HTMLDivElement>) => {
    scrubbing.current = false;
    try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch { /* already released */ }
  };

  return (
    <div data-testid="run-tape" data-hover={hoverId ?? ''} className="agn-ring-within" style={{ position: 'relative', width: geomNow().width }}>
      <canvas
        ref={setCanvasEl}
        role="img"
        aria-label={`Run tape: ${lanes.length} lanes, runs over the ${windowWord}. A text list follows.`}
        style={{ display: 'block', width: geomNow().width, height: geomNow().height, touchAction: 'pan-x pan-y' }}
        onPointerMove={(e) => {
          const hit = locate(e);
          const lane: TapeLane | undefined = hit ? lanes[hit.lane] : undefined;
          const next = hit?.span && lane ? { lane: lane.id, span: hit.span } : null;
          if (next?.span !== spanHover.current?.span) {
            spanHover.current = next;
            draw();
          }
          const id = lane?.id ?? null;
          if (id !== hoverId) onHover(id);
        }}
        onPointerLeave={() => {
          if (spanHover.current) { spanHover.current = null; draw(); }
          if (hoverId !== null) onHover(null);
        }}
        onClick={(e) => {
          const hit = locate(e);
          const lane = hit ? lanes[hit.lane] : undefined;
          if (lane?.agent) onSelect(lane.id);
        }}
      />
      {onScrub && (
        <div
          ref={sliderRef}
          role="slider"
          tabIndex={0}
          aria-label="Replay position"
          aria-orientation="horizontal"
          aria-valuemin={Math.round(minMs)}
          aria-valuemax={Math.round(maxMs)}
          aria-valuenow={Math.round(valueNow)}
          aria-valuetext={`${fmtHMS(valueNow)} UTC`}
          className="agn-slider"
          // Only this strip captures the pointer; the canvas keeps pan/scroll.
          style={{ position: 'absolute', left: 0, top: 0, width: geomNow().width, height: TAPE_TOP - 6, touchAction: 'none', cursor: 'ew-resize' }}
          onKeyDown={onSliderKey}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            scrubbing.current = true;
            e.currentTarget.setPointerCapture?.(e.pointerId);
            ghost.current = null;
            onScrub(msAt(e));
          }}
          onPointerMove={(e) => {
            if (scrubbing.current) {
              if (e.buttons === 0) { endScrub(e); return; }
              onScrub(msAt(e));
              return;
            }
            ghost.current = msAt(e);
            draw();
          }}
          onPointerUp={endScrub}
          onPointerCancel={endScrub}
          onLostPointerCapture={() => { scrubbing.current = false; }}
          onPointerLeave={() => { if (ghost.current !== null) { ghost.current = null; draw(); } }}
        />
      )}
      <ul className="sr-only" aria-label={`Runs in the ${windowWord}, by lane`}>
        {srRuns.map(({ lane, runs }) => (
          <li key={lane.id}>
            {lane.agent ? (
              <button
                type="button"
                aria-pressed={selected === lane.id}
                onFocus={() => onHover(lane.id)}
                onBlur={() => onHover(null)}
                onClick={() => onSelect(lane.id)}
              >
                {lane.label}
              </button>
            ) : (
              <span>{lane.label}</span>
            )}
            <ul>
              {runs.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          </li>
        ))}
      </ul>
      {quiet > 0 && (
        <div className="font-mono text-[10px] px-3 pb-2" style={{ color: 'var(--text-tertiary)' }}>
          {quiet} {quiet === 1 ? 'agent' : 'agents'} had no run in the {windowWord}.
        </div>
      )}
    </div>
  );
}
