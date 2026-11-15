// Run tape: one lane per agent, one bar per run over the last hour (Canvas 2D).
// Sits under the Flow canvas and shares its hover: hovering a bar lights the
// node above, hovering a node lights its lane.

import { useCallback, useMemo, useRef, useState } from 'react';
import { useTokenColors } from '@averrow/shared/theme';
import type { Span, TimelineIndex } from './activity';
import { makePalette } from './FlowCanvas';
import { fitCanvas, useCanvasLoop, useIsVisible } from './useCanvasLoop';
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
  reducedMotion: boolean;
}

export function RunTape({
  placement, index, status, getNow, hoverId, onHover, selected, onSelect, labelOf, width, reducedMotion,
}: RunTapeProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const spanHover = useRef<{ lane: string; span: Span } | null>(null);
  const [, force] = useState(0);
  const visible = useIsVisible(canvasRef);
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

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !hasData) return;
    const now = getNow();
    const g = tapeGeometry(width, lanes.length, now);
    const ctx = fitCanvas(canvas, g.width, g.height);
    if (!ctx) return;
    const c = palette;
    ctx.clearRect(0, 0, g.width, g.height);

    // Time grid.
    ctx.font = `500 10px ${MONO}`;
    ctx.textAlign = 'center';
    const step = 10 * 60 * 1000;
    for (let t = Math.ceil(g.startMs / step) * step; t < g.endMs; t += step) {
      const x = g.x(t);
      ctx.strokeStyle = c('--border-base', 0.8);
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
        ctx.fillStyle = c('--border-base', 0.22);
        ctx.fillRect(0, y, g.width, g.lh);
      }
      ctx.font = `${lit || selected === lane.id ? 600 : 500} 11px ${SANS}`;
      ctx.textAlign = 'right';
      ctx.fillStyle = lane.muted ? c('--text-muted') : lit ? c('--text-primary') : c('--text-secondary');
      const tag = lane.tag ? ` · ${lane.tag}` : '';
      ctx.fillText(`${lane.label}${tag}`.slice(0, 26), g.gx - 10, y + g.lh / 2 + 4);

      for (const s of index.lanes.get(lane.id) ?? []) {
        const end = s.endMs ?? Math.min(now, index.capMs);
        if (end < g.startMs || s.startMs > g.endMs) continue;
        const xa = g.x(Math.max(s.startMs, g.startMs));
        const xb = g.x(Math.min(end, g.endMs));
        const w = Math.max(xb - xa, 3);
        const running = s.endMs === null && now <= index.capMs;
        ctx.beginPath();
        ctx.roundRect(xa, y + 4, w, g.lh - 8, s.clipped ? [0, 3, 3, 0] : 3);
        ctx.fillStyle = s.status === 'failed' ? c('--sev-critical')
          : running ? c('--primary-text')
          : s.status === 'partial' ? partial(0.85)
          : c('--primary', lane.muted ? 0.4 : 0.75);
        ctx.fill();
        if (running && !reducedMotion) {
          ctx.fillStyle = c('--primary-text', 0.3 + 0.3 * Math.sin(now / 160));
          ctx.beginPath();
          ctx.arc(xb, y + g.lh / 2, 7, 0, Math.PI * 2);
          ctx.fill();
        }
        if (spanHover.current?.span === s) {
          ctx.strokeStyle = c('--text-primary');
          ctx.lineWidth = 1.5;
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
      const l1 = `${lanes[li]?.label ?? h.lane}  ·  ${s.status}${s.endMs === null ? '' : `  ·  ${fmtDuration(s.endMs - s.startMs)}`}`;
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
  }, [hasData, getNow, width, lanes, palette, hoverId, selected, index, reducedMotion]);

  // Only the open-run pulse and the NOW line move: one frame loop while there
  // is any open run, a single draw otherwise.
  const anyOpen = useMemo(() => {
    for (const spans of index.lanes.values()) if (spans.some((s) => s.endMs === null)) return true;
    return false;
  }, [index]);
  useCanvasLoop(draw, !reducedMotion && hasData && anyOpen, visible, [draw, version]);

  if (status !== 'ready' || lanes.length === 0) {
    return (
      <div
        data-testid="run-tape-empty"
        className="font-mono text-[11px] px-3 py-4"
        style={{ color: 'var(--text-tertiary)' }}
        role="status"
      >
        {status === 'loading' && 'Loading the last hour of runs…'}
        {status === 'error' && 'Run timeline unavailable. The map above still shows structure.'}
        {status === 'ready' && 'No agent runs or feed pulls in the last hour.'}
      </div>
    );
  }

  const locate = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const now = getNow();
    return tapeHitTest(tapeGeometry(width, lanes.length, now), lanes, index, now, e.clientX - rect.left, e.clientY - rect.top);
  };

  return (
    <div data-testid="run-tape" data-hover={hoverId ?? ''}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Run tape: ${lanes.length} lanes, runs over the last hour.`}
        style={{ display: 'block', width: geom.width, height: geom.height, touchAction: 'pan-x pan-y' }}
        onPointerMove={(e) => {
          const hit = locate(e);
          const lane: TapeLane | undefined = hit ? lanes[hit.lane] : undefined;
          const next = hit?.span && lane ? { lane: lane.id, span: hit.span } : null;
          if (next?.span !== spanHover.current?.span) {
            spanHover.current = next;
            if (reducedMotion || !anyOpen) draw();
            force((n) => n + 1);
          }
          const id = lane?.id ?? null;
          if (id !== hoverId) onHover(id);
        }}
        onPointerLeave={() => {
          if (spanHover.current) { spanHover.current = null; force((n) => n + 1); }
          if (hoverId !== null) onHover(null);
        }}
        onClick={(e) => {
          const hit = locate(e);
          const lane = hit ? lanes[hit.lane] : undefined;
          if (lane?.agent) onSelect(lane.id);
        }}
      />
      {quiet > 0 && (
        <div className="font-mono text-[10px] px-3 pb-2" style={{ color: 'var(--text-tertiary)' }}>
          {quiet} {quiet === 1 ? 'agent' : 'agents'} had no run in the last hour.
        </div>
      )}
    </div>
  );
}
