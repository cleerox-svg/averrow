import { describe, it, expect } from 'vitest';
import {
  AGENT_ERROR_MIN,
  QUEUE_SOURCE_IDS,
  RECENCY_FLOOR,
  RECENCY_UNKNOWN,
  buildQueue,
  enabledSources,
  rankItems,
  reachFactor,
  recencyDecay,
  scoreItem,
  type QueueItem,
  type QueueSourceId,
  type QueueSources,
} from './home-queue';
import type { Agent } from '@/hooks/useAgents';
import type { Incident } from '@/features/admin-incidents/useIncidents';
import type { CriticalBannerData } from '@/hooks/useCriticalBanner';
import type { DashboardSnapshot } from '@/hooks/useDashboardSnapshot';
import type { AttributionBacklogData } from '@/hooks/useAttributionBacklog';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(NOW - hours * HOUR).toISOString();

function part<T>(p: Partial<T>): T {
  return p as T;
}

function item(over: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'x',
    source: 'alerts',
    severity: 'medium',
    title: 't',
    detail: 'd',
    ts: ago(1),
    reach: 1,
    action: { label: 'Go', to: '/x' },
    ...over,
  };
}

const ok = <T,>(data: T) => ({ status: 'ok' as const, data });

describe('enabledSources (role gating)', () => {
  const sources = (role: string | null) => {
    const e = enabledSources(role);
    return QUEUE_SOURCE_IDS.filter((id) => e[id]);
  };

  it('super_admin gets every source', () => {
    expect(sources('super_admin')).toEqual([...QUEUE_SOURCE_IDS]);
  });

  it('admin gets everything except the super_admin-only incidents and approvals', () => {
    const got = sources('admin');
    expect(got).not.toContain('incidents');
    expect(got).not.toContain('approvals');
    expect(got).toEqual(expect.arrayContaining(['alerts', 'critical_intel', 'agents', 'takedowns', 'feeds', 'attribution', 'brand_candidates']));
  });

  it('analyst gets staff sources plus takedowns (manage_takedowns), no admin sources', () => {
    expect(sources('analyst').sort()).toEqual(['agents', 'alerts', 'critical_intel', 'takedowns']);
  });

  it('support (edit_alerts, no manage_takedowns) gets the staff sources including alerts', () => {
    expect(sources('support').sort()).toEqual(['agents', 'alerts', 'critical_intel']);
  });

  it.each(['sales', 'billing', 'auditor'])('%s (no edit_alerts) gets the staff sources but never alerts', (role) => {
    expect(sources(role).sort()).toEqual(['agents', 'critical_intel']);
  });

  it.each([null, undefined, '', 'client', 'visitor'])('role %j gets nothing', (role) => {
    expect(sources(role as string | null)).toEqual([]);
  });
});

describe('scoring', () => {
  it('recency halves every 24h, floors, and handles missing/future timestamps', () => {
    expect(recencyDecay(ago(0), NOW)).toBeCloseTo(1, 5);
    expect(recencyDecay(ago(24), NOW)).toBeCloseTo(0.5, 5);
    expect(recencyDecay(ago(48), NOW)).toBeCloseTo(0.25, 5);
    expect(recencyDecay(ago(24 * 30), NOW)).toBe(RECENCY_FLOOR);
    expect(recencyDecay(null, NOW)).toBe(RECENCY_UNKNOWN);
    expect(recencyDecay('not a date', NOW)).toBe(RECENCY_UNKNOWN);
    expect(recencyDecay(new Date(NOW + 5 * HOUR).toISOString(), NOW)).toBeCloseTo(1, 5);
  });

  it('reads D1 bare timestamps as UTC', () => {
    expect(recencyDecay('2026-10-03 11:00:00', NOW)).toBeCloseTo(Math.pow(0.5, 1 / 24), 5);
  });

  it('reach is log-damped: 1 -> ~1.15, 100 -> ~2, and never negative', () => {
    expect(reachFactor(0)).toBe(1);
    expect(reachFactor(1)).toBeCloseTo(1.1505, 3);
    expect(reachFactor(99)).toBeCloseTo(2, 5);
    expect(reachFactor(-5)).toBe(1);
  });

  it('a NaN or infinite reach cannot break scoring or sort order', () => {
    expect(reachFactor(Number.NaN)).toBe(1);
    expect(reachFactor(Number.POSITIVE_INFINITY)).toBe(1);
    const bad = item({ id: 'bad', severity: 'critical', reach: Number.NaN, ts: ago(1) });
    expect(Number.isFinite(scoreItem(bad, NOW))).toBe(true);
    const nanTs = item({ id: 'nan-ts', severity: 'high', ts: 'garbage', reach: Number.NaN });
    expect(Number.isFinite(scoreItem(nanTs, NOW))).toBe(true);
    const ranked = rankItems([item({ id: 'low', severity: 'low' }), bad, nanTs], NOW);
    expect(ranked.map((i) => i.id)).toEqual(['bad', 'nan-ts', 'low']);
  });

  it('alerts copy is platform-wide: count + critical detail, never "your queue"', () => {
    const crit = buildQueue({ alerts: ok({ new_count: 3, critical_count: 1 }) }, NOW).items[0]!;
    expect(crit.title).toBe('3 alerts awaiting triage');
    expect(crit.detail).toBe('1 critical');
    const calm = buildQueue({ alerts: ok({ new_count: 1, critical_count: 0 }) }, NOW).items[0]!;
    expect(calm.title).toBe('1 alert awaiting triage');
    expect(calm.detail).toBe('none critical');
    for (const i of [crit, calm]) expect(`${i.title} ${i.detail}`).not.toMatch(/your/i);
  });

  it('score = severity weight x recency x reach', () => {
    const i = item({ severity: 'high', ts: ago(24), reach: 99 });
    expect(scoreItem(i, NOW)).toBeCloseTo(4 * 0.5 * 2, 5);
  });
});

describe('rankItems', () => {
  it('a fresh critical outranks an old high', () => {
    const ranked = rankItems([
      item({ id: 'old-high', severity: 'high', ts: ago(72) }),
      item({ id: 'fresh-crit', severity: 'critical', ts: ago(1) }),
    ], NOW);
    expect(ranked.map((i) => i.id)).toEqual(['fresh-crit', 'old-high']);
  });

  it('a very old critical still outranks a fresh medium (floor keeps open items visible)', () => {
    const ranked = rankItems([
      item({ id: 'fresh-med', severity: 'medium', ts: ago(0) }),
      item({ id: 'old-crit', severity: 'critical', ts: ago(24 * 20) }),
    ], NOW);
    expect(ranked[0]?.id).toBe('old-crit');
  });

  it('large reach lifts an item but cannot make a low item beat a critical', () => {
    const ranked = rankItems([
      item({ id: 'huge-low', severity: 'low', reach: 4000, ts: ago(0) }),
      item({ id: 'single-crit', severity: 'critical', reach: 1, ts: ago(0) }),
    ], NOW);
    expect(ranked[0]?.id).toBe('single-crit');
    const a = scoreItem(item({ severity: 'medium', reach: 1000, ts: ago(0) }), NOW);
    const b = scoreItem(item({ severity: 'medium', reach: 1, ts: ago(0) }), NOW);
    expect(a).toBeGreaterThan(b);
  });

  it('is stable: equal scores order by id', () => {
    const ranked = rankItems([item({ id: 'b' }), item({ id: 'a' })], NOW);
    expect(ranked.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('does not mutate its input', () => {
    const input = [item({ id: 'a', severity: 'low' }), item({ id: 'b', severity: 'critical' })];
    rankItems(input, NOW);
    expect(input.map((i) => i.id)).toEqual(['a', 'b']);
  });
});

describe('buildQueue', () => {
  const critBanner = (events: CriticalBannerData['events']): CriticalBannerData => ({
    events, total: events.length, generated_at: ago(0),
  });

  it('turns each source into items with a canonical action link', () => {
    const q = buildQueue({
      alerts: ok({ new_count: 12, critical_count: 2 }),
      incidents: ok([part<Incident>({ severity: 'critical', created_at: ago(2) }), part<Incident>({ severity: 'low', created_at: ago(5) })]),
      approvals: ok({ pending: [{ agent_id: 'a', requested_at: ago(3) } as never] }),
      takedowns: ok({ statusCounts: [{ status: 'draft', count: 3 }, { status: 'requested', count: 2 }, { status: 'completed', count: 99 }] }),
    }, NOW);

    const byId = Object.fromEntries(q.items.map((i) => [i.id, i]));
    expect(byId['alerts:triage']).toMatchObject({ severity: 'critical', reach: 12, action: { label: 'Triage', to: '/console?tab=alerts&status=new' } });
    expect(byId['incidents:open']).toMatchObject({ severity: 'critical', reach: 2, action: { to: '/console?tab=incidents' } });
    expect(byId['approvals:pending']).toMatchObject({ severity: 'medium', action: { to: '/agents/approvals' } });
    expect(byId['takedowns:queue']).toMatchObject({ reach: 5, action: { to: '/console?tab=takedowns' } });
    expect(byId['takedowns:queue']?.detail).toBe('3 draft · 2 requested');
    expect(q.failed).toEqual([]);
    expect(q.clear).toBe(false);
  });

  it('alerts action opens the top alert when the summary has one, else the new-alerts triage list', () => {
    const top = { id: 'alr_9', title: 'x', severity: 'critical', brand_id: 'b1', brand_name: 'Acme', alert_type: 'phishing_detected', created_at: ago(1) };
    const withTop = buildQueue({ alerts: ok({ new_count: 4, critical_count: 1, top }) }, NOW).items[0]!;
    expect(withTop.action).toEqual({ label: 'Open alert', to: '/console?tab=alerts&status=new&alert=alr_9' });
    const nullTop = buildQueue({ alerts: ok({ new_count: 4, critical_count: 1, top: null }) }, NOW).items[0]!;
    expect(nullTop.action).toEqual({ label: 'Triage', to: '/console?tab=alerts&status=new' });
    const noTop = buildQueue({ alerts: ok({ new_count: 4, critical_count: 0 }) }, NOW).items[0]!;
    expect(noTop.action).toEqual({ label: 'Triage', to: '/console?tab=alerts&status=new' });
  });

  it('encodes the top alert id in the link', () => {
    const top = { id: 'a b&c', title: 'x', severity: 'high', brand_id: 'b1', brand_name: null, alert_type: 't', created_at: ago(1) };
    const item = buildQueue({ alerts: ok({ new_count: 1, critical_count: 0, top }) }, NOW).items[0]!;
    expect(item.action.to).toBe('/console?tab=alerts&status=new&alert=a%20b%26c');
  });

  it('ignores takedowns in other statuses', () => {
    const q = buildQueue({ takedowns: ok({ statusCounts: [{ status: 'completed', count: 40 }] }) }, NOW);
    expect(q.items).toEqual([]);
    expect(q.clear).toBe(true);
  });

  it('critical-intel events become one item each, linking to the event', () => {
    const q = buildQueue({
      critical_intel: ok(critBanner([
        { kind: 'burst', title: 'Burst on acme.com', subtitle: '40 in 1h', link: '/brands/acme', severity: 'critical', ts: ago(1) },
        { kind: 'new_campaign', title: 'Campaign Z', subtitle: 'new', link: '/campaigns/z', severity: 'high', ts: ago(2) },
      ])),
    }, NOW);
    expect(q.items.map((i) => i.action.to).sort()).toEqual(['/brands/acme', '/campaigns/z']);
    expect(q.items[0]?.id).toContain('critical_intel:burst');
  });

  it('always drops the banner "open critical alerts" event when the alerts source is enabled (same platform-wide number), and keeps it when it is not', () => {
    const events: CriticalBannerData['events'] = [
      { kind: 'open_critical_alerts', title: '3 open critical', subtitle: '', link: '/console?tab=alerts', severity: 'critical', ts: ago(1) },
    ];
    const withAlerts = buildQueue({ alerts: ok({ new_count: 5, critical_count: 3 }), critical_intel: ok(critBanner(events)) }, NOW);
    expect(withAlerts.items.map((i) => i.source)).toEqual(['alerts']);
    // Dropped even when the alerts item carries no criticals, or nothing is awaiting triage.
    const noCrit = buildQueue({ alerts: ok({ new_count: 5, critical_count: 0 }), critical_intel: ok(critBanner(events)) }, NOW);
    expect(noCrit.items.map((i) => i.source)).toEqual(['alerts']);
    const none = buildQueue({ alerts: ok({ new_count: 0, critical_count: 0 }), critical_intel: ok(critBanner(events)) }, NOW);
    expect(none.items).toEqual([]);
    // Kept while the alerts source is still loading or has failed: the banner
    // event is then the only critical-alert signal on screen.
    const loading = buildQueue({ alerts: { status: 'loading' }, critical_intel: ok(critBanner(events)) }, NOW);
    expect(loading.items.map((i) => i.source)).toEqual(['critical_intel']);
    const failed = buildQueue({ alerts: { status: 'error' }, critical_intel: ok(critBanner(events)) }, NOW);
    expect(failed.items.map((i) => i.source)).toEqual(['critical_intel']);
    expect(failed.failed).toEqual(['alerts']);
    // A role without the alerts source (sales/billing/auditor) keeps the banner event.
    const gated = buildQueue({ critical_intel: ok(critBanner(events)) }, NOW);
    expect(gated.items.map((i) => i.source)).toEqual(['critical_intel']);
  });

  it('agents: tripped circuits are high, errors need AGENT_ERROR_MIN, manual pauses are ignored', () => {
    const agent = (o: Partial<Agent>) => part<Agent>({ agent_id: 'a', display_name: 'A', error_count_24h: 0, circuit_state: 'closed', last_run_at: ago(1), ...o });
    const q = buildQueue({
      agents: ok([
        agent({ agent_id: 't', display_name: 'Tripped', circuit_state: 'tripped' }),
        agent({ agent_id: 'e', display_name: 'Erroring', error_count_24h: AGENT_ERROR_MIN }),
        agent({ agent_id: 'n', display_name: 'Noisy', error_count_24h: AGENT_ERROR_MIN - 1 }),
        agent({ agent_id: 'p', display_name: 'Paused', circuit_state: 'manual_pause', error_count_24h: 50 }),
      ]),
    }, NOW);
    expect(q.items.map((i) => i.id).sort()).toEqual(['agents:errors', 'agents:tripped']);
    expect(q.items.find((i) => i.id === 'agents:tripped')).toMatchObject({ severity: 'high', reach: 1 });
    expect(q.items.find((i) => i.id === 'agents:errors')?.detail).toContain('Erroring');
  });

  it('feeds: critical at-risk feeds are critical, others high', () => {
    const snap = (sev: 'critical' | 'high') => part<DashboardSnapshot>({
      feeds: { at_risk_count: 2, at_risk: [{ feed_name: 'f', display_name: 'Feed F', severity: sev }] } as DashboardSnapshot['feeds'],
    });
    expect(buildQueue({ feeds: ok(snap('critical')) }, NOW).items[0]?.severity).toBe('critical');
    expect(buildQueue({ feeds: ok(snap('high')) }, NOW).items[0]?.severity).toBe('high');
  });

  it('attribution and brand candidates are low severity with their totals as reach', () => {
    const q = buildQueue({
      attribution: ok(part<AttributionBacklogData>({ totals: { unattributed: 40, never_attempted: 7, total_clusters: 90, attempted_unknown: 33, dismissed: 1 } })),
      brand_candidates: ok({ total: 12, candidates: [] }),
    }, NOW);
    expect(q.items.map((i) => [i.source, i.severity, i.reach]).sort()).toEqual([
      ['attribution', 'low', 40],
      ['brand_candidates', 'low', 12],
    ]);
  });

  describe('failure accounting: a failed source is never an all-clear', () => {
    it('an errored source is reported failed and the queue is not clear', () => {
      const q = buildQueue({ alerts: ok({ new_count: 0, critical_count: 0 }), incidents: { status: 'error' } }, NOW);
      expect(q.failed).toEqual(['incidents']);
      expect(q.items).toEqual([]);
      expect(q.clear).toBe(false);
    });

    it('a still-loading source is not clear either', () => {
      const q = buildQueue({ alerts: ok({ new_count: 0, critical_count: 0 }), agents: { status: 'loading' } }, NOW);
      expect(q.loading).toEqual(['agents']);
      expect(q.clear).toBe(false);
    });

    it('healthy sources still rank while another fails', () => {
      const q = buildQueue({ alerts: ok({ new_count: 4, critical_count: 0 }), agents: { status: 'error' } }, NOW);
      expect(q.items).toHaveLength(1);
      expect(q.failed).toEqual(['agents']);
    });

    it('a stale source keeps its items AND counts as failed', () => {
      const q = buildQueue({ alerts: { status: 'ok', data: { new_count: 9, critical_count: 0 }, stale: true } }, NOW);
      expect(q.items).toHaveLength(1);
      expect(q.failed).toEqual(['alerts']);
      expect(q.clear).toBe(false);
    });

    it.each<[string, QueueSources]>([
      ['critical intel with no payload', { critical_intel: ok(null) }],
      ['a dashboard snapshot with no feeds slice', { feeds: ok(part<DashboardSnapshot>({ feeds: null })) }],
      ['a null attribution backlog', { attribution: ok(null) }],
      ['an incidents payload that is not a list', { incidents: ok(null as unknown as Incident[]) }],
      ['an alerts payload without a count', { alerts: ok({} as { new_count: number; critical_count: number }) }],
      ['takedowns without status counts', { takedowns: ok({} as { statusCounts: never[] }) }],
    ])('an unusable payload (%s) is a failure, not clear', (_name, sources) => {
      const q = buildQueue(sources, NOW);
      expect(q.failed).toHaveLength(1);
      expect(q.clear).toBe(false);
    });
  });

  describe('clear state', () => {
    it('is clear only when every enabled source succeeded with nothing', () => {
      const q = buildQueue({
        alerts: ok({ new_count: 0, critical_count: 0 }),
        critical_intel: ok({ events: [], total: 0, generated_at: ago(0) }),
        agents: ok([]),
      }, NOW);
      expect(q.enabled).toBe(3);
      expect(q.clear).toBe(true);
    });

    it('is not clear when no source is enabled at all', () => {
      const q = buildQueue({}, NOW);
      expect(q.enabled).toBe(0);
      expect(q.clear).toBe(false);
    });

    it('treats an absent key as disabled, not as failed', () => {
      const only: QueueSources = { alerts: ok({ new_count: 0, critical_count: 0 }) };
      const q = buildQueue(only, NOW);
      expect(q.failed).toEqual([]);
      const ids: QueueSourceId[] = QUEUE_SOURCE_IDS.filter((id) => !(id in only));
      expect(ids.length).toBe(QUEUE_SOURCE_IDS.length - 1);
    });
  });
});
