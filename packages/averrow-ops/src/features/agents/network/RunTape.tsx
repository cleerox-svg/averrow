// Run tape: one lane per agent, one bar per run over the last hour (Canvas 2D).
// Sits under the Flow canvas and shares its hover: hovering a bar lights the
// node above, hovering a node lights its lane.
//
// A running bar is never signalled by colour alone: it keeps the normal fill,
// gains a bright outline and a solid end cap at the NOW edge. An open run
// older than the snapshot's trust window is drawn neutral and dashed: it may
// have finished since.

import { useCallback, useMemo, useRef } from 'react';
import { useTokenColors } from '@averrow/shared/theme';
import type { Span, TimelineIndex } from './activity';
import { makePalette } from './FlowCanvas';
import { fitCanvas, useCanvasLoop, useIsVisible, useMountedElement } from './useCanvasLoop';
import {
  TAPE_TOP, buildTapeLanes, tapeGeometry, tapeHitTest, type TapeLane,
} from './tape';
import type { Placement } from './model';

const TOKENS = [
  '--bg-page', '--bg-card-deep', '--border-base', '--text-primary', '--text-secondary', '--text-muted',
  '--primary', '--primary-text', '--sev-critical', '--sev-medium',
] as const;
const FALLBACK_PARTIAL = 'rgba(251,191,36,1)';
const SANS = '"Geist", ui-sans-serif, system-ui, sans-serif';
const MONO = '"Geist Mono", ui-monospace, SFMono-Regular, monospace';
const PULSE = 450;

const clock = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  return `${Math.round(s / 60)}m`;
}

function statusWord(s: Span, now: number, capMs: number): string {
  if (s.endMs === null) return now > capMs ? 'status unknown' : 'running';
  return s.status === 'success' ? 'ok' : s.status;
}

export interface RunTapeProps {
  placement: Placement;
  index: TimelineIndex;
  status: 'loading' | 'error' | 'ready';
  getNow: () => number;
  hoverId: string | null;
  onHover: (id: string | null) => void;
  selected: string | null;
  onSelect: (name: string) => void;
  labelOf: (id: string) => string;
  width: number;
  /** True under the OS preference or the Pause control. */
  reducedMotion: boolean;
}

export function RunTape({
  placement, index, status, getNow, hoverId, onHover, selected, onSelect, labelOf, width, reducedMotion,
}: RunTapeProps) {
  const [, setCanvasEl, canvasEl] = useMountedElement<HTMLCanvasElement>();
  const spanHover = useRef<{ lane: string; span: Span } | null>(null);
  const visible = useIsVisible(canvasEl);
  const { colors, version } = useTokenColors(TOKENS);
  const palette = useMemo(() => makePalette(colors), [colors]);
  // A partial run is a warning status: medium severity, never the accent.
  const partial = (a = 1) => {
    const c = colors['--sev-medium'];
    return c ? `rgba(${c[0]},${c[1]},${c[2]},${(c[3] / 255) * a})` : FALLBACK_PARTIAL;
  };

  const { lanes, quiet } = useMemo(() => buildTapeLanes(placement, index, labelOf), [placement, index, labelOf]);
  const geom = useMemo(() => tapeGeometry(width, lanes.length, getNow()), [width, lanes.length, getNow]);
  const hasData = status === 'ready' && lanes.length > 0;

  const draw = useCallback((): boolean => {
    const canvas = canvasEl;
    if (!canvas || !hasData) return false;
    const now = getNow();
    const g = tapeGeometry(width, lanes.length, now);
    const ctx = fitCanvas(canvas, g.width, g.height);
    if (!ctx) return false;
    const c = palette;
    let busy = false;
    ctx.clearRect(0, 0, g.width, g.height);

    // Time grid.
    ctx.font = `500 10px ${MONO}`;
    ctx.textAlign = 'center';
    const step = 10 * 60 * 1000;
    for (let t = Math.ceil(g.startMs / step) * step; t < g.endMs; t += step) {
      const x = g.x(t);
      ctx.strokeStyle = c('--text-muted', 0.18);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, TAPE_TOP - 8);
      ctx.lineTo(x, g.height - 8);
      ctx.stroke();
      ctx.fillStyle = c('--text-muted');
      ctx.fillText(clock(t), x, 16);
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
      const tag = lane.tag ? ` · ${lane.tag}` : '';
      ctx.fillText(`${lane.label}${tag}`.slice(0, 26), g.gx - 10, y + g.lh / 2 + 4);

      for (const s of index.lanes.get(lane.id) ?? []) {
        const open = s.endMs === null;
        const stale = open && now > index.capMs;
        const end = s.endMs ?? Math.min(now, index.capMs);
        if (end < g.startMs || s.startMs > g.endMs) continue;
        const xa = g.x(Math.max(s.startMs, g.startMs));
        const xb = g.x(Math.min(end, g.endMs));
        const w = Math.max(xb - xa, 3);
        const running = open && !stale;
        ctx.beginPath();
        ctx.roundRect(xa, y + 4, w, g.lh - 8, s.clipped ? [0, 3, 3, 0] : 3);
        if (stale) {
          ctx.fillStyle = c('--text-muted', 0.3);
          ctx.fill();
          ctx.setLineDash([3, 2]);
          ctx.strokeStyle = c('--text-muted', 0.8);
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.setLineDash([]);
        } else {
          ctx.fillStyle = s.status === 'failed' ? c('--sev-critical')
            : s.status === 'partial' ? partial(0.85)
            : c('--primary', lane.muted ? 0.6 : 0.75);
          ctx.fill();
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
            ctx.fillStyle = c('--primary-text', 0.25 + 0.25 * Math.sin(now / PULSE));
            ctx.beginPath();
            ctx.arc(xb, y + g.lh / 2, 7, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        if (spanHover.current?.span === s) {
          ctx.strokeStyle = c('--text-primary');
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.roundRect(xa, y + 4, w, g.lh - 8, 3);
          ctx.stroke();
        }
      }
    });

    // NOW marker.
    const xn = g.x(now);
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

    // Tooltip for the hovered bar.
    const h = spanHover.current;
    if (h) {
      const li = lanes.findIndex((l) => l.id === h.lane);
      const s = h.span;
      const l1 = `${lanes[li]?.label ?? h.lane}  ·  ${statusWord(s, now, index.capMs)}${s.endMs === null ? '' : `  ·  ${fmtDuration(s.endMs - s.startMs)}`}`;
      const l2 = `${clock(s.startMs)} UTC  ·  ${s.records.toLocaleString()} records${s.error ? `  ·  ${s.error.slice(0, 60)}` : ''}`;
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
    return busy;
  }, [canvasEl, hasData, getNow, width, lanes, palette, hoverId, selected, index, reducedMotion, colors]);

  // The pulse and NOW line move: a frame loop while any open run is within
  // its trust window (draw reports it), a slow repaint otherwise.
  useCanvasLoop(draw, !reducedMotion && hasData, visible, [draw, version]);

  const srRuns = useMemo(() => {
    const now = getNow();
    return lanes.map((lane) => ({
      lane,
      runs: (index.lanes.get(lane.id) ?? []).slice(-8).reverse().map((s) => (
        `${statusWord(s, now, index.capMs)}, started ${clock(s.startMs)} UTC, ${s.records.toLocaleString()} records`
      )),
    }));
    // getNow is stable; the list refreshes with each timeline payload.
  }, [lanes, index, getNow]);

  if (status !== 'ready' || lanes.length === 0) {
    return (
      <div
        data-testid="run-tape-empty"
        className="font-mono text-[11px] px-3 py-4"
        style={{ color: 'var(--text-tertiary)', minHeight: 180 }}
      >
        {status === 'loading' && <span role="status">Loading the last hour of runs…</span>}
        {status === 'error' && 'Run timeline unavailable. The map above still shows structure.'}
        {status === 'ready' && <span role="status">No agent runs or feed pulls in the last hour.</span>}
      </div>
    );
  }

  const locate = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const now = getNow();
    return tapeHitTest(tapeGeometry(width, lanes.length, now), lanes, index, now, e.clientX - rect.left, e.clientY - rect.top);
  };

  return (
    <div data-testid="run-tape" data-hover={hoverId ?? ''} className="agn-ring-within">
      <canvas
        ref={setCanvasEl}
        role="img"
        aria-label={`Run tape: ${lanes.length} lanes, runs over the last hour. A text list follows.`}
        style={{ display: 'block', width: geom.width, height: geom.height, touchAction: 'pan-x pan-y' }}
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
      <ul className="sr-only" aria-label="Runs in the last hour, by lane">
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
          {quiet} {quiet === 1 ? 'agent' : 'agents'} had no run in the last hour.
        </div>
      )}
    </div>
  );
}
