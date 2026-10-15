/**
 * Observatory event feed: the contract with `GET /api/observatory/events`
 * (packages/averrow-worker/src/handlers/observatoryEvents.ts) plus the pure
 * logic the headline bar and the event rail share. No React, no network.
 *
 *   - contract types and constants (kinds, periods, the warmed default request)
 *   - `parseEventKinds` / `serializeEventKinds`: the `ev` URL key
 *   - copy: kind labels, the "via" line, relative ages, time groups
 *   - the headline queue: order, hold time, stepping
 *   - `eventTargetPatch` / `eventFlyPoint`: what clicking an event does
 */

import { getCountryCentroid, type LngLat } from '@/lib/country-centroids';
import { parseUtc } from '@/lib/time';
import { isLensId } from './lenses';
import type { ObservatoryPatch } from './url-state';

// ─── Contract ────────────────────────────────────────────────

export const EVENT_KINDS = ['critical', 'operation', 'fast', 'lookalike', 'takedown', 'actor', 'spike'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const EVENT_PERIODS = ['1h', '24h', '7d'] as const;
export type EventPeriod = (typeof EVENT_PERIODS)[number];

export type EventSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface ObservatoryEvent {
  id: string;
  kind: EventKind;
  severity: EventSeverity;
  title: string;
  entity: { type: string; id: string | null; name: string };
  place: { country_code: string | null; country_name: string | null; lat: number | null; lng: number | null };
  /** Records this item stands for (> 1 when grouped). */
  count: number;
  occurred_at: string;
  /** Producing agent / surface. */
  source: string;
  target: { lens: string; select?: string };
}

export interface EventsMeta {
  generated_at: string | null;
  period: EventPeriod;
  omitted_kinds: EventKind[];
  capped_kinds: EventKind[];
  failed_kinds: EventKind[];
}

/** What the hook hands to the UI: the envelope, normalised (a missing field reads as empty, never undefined). */
export interface EventsResult {
  events: ObservatoryEvent[];
  counts: Partial<Record<EventKind, number>>;
  meta: EventsMeta;
}

/**
 * The request the Navigator warms (`period=1h&limit=40`, every kind). The default client request MUST be exactly this
 * so it lands on the warmed cache key; navigator-warm-targets.test.ts pins the hook source to these values.
 */
export const EVENTS_DEFAULT_PERIOD: EventPeriod = '1h';
export const EVENTS_DEFAULT_LIMIT = 40;
/** The rail asks for more on the longer windows (the server clamps to 100). */
export const EVENTS_WIDE_LIMIT = 100;

export const EVENTS_EMPTY_META: EventsMeta = {
  generated_at: null, period: EVENTS_DEFAULT_PERIOD, omitted_kinds: [], capped_kinds: [], failed_kinds: [],
};

const KIND_SET: ReadonlySet<string> = new Set(EVENT_KINDS);
export const isEventKind = (v: unknown): v is EventKind => typeof v === 'string' && KIND_SET.has(v);
export const isEventPeriod = (v: unknown): v is EventPeriod => typeof v === 'string' && (EVENT_PERIODS as readonly string[]).includes(v);

/** Rows to request for a rail period. */
export const railLimit = (p: EventPeriod): number => (p === '1h' ? EVENTS_DEFAULT_LIMIT : EVENTS_WIDE_LIMIT);

// ─── `ev` URL key ────────────────────────────────────────────

/** Kinds from a comma string: known ones only, canonical order, deduplicated. Naming all seven is no filter. */
export function parseEventKinds(raw: string | null | undefined): EventKind[] {
  if (!raw) return [];
  const on = new Set(raw.split(',').map(x => x.trim().toLowerCase()));
  const out = EVENT_KINDS.filter(k => on.has(k));
  return out.length === EVENT_KINDS.length ? [] : out;
}

export const serializeEventKinds = (kinds: readonly EventKind[]): string | null => {
  const canon = parseEventKinds(kinds.join(','));
  return canon.length > 0 ? canon.join(',') : null;
};

/** The kinds a viewer may filter by: all of them minus what the server withheld for their role. */
export const visibleKinds = (omitted: readonly EventKind[]): EventKind[] => EVENT_KINDS.filter(k => !omitted.includes(k));

// ─── Copy ────────────────────────────────────────────────────

/** Short tag on the headline bar and the rail rows. */
export const KIND_LABEL: Record<EventKind, string> = {
  critical: 'CRITICAL', operation: 'OPERATION', fast: 'FAST', lookalike: 'LOOKALIKE', takedown: 'TAKEDOWN', actor: 'ACTOR', spike: 'SPIKE',
};
/** Filter chip names. */
export const KIND_CHIP_LABEL: Record<EventKind, string> = {
  critical: 'Critical', operation: 'Operations', fast: 'Fast', lookalike: 'Lookalikes', takedown: 'Takedowns', actor: 'Actors', spike: 'Spikes',
};
/** Spoken kind names (screen readers). */
export const KIND_SPOKEN: Record<EventKind, string> = {
  critical: 'Critical threat', operation: 'Operation', fast: 'Fast weaponization', lookalike: 'Lookalike domain', takedown: 'Takedown', actor: 'Actor link', spike: 'Country spike',
};

const SOURCE_LABEL: Record<string, string> = {
  sentinel: 'Sentinel', nexus: 'NEXUS', lookalike_scanner: 'lookalike scanner', sparrow: 'Sparrow',
  attributor: 'Attributor', manual: 'an analyst', cloudflare_radar: 'Cloudflare Radar',
};
export const sourceLabel = (s: string): string => SOURCE_LABEL[s] ?? s.replace(/_/g, ' ');

/** The rail row's second line: `critical · via Sentinel`. */
export const viaLine = (e: Pick<ObservatoryEvent, 'kind' | 'source'>): string => `${e.kind} · via ${sourceLabel(e.source)}`;

/** Chip colours per kind. Theme tokens only, so both themes get an AA text colour. */
export const KIND_TONE: Record<EventKind, { fg: string; bg: string }> = {
  critical: { fg: 'var(--sev-critical-text)', bg: 'var(--sev-critical-bg)' },
  operation: { fg: 'var(--cyan-text)', bg: 'color-mix(in srgb, var(--cyan-text) 14%, transparent)' },
  fast: { fg: 'var(--sev-high-text)', bg: 'var(--sev-high-bg)' },
  lookalike: { fg: 'var(--sev-medium-text)', bg: 'var(--sev-medium-bg)' },
  takedown: { fg: 'var(--sev-info-text)', bg: 'var(--sev-info-bg)' },
  actor: { fg: 'var(--violet-text)', bg: 'color-mix(in srgb, var(--violet-text) 14%, transparent)' },
  spike: { fg: 'var(--sev-low-text)', bg: 'var(--sev-low-bg)' },
};

/** Severity dot colour. */
export const SEVERITY_DOT: Record<EventSeverity, string> = {
  critical: 'var(--sev-critical)', high: 'var(--sev-high)', medium: 'var(--sev-medium)', low: 'var(--sev-low)', info: 'var(--sev-info)',
};

/** Relative age: `now`, `2m`, `3h`, `4d`. */
export function eventAge(iso: string, nowMs: number): string {
  const t = parseUtc(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Spoken age: `2 minutes ago`. */
export function eventAgeSpoken(iso: string, nowMs: number): string {
  const a = eventAge(iso, nowMs);
  if (a === '' ) return '';
  if (a === 'now') return 'just now';
  const n = parseInt(a, 10);
  const unit = a.endsWith('m') ? 'minute' : a.endsWith('h') ? 'hour' : 'day';
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}

// ─── Time groups (the rail) ──────────────────────────────────

export type AgeGroupKey = 'recent' | 'mid' | 'older';
export interface AgeGroup { key: AgeGroupKey; label: string; events: ObservatoryEvent[] }

export const RECENT_MS = 15 * 60_000;
export const MID_MS = 45 * 60_000;
const GROUP_LABEL: Record<AgeGroupKey, string> = { recent: 'LAST 15 MIN', mid: '15–45 MIN AGO', older: 'OLDER' };

export function ageGroupOf(iso: string, nowMs: number): AgeGroupKey {
  const age = nowMs - parseUtc(iso).getTime();
  return age < RECENT_MS ? 'recent' : age < MID_MS ? 'mid' : 'older';
}

/** Newest-first events split into the three time groups; empty groups are dropped. */
export function groupByAge(events: readonly ObservatoryEvent[], nowMs: number): AgeGroup[] {
  const buckets: Record<AgeGroupKey, ObservatoryEvent[]> = { recent: [], mid: [], older: [] };
  for (const e of events) buckets[ageGroupOf(e.occurred_at, nowMs)].push(e);
  return (['recent', 'mid', 'older'] as const)
    .filter(k => buckets[k].length > 0)
    .map(k => ({ key: k, label: GROUP_LABEL[k], events: buckets[k] }));
}

/** Total records across kinds (the "All N" pill); falls back to the item count when the server sent no counts. */
export function totalCount(counts: EventsResult['counts'], itemCount: number): number {
  const sum = Object.values(counts).reduce<number>((a, n) => a + (typeof n === 'number' ? n : 0), 0);
  return sum > 0 ? sum : itemCount;
}

// ─── Headline queue ──────────────────────────────────────────

export const HEADLINE_HOLD_MS = 6_000;
export const CRITICAL_HOLD_MS = 12_000;

/** Critical events go first (newest first), then the rest in the server's order. */
export function orderQueue(events: readonly ObservatoryEvent[]): ObservatoryEvent[] {
  return [...events.filter(e => e.severity === 'critical'), ...events.filter(e => e.severity !== 'critical')];
}

export const holdFor = (e: Pick<ObservatoryEvent, 'severity'>): number => (e.severity === 'critical' ? CRITICAL_HOLD_MS : HEADLINE_HOLD_MS);

/** Index of `id` in the queue after stepping `dir`; `fallback` (clamped) when `id` is gone. Wraps. */
export function stepIndex(queue: readonly ObservatoryEvent[], id: string | null, dir: 1 | -1, fallback = 0): number {
  const n = queue.length;
  if (n === 0) return -1;
  const at = id === null ? -1 : queue.findIndex(e => e.id === id);
  if (at < 0) return Math.min(Math.max(fallback, 0), n - 1);
  return (at + dir + n) % n;
}

/** Unseen critical events in a queue (what jumps it). */
export const freshCriticals = (queue: readonly ObservatoryEvent[], seen: ReadonlySet<string>): ObservatoryEvent[] =>
  queue.filter(e => e.severity === 'critical' && !seen.has(e.id));

// ─── Click: where the map goes ───────────────────────────────

const COUNTRY_SEL_RE = /^country:[A-Z]{2}$/;
const SEL_RE = /^(country|op|provider|actor|campaign|move):.{1,160}$/;

/** The view state an event's target patch has to account for. */
export interface EventViewState { view: string; measure: string }

/**
 * The URL patch that applies an event's `target`: its lens plus its `sel` (falling back to the event's country when the
 * server gave none), clearing any other selection. Leaves a scene that cannot hold a selection (the heat view, bot share)
 * for the lens's default one, since the drawer is the point of the click.
 */
export function eventTargetPatch(e: Pick<ObservatoryEvent, 'target' | 'place'>, current: EventViewState): ObservatoryPatch {
  const lens = isLensId(e.target.lens) ? e.target.lens : 'threats';
  const cc = e.place.country_code;
  const select = e.target.select && SEL_RE.test(e.target.select) && (!e.target.select.startsWith('country:') || COUNTRY_SEL_RE.test(e.target.select))
    ? e.target.select
    : cc && /^[A-Z]{2}$/.test(cc) ? `country:${cc}` : null;
  const patch: ObservatoryPatch = { lens, node: null, arc: null, sel: select };
  if (lens === 'threats' && current.view === 'heat') patch.view = 'points';
  if (lens === 'baseline' && current.measure === 'bot') patch.measure = 'index';
  return patch;
}

/** Where the camera goes for an event: its own point, else its country's centre, else nowhere. */
export function eventFlyPoint(e: Pick<ObservatoryEvent, 'place'>): LngLat | null {
  const { lat, lng, country_code } = e.place;
  if (typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)) return [lng, lat];
  const c = getCountryCentroid(country_code);
  return c && Number.isFinite(c[0]) && Number.isFinite(c[1]) ? c : null;
}
