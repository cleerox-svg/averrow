// Agent event dispatch planning — coalescing + per-day cap for the
// orchestrator's agent_events consumer (cron/orchestrator.ts
// processAgentEvents).
//
// Why (2026-11-10): `pivot_detected` is the platform's one event-driven edge
// (nexus → observer). NEXUS emits it in bursts — 7-11 dormancy events per
// 4-hourly run (prod 2026-11-09: 60 events in 6 bursts) — and the consumer
// called executeAgent ONCE PER EVENT, up to 10 per tick, each via
// ctx.waitUntil inside the hourly :07 invocation. Observer ignores the event
// payload (an event-triggered run is the same rule-based daily briefing
// without the AI call) and each run read ~1.55M rows, so a burst that
// reached the consumer would have been 10 identical observer runs sharing
// one tick's CPU — the same shape as the 2026-11-04..09 FC recovery storm.
//
// Now: events for the same target in one tick collapse to ONE dispatch (the
// highest-priority event's payload + `coalescedEvents: n`), and each target
// has a per-UTC-day cap on event-triggered runs (KV counter, best-effort).
// Every consumed event is still marked done — capped/coalesced events are
// recorded, not re-queued.

export interface PendingAgentEvent {
  id: string;
  event_type: string;
  source_agent: string;
  target_agent: string | null;
  payload_json: string | null;
  priority: number;
}

/** Default max event-triggered runs per target agent per UTC day. */
export const EVENT_DISPATCH_DAILY_CAP_DEFAULT = 6;

/**
 * Per-target overrides. Observer: its scheduled daily run (dedicated
 * `41 0 * * *` cron) is the briefing; an event-triggered run is a short
 * rule-based pivot report (lib/observer-pivot-report.ts), so a few a day is
 * plenty.
 */
export const EVENT_DISPATCH_DAILY_CAPS: Readonly<Record<string, number>> = {
  observer: 3,
};

export function eventDispatchDailyCap(target: string, caps: Readonly<Record<string, number>> = EVENT_DISPATCH_DAILY_CAPS): number {
  return caps[target] ?? EVENT_DISPATCH_DAILY_CAP_DEFAULT;
}

/** KV key for a target's event-dispatch count on a UTC date (YYYY-MM-DD). */
export function eventDispatchKey(target: string, utcDate: string): string {
  return `agent_events:dispatch:${target}:${utcDate}`;
}

export interface PlannedEventDispatch {
  target: string;
  /** Event whose payload the run receives (first in consumer order). */
  event: PendingAgentEvent;
  /** Every event folded into this one dispatch (includes `event`). */
  eventIds: string[];
  /** The folded events themselves, in consumer order. */
  events: PendingAgentEvent[];
}

export interface AgentEventDispatchPlan {
  dispatches: PlannedEventDispatch[];
  /** Targeted events dropped because the target hit its daily cap. */
  capped: Array<{ target: string; eventIds: string[]; dispatchedToday: number; cap: number }>;
  /** target_agent NULL/'' — telemetry only, never dispatched. */
  telemetryIds: string[];
}

/**
 * Pure: group a tick's pending events by target, one dispatch per target
 * under its daily cap. `events` must already be in consumer order
 * (priority ASC, created_at ASC) — the first event per target is the
 * representative. Unknown-target handling (no module) is the caller's.
 */
export function planAgentEventDispatch(
  events: readonly PendingAgentEvent[],
  dispatchedToday: ReadonlyMap<string, number>,
  caps: Readonly<Record<string, number>> = EVENT_DISPATCH_DAILY_CAPS,
): AgentEventDispatchPlan {
  const byTarget = new Map<string, PendingAgentEvent[]>();
  const telemetryIds: string[] = [];
  for (const e of events) {
    const target = e.target_agent ?? "";
    if (target.length === 0) {
      telemetryIds.push(e.id);
      continue;
    }
    const list = byTarget.get(target);
    if (list) list.push(e);
    else byTarget.set(target, [e]);
  }

  const dispatches: PlannedEventDispatch[] = [];
  const capped: AgentEventDispatchPlan["capped"] = [];
  for (const [target, list] of byTarget) {
    const cap = eventDispatchDailyCap(target, caps);
    const done = dispatchedToday.get(target) ?? 0;
    const eventIds = list.map((e) => e.id);
    if (done >= cap) {
      capped.push({ target, eventIds, dispatchedToday: done, cap });
      continue;
    }
    dispatches.push({ target, event: list[0]!, eventIds, events: list });
  }
  return { dispatches, capped, telemetryIds };
}

/** Parse a KV counter value; anything malformed reads as 0. */
export function parseDispatchCount(raw: string | null): number {
  if (raw === null) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function parsePayload(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Pure: the executeAgent input for one coalesced dispatch. The first event's
 * payload is spread at the top level (back-compat for agents that read a
 * single payload), and EVERY folded event is listed in `events` so the
 * agent can report all of them (observer's pivot report does). A malformed
 * payload reads as {} — it must not drop the rest of the burst.
 */
export function coalescedEventInput(d: PlannedEventDispatch): Record<string, unknown> {
  return {
    ...parsePayload(d.event.payload_json),
    triggeredByEvent: d.event.event_type,
    coalescedEvents: d.events.length,
    events: d.events.map((e) => ({ id: e.id, event_type: e.event_type, payload: parsePayload(e.payload_json) })),
  };
}
