import { describe, expect, it } from 'vitest';
import {
  MAX_PARTICLES, OPEN_RUN_SUSPECT_MS, TRANSIT_TAIL_MS, activeMembers, edgeActivity, edgeParticles, indexTimeline, laneActivity,
  particleCount,
} from './activity';
import { EDGES, FEED_NRD } from './model';
import { FEEDS_FIXTURE, FIXTURE_NOW, TIMELINE_FIXTURE } from './fixtures';
import { buildTapeLanes, tapeGeometry, tapeHitTest } from './tape';
import { placeAgents } from './model';
import { AGENTS_FIXTURE } from './fixtures';

const NOW = Date.parse(FIXTURE_NOW);
const MIN = 60_000;
const index = indexTimeline(TIMELINE_FIXTURE, FEEDS_FIXTURE);
const edge = (from: string, to: string) => EDGES.find((e) => e.from === from && e.to === to)!;

describe('timeline index', () => {
  it('groups pulls into feed lanes and runs into agent lanes', () => {
    expect(index.lanes.get('navigator')).toHaveLength(12);
    expect(index.lanes.get('feeds:ingest')!.length).toBeGreaterThan(5);
    expect(index.lanes.get('feeds:social')).toHaveLength(2);
    expect(index.lanes.get('feeds:enrichment')).toHaveLength(2);
    expect(index.lanes.get(FEED_NRD)).toHaveLength(1);
  });

  it('is empty (not throwing) with no timeline', () => {
    const empty = indexTimeline(undefined, FEEDS_FIXTURE);
    expect(empty.lanes.size).toBe(0);
    expect(laneActivity(empty, 'nexus', NOW).emitting).toBe(false);
  });
});

describe('node activity', () => {
  it('reports an open run with progress below 1', () => {
    const a = laneActivity(index, 'cartographer', NOW);
    expect(a.running).toBe(true);
    expect(a.progress).toBeGreaterThan(0);
    expect(a.progress).toBeLessThan(1);
  });

  it('flags the latest finished run failing', () => {
    expect(laneActivity(index, 'attributor', NOW).failed).toBe(true);
    expect(laneActivity(index, 'sentinel', NOW).failed).toBe(false);
  });

  it('keeps emitting briefly after a run ends, then stops', () => {
    expect(laneActivity(index, 'nexus', NOW).emitting).toBe(true);
    expect(laneActivity(index, 'nexus', NOW + TRANSIT_TAIL_MS + 5_000).emitting).toBe(false);
  });

  it('tracks feeds individually inside a group', () => {
    const m = activeMembers(index, 'feeds:ingest', NOW);
    expect(m.get('c2_intel_feeds')?.running).toBe(true);
    expect(m.get('sslbl')?.failed).toBe(true);
    expect(m.get('urlhaus')?.running).toBe(false);
  });
});

describe('open runs are capped at the snapshot', () => {
  it('stops showing an open run as running 90s after generated_at', () => {
    expect(laneActivity(index, 'cartographer', NOW + 30_000).running).toBe(true);
    const late = laneActivity(index, 'cartographer', NOW + 91_000);
    expect(late.running).toBe(false);
    expect(late.emitting).toBe(false);
    expect(late.stale).toBe(true);
    expect(laneActivity(index, 'cartographer', NOW + 30_000).stale).toBe(false);
    expect(activeMembers(index, 'feeds:ingest', NOW + 91_000).get('c2_intel_feeds')?.running ?? false).toBe(false);
  });
});

describe('EVENT edge follows pivot_detected events, not nexus runs', () => {
  const e = edge('nexus', 'observer');
  const noEvents = indexTimeline({ ...TIMELINE_FIXTURE, events: [] }, FEEDS_FIXTURE);

  it('stays quiet when nexus ran but wrote no event', () => {
    expect(laneActivity(noEvents, 'nexus', NOW).emitting).toBe(true); // the run itself is live
    expect(edgeActivity(noEvents, e, NOW).emitting).toBe(false);
  });

  it('fires in the transit tail of a handled event, then stops', () => {
    const handled = indexTimeline({
      ...TIMELINE_FIXTURE,
      events: [{ ...TIMELINE_FIXTURE.events[0]!, status: 'done', created_at: FIXTURE_NOW }],
    }, FEEDS_FIXTURE);
    expect(edgeActivity(handled, e, NOW + 2_000).emitting).toBe(true);
    expect(edgeActivity(handled, e, NOW + TRANSIT_TAIL_MS + 1_000).emitting).toBe(false);
  });

  it('keeps a pending event in flight until the snapshot goes stale', () => {
    expect(edgeActivity(index, e, NOW + 30_000).emitting).toBe(true);
    expect(edgeActivity(index, e, NOW + 91_000).emitting).toBe(false);
  });

  it('stops animating a pending event 10 minutes after it was written', () => {
    const old = indexTimeline({
      ...TIMELINE_FIXTURE,
      events: [{ ...TIMELINE_FIXTURE.events[0]!, created_at: new Date(NOW - 11 * 60_000).toISOString() }],
    }, FEEDS_FIXTURE);
    expect(edgeActivity(old, e, NOW).emitting).toBe(false);
    const recent = indexTimeline({
      ...TIMELINE_FIXTURE,
      events: [{ ...TIMELINE_FIXTURE.events[0]!, created_at: new Date(NOW - 9 * 60_000).toISOString() }],
    }, FEEDS_FIXTURE);
    expect(edgeActivity(recent, e, NOW).emitting).toBe(true);
  });

  it('ignores events from other sources', () => {
    const other = indexTimeline({
      ...TIMELINE_FIXTURE,
      events: [{ ...TIMELINE_FIXTURE.events[0]!, source_agent: 'analyst' }],
    }, FEEDS_FIXTURE);
    expect(edgeActivity(other, e, NOW).emitting).toBe(false);
  });
});

describe('hub emitters', () => {
  it('lights the table edges while the enricher runs, but not the ingest hand-off', () => {
    const only = indexTimeline({
      ...TIMELINE_FIXTURE,
      pulls: [],
      runs: TIMELINE_FIXTURE.runs.filter((r) => r.agent_id === 'enricher').map((r) => ({
        ...r, status: 'running' as const, open: true, completed_at: null,
      })),
    }, FEEDS_FIXTURE);
    expect(edgeActivity(only, edge('threats', 'cartographer'), NOW).emitting).toBe(true);
    expect(edgeActivity(only, edge('threats', 'sentinel'), NOW).emitting).toBe(false);
  });
});

describe('particle gating', () => {
  it('rides the live EVENT edge while a pivot event is in flight', () => {
    const e = edge('nexus', 'observer');
    const act = edgeActivity(index, e, NOW);
    expect(act.emitting).toBe(true);
    expect(edgeParticles(e, act, NOW, false).length).toBeGreaterThan(0);
  });

  it('draws nothing under reduced motion', () => {
    const e = edge('nexus', 'observer');
    expect(edgeParticles(e, edgeActivity(index, e, NOW), NOW, true)).toEqual([]);
  });

  it('draws nothing when the upstream is idle', () => {
    const e = edge('strategist', 'observer');
    const later = NOW + 10 * 60_000;
    expect(edgeParticles(e, edgeActivity(index, e, later), later, false)).toEqual([]);
  });

  it('never rides a detail edge, even when its source is live', () => {
    const e = edge('news_watcher', 'analyst');
    const live = { running: true, progress: 0.5, failed: false, emitting: true, records: 100, lastStartMs: NOW, stale: false };
    expect(edgeParticles(e, live, NOW, false)).toEqual([]);
    const d = EDGES.find((x) => x.tier === 'detail' && x.from === 'cube_healer')!;
    expect(edgeParticles(d, live, NOW, false)).toEqual([]);
  });

  it('lights threats -> sentinel from ingest pulls only', () => {
    const e = edge('threats', 'sentinel');
    expect(edgeActivity(index, e, NOW).emitting).toBe(true); // c2_intel_feeds is pulling
    // Once the only open pull is closed and the tail has passed, the edge goes quiet.
    const settled = indexTimeline(
      { ...TIMELINE_FIXTURE, pulls: TIMELINE_FIXTURE.pulls.filter((p) => !p.open) },
      FEEDS_FIXTURE,
    );
    expect(edgeActivity(settled, e, NOW).emitting).toBe(false);
  });

  it('scales the count with records, capped', () => {
    expect(particleCount(0)).toBe(1);
    expect(particleCount(10)).toBeLessThan(particleCount(5_000));
    expect(particleCount(1e12)).toBe(MAX_PARTICLES);
    const e = edge('nexus', 'observer');
    const act = { running: true, progress: 0, failed: false, emitting: true, records: 1e9, lastStartMs: NOW, stale: false };
    expect(edgeParticles(e, act, NOW, false)).toHaveLength(MAX_PARTICLES);
    for (const p of edgeParticles(e, act, NOW, false)) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(1);
    }
  });
});

describe('run tape lanes', () => {
  const placement = placeAgents(AGENTS_FIXTURE);
  const { lanes, quiet } = buildTapeLanes(placement, index, (id) => id);

  it('lists feed groups first, then agents that ran in stage order', () => {
    expect(lanes[0]!.id).toBe('feeds:ingest');
    const ids = lanes.map((l) => l.id);
    expect(ids.indexOf('sentinel')).toBeLessThan(ids.indexOf('nexus'));
    expect(ids.indexOf('nexus')).toBeLessThan(ids.indexOf('sparrow'));
  });

  it('omits quiet agents but counts them, and tags unknown run writers as ops jobs', () => {
    expect(lanes.find((l) => l.id === 'notification_narrator')).toBeUndefined();
    expect(quiet).toBeGreaterThan(0);
    const ops = lanes.find((l) => l.id === 'daily_briefing')!;
    expect(ops.tag).toBe('ops job');
    expect(ops.agent).toBe(false);
  });

  it('hit-tests a run bar and its lane', () => {
    const g = tapeGeometry(900, lanes.length, NOW);
    const li = lanes.findIndex((l) => l.id === 'cartographer');
    const y = g.top + li * g.lh + g.lh / 2;
    const span = index.lanes.get('cartographer')![0]!;
    const x = g.x((span.startMs + NOW) / 2);
    const hit = tapeHitTest(g, lanes, index, NOW, x, y);
    expect(hit?.lane).toBe(li);
    expect(hit?.span).toBe(span);
    expect(tapeHitTest(g, lanes, index, NOW, 20, y)?.span).toBeNull();
    expect(tapeHitTest(g, lanes, index, NOW, x, 2)).toBeNull();
  });
});

describe('suspect open runs (older than the reaper ceiling)', () => {
  const orphan = (minutesBefore: number) => ({
    ...TIMELINE_FIXTURE.runs.find((r) => r.agent_id === 'enricher')!,
    id: 'orphan', started_at: new Date(NOW - minutesBefore * MIN).toISOString(),
    completed_at: null, open: true, status: 'running' as const,
  });
  const build = (minutesBefore: number) => indexTimeline({
    ...TIMELINE_FIXTURE, runs: [orphan(minutesBefore)],
  }, FEEDS_FIXTURE);

  it('is marked suspect past 90 minutes, and not before', () => {
    expect(OPEN_RUN_SUSPECT_MS).toBe(90 * MIN);
    expect(build(100).lanes.get('enricher')![0]!.suspect).toBe(true);
    expect(build(89).lanes.get('enricher')![0]!.suspect).toBeFalsy();
  });

  it('is never running or emitting, live or in replay, at any time', () => {
    const live = build(100);
    const replayIdx = { ...live, capMs: Infinity };
    for (const idx of [live, replayIdx]) {
      for (const t of [NOW - 60 * MIN, NOW - 30 * MIN, NOW]) {
        const a = laneActivity(idx, 'enricher', t);
        expect(a.running).toBe(false);
        expect(a.emitting).toBe(false);
        expect(a.stale).toBe(true);
      }
    }
  });

  it('a younger open run keeps today behaviour: running in replay, capped live', () => {
    const young = build(30);
    expect(laneActivity({ ...young, capMs: Infinity }, 'enricher', NOW + 5 * MIN).running).toBe(true);
    expect(laneActivity(young, 'enricher', NOW + 5 * MIN).running).toBe(false);
  });
});
