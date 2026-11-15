import { describe, expect, it } from 'vitest';
import {
  MAX_PARTICLES, TRANSIT_TAIL_MS, activeMembers, edgeActivity, edgeParticles, indexTimeline, laneActivity,
  particleCount,
} from './activity';
import { EDGES, FEED_NRD } from './model';
import { FEEDS_FIXTURE, FIXTURE_NOW, TIMELINE_FIXTURE } from './fixtures';
import { buildTapeLanes, tapeGeometry, tapeHitTest } from './tape';
import { placeAgents } from './model';
import { AGENTS_FIXTURE } from './fixtures';

const NOW = Date.parse(FIXTURE_NOW);
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
  it('stops showing an open run as running 60s after generated_at', () => {
    expect(laneActivity(index, 'cartographer', NOW + 30_000).running).toBe(true);
    const late = laneActivity(index, 'cartographer', NOW + 61_000);
    expect(late.running).toBe(false);
    expect(late.emitting).toBe(false);
    expect(activeMembers(index, 'feeds:ingest', NOW + 61_000).get('c2_intel_feeds')?.running ?? false).toBe(false);
  });
});

describe('particle gating', () => {
  it('rides the live EVENT edge while nexus has just finished', () => {
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
    const live = { running: true, progress: 0.5, failed: false, emitting: true, records: 100, lastStartMs: NOW };
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
    const act = { running: true, progress: 0, failed: false, emitting: true, records: 1e9, lastStartMs: NOW };
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
