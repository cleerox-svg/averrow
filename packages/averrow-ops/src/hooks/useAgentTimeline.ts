// Last-hour run timeline for the Agents Network view.
//
// One read of `GET /api/agents/timeline?window=1h` (server-cached ~60s)
// returns agent runs, feed pulls and pivot_detected events that overlap the
// window. The Network view draws particles and the Run tape from it.
//
// The response is KV-cached (about 60s), so `generated_at` can be up to a
// minute old. `useTimelineClock` anchors a local "now" to `generated_at` and
// advances it with the client clock since the payload arrived, so the tape and
// progress rings keep moving without extra requests and a skewed client clock
// cannot make a run look finished early. Open runs are only known open as of
// `generated_at`: readers cap them at generated_at + 60s (see activity.ts).
// The key starts with 'agents' so agent mutations that invalidate ['agents']
// refresh it too.

import { useCallback, useRef } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type TimelineStatus = 'success' | 'partial' | 'failed' | 'running';

export interface TimelineRun {
  id: string | number;
  agent_id: string;
  source: 'agent_runs' | 'workflow';
  /** ISO UTC 'Z'. */
  started_at: string;
  completed_at: string | null;
  status: TimelineStatus;
  /** Still in flight (completed_at NULL). */
  open: boolean;
  /** Started before window_start. */
  clipped_start: boolean;
  duration_ms: number | null;
  records_processed: number;
  /** <= 200 chars. */
  error: string | null;
}

export interface TimelinePull {
  id: string | number;
  feed_name: string;
  started_at: string;
  completed_at: string | null;
  status: TimelineStatus;
  open: boolean;
  clipped_start: boolean;
  records_ingested: number;
  records_rejected: number;
  duration_ms: number | null;
  error: string | null;
}

export interface TimelineEvent {
  id: string | number;
  event_type: 'pivot_detected';
  source_agent: string;
  target_agent: string | null;
  created_at: string;
  status: string;
}

export interface AgentTimeline {
  window: '1h';
  generated_at: string;
  window_start: string;
  window_end: string;
  runs: TimelineRun[];
  pulls: TimelinePull[];
  events: TimelineEvent[];
  truncated: { runs: boolean; pulls: boolean; events: boolean };
}

export const TIMELINE_REFETCH_MS = 60_000;

export function useAgentTimeline() {
  return useQuery({
    queryKey: ['agents', 'timeline', '1h'],
    queryFn: async () => {
      const res = await api.get<AgentTimeline>('/api/agents/timeline?window=1h');
      if (!res.success || !res.data) throw new Error(res.error ?? 'Timeline unavailable');
      return res.data;
    },
    placeholderData: keepPreviousData,
    refetchInterval: TIMELINE_REFETCH_MS,
    // A failed refetch keeps the last good data on screen; the view shows a
    // quiet "timeline unavailable" note only when there is nothing to draw.
  });
}

/** Server-anchored clock. Returns a stable `getNow()` (epoch ms) for rAF loops. */
export function useTimelineClock(
  generatedAt: string | undefined,
  receivedAt: number,
  clock: () => number = Date.now,
): () => number {
  const anchor = useRef<{ server: number; local: number } | null>(null);
  const clockRef = useRef(clock);
  clockRef.current = clock;

  // Set synchronously during render of a new payload so the first frame
  // after a refetch already uses the new anchor.
  const server = generatedAt ? Date.parse(generatedAt) : NaN;
  if (Number.isFinite(server)) {
    if (!anchor.current || anchor.current.server !== server) {
      anchor.current = { server, local: receivedAt || clockRef.current() };
    }
  } else {
    anchor.current = null;
  }

  return useCallback(() => {
    const a = anchor.current;
    const c = clockRef.current();
    return a ? a.server + (c - a.local) : c;
  }, []);
}
