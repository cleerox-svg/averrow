// 5-column × 3-row status-block strip: each column is the last N
// hour buckets (oldest → newest), each row is a parallel instance
// in that bucket. Color encodes the instance's run outcome.
//
// Consumed by both /agents (v2) and /agents-v3 — extracted so the
// "multi-instance running" visualisation stays a single source of
// truth for parallel-scaling visibility.

import { cn } from '@/lib/cn';
import type { AgentTick } from '@/hooks/useAgents';

const COLS = 5;
const ROWS = 3;

function statusBlockClass(status: AgentTick['instances'][number]['status']): string {
  switch (status) {
    case 'success': return 'bg-positive';
    case 'failed':  return 'bg-[#C83C3C]';
    case 'partial': return 'bg-[#fbbf24]';
    case 'running': return 'bg-[#E5A832] animate-pulse';
    default:        return 'bg-white/10';
  }
}

function buildTickTooltip(tick: AgentTick): string {
  if (tick.instances.length === 0) return `${tick.bucket} — no runs`;
  const parts = tick.instances.map((i) => {
    const dur = i.avg_duration_ms != null
      ? `${Math.round(i.avg_duration_ms / 1000)}s`
      : '–';
    return `${i.trigger}: ${i.status}${i.count > 1 ? ` ×${i.count}` : ''} (${dur})`;
  });
  return `${tick.bucket} UTC\n${parts.join('\n')}`;
}

export function RunStatusBlocks({
  ticks,
  fallbackActivity,
}: {
  ticks?: AgentTick[];
  /** 24-hour count array — used as a graceful fallback when the
   *  backend hasn't yet emitted recent_ticks (e.g. stale cache). */
  fallbackActivity?: number[];
}) {
  // Pad/truncate to exactly COLS columns so the strip width is stable
  // regardless of how many ticks the agent has actually produced.
  const padded: (AgentTick | null)[] = [];
  if (ticks && ticks.length > 0) {
    const slice = ticks.slice(-COLS);
    while (slice.length < COLS) slice.unshift(null as unknown as AgentTick);
    padded.push(...slice);
  } else if (fallbackActivity) {
    // Old shape — synthesize 1-instance ticks from non-zero hour counts.
    const last5 = fallbackActivity.slice(-COLS);
    while (last5.length < COLS) last5.unshift(0);
    for (const v of last5) {
      padded.push(v > 0
        ? { bucket: '', instances: [{ status: 'success', trigger: 'cron', count: v, avg_duration_ms: null }] }
        : null);
    }
  } else {
    for (let i = 0; i < COLS; i++) padded.push(null);
  }

  const lastTick = padded[padded.length - 1];
  const lastIsLive = !!lastTick?.instances.some((i) => i.status === 'running');

  return (
    <div className="flex gap-1 items-end">
      {padded.map((tick, colIdx) => {
        const instances = tick?.instances ?? [];
        const tooltip = tick && tick.bucket
          ? buildTickTooltip(tick)
          : 'No runs in this bucket';
        const isLast = colIdx === padded.length - 1;
        return (
          <div
            key={colIdx}
            className="flex flex-col-reverse gap-0.5"
            title={tooltip}
          >
            {Array.from({ length: ROWS }).map((_, rowIdx) => {
              const inst = instances[rowIdx];
              return (
                <div
                  key={rowIdx}
                  className={cn(
                    'w-5 h-2 rounded-sm',
                    inst ? statusBlockClass(inst.status) : 'bg-transparent',
                  )}
                />
              );
            })}
            {/* Optional flourish — running indicator under the
                rightmost column when an instance is still in flight. */}
            {isLast && lastIsLive ? (
              <div
                className="h-px w-5 mt-0.5 rounded-full"
                style={{
                  background: 'var(--amber)',
                  boxShadow:  '0 0 6px var(--amber)',
                  opacity:    0.85,
                }}
              />
            ) : (
              <div className="h-px w-5 mt-0.5" />
            )}
          </div>
        );
      })}
    </div>
  );
}
