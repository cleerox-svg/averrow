import { describe, expect, it } from 'vitest';
import { AGENT_METADATA } from '@/lib/agent-metadata';
import {
  DECLARED_ENDPOINTS, EDGES, FEED_NRD, FLIGHT_CONTROL, HUB_THREATS, ON_DEMAND_IDS, SPINE_EDGES, STAGE_AGENTS,
  canonicalHoverId, computeLayout, edgeCurve, feedGroupOf, hitTest, placeAgents, placedIds, type Stage,
} from './model';
import { AGENTS_FIXTURE, FEEDS_FIXTURE, RETIRED_IDS, makeAgent } from './fixtures';

const REGISTERED = new Set<string>(Object.keys(AGENT_METADATA));
const key = (e: { from: string; to: string }) => `${e.from}>${e.to}`;

describe('declared edges', () => {
  it('keeps the spine small', () => {
    expect(SPINE_EDGES.length).toBeLessThanOrEqual(25);
    expect(SPINE_EDGES.length).toBeGreaterThan(10);
  });

  it('drops every edge the old view drew that the code never wired', () => {
    const wrong = [
      'sentinel>cartographer', 'nexus>analyst', 'analyst>pathfinder',
      'observer>narrator', 'observer>seed_strategist', 'seed_strategist>auto_seeder',
    ];
    const have = new Set(EDGES.map(key));
    for (const w of wrong) expect(have.has(w), w).toBe(false);
  });

  it('has exactly one EVENT edge: nexus -> observer (pivot_detected)', () => {
    const events = EDGES.filter((e) => e.mechanism === 'EVENT');
    expect(events).toHaveLength(1);
    expect(key(events[0]!)).toBe('nexus>observer');
    expect(events[0]!.via).toBe('pivot_detected');
    expect(events[0]!.tier).toBe('spine');
  });

  it('pins the true spine hand-offs', () => {
    const spine = new Set(SPINE_EDGES.map((e) => `${key(e)}:${e.mechanism}`));
    for (const want of [
      'feeds:ingest>threats:INLINE', 'threats>sentinel:INLINE', 'feeds:social>watchdog:INLINE',
      'social_discovery>social_monitor:INLINE', 'sparrow>evidence_assembler:INLINE',
      'feed:nrd_hagezi>lookalike_scanner:TABLE', 'threats>page_capture:TABLE',
      'inbox:abuse>abuse_mailbox_classifier:TABLE', 'abuse_mailbox_classifier>sparrow:TABLE',
      'auto_seeder>seed_strategist:TABLE', 'cartographer>nexus:TABLE', 'nexus>attributor:TABLE',
    ]) expect(spine.has(want), want).toBe(true);
  });

  it('only connects registered agents and declared endpoints', () => {
    const ok = (id: string) => REGISTERED.has(id) || DECLARED_ENDPOINTS.includes(id);
    for (const e of EDGES) {
      expect(ok(e.from), `${e.from} in ${key(e)}`).toBe(true);
      expect(ok(e.to), `${e.to} in ${key(e)}`).toBe(true);
    }
  });

  it('has no duplicate edges and no self edges', () => {
    const keys = EDGES.map((e) => `${key(e)}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const e of EDGES) expect(e.from).not.toBe(e.to);
  });

  it('only Flight Control supervises, and only as detail edges', () => {
    const fc = EDGES.filter((e) => e.from === FLIGHT_CONTROL);
    expect(fc.map((e) => e.to).sort()).toEqual(['analyst', 'curator', 'geoip_refresh', 'watchdog']);
    expect(fc.every((e) => e.tier === 'detail')).toBe(true);
  });
});

describe('placement coverage', () => {
  it('places every agent in the API fixture exactly once', () => {
    const p = placeAgents(AGENTS_FIXTURE);
    const placed = placedIds(p);
    expect(placed.sort()).toEqual(AGENTS_FIXTURE.map((a) => a.name).sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  it('puts retired, on-demand and canvas agents in their own groups', () => {
    const p = placeAgents(AGENTS_FIXTURE);
    expect([...p.retired].sort()).toEqual([...RETIRED_IDS].sort());
    expect([...p.onDemand].sort()).toEqual([...ON_DEMAND_IDS].sort());
    expect(p.hasFlightControl).toBe(true);
    expect(p.stages.respond).toEqual(['sparrow', 'evidence_assembler']);
    // the 7 agents the old view never rendered are now on the canvas or rail
    for (const id of ['abuse_mailbox_classifier', 'page_capture', 'trademark_monitor', 'ct_monitor', 'executive_monitor']) {
      expect(Object.values(p.stages).flat()).toContain(id);
    }
  });

  it('defaults a missing lifecycle to active', () => {
    const a = { ...makeAgent('sentinel') };
    delete a.lifecycle;
    expect(placeAgents([a]).stages.ingest).toEqual(['sentinel']);
  });

  it('sends unknown ids to ops jobs and survives a duplicated Navigator', () => {
    const p = placeAgents([makeAgent('navigator'), makeAgent('navigator'), makeAgent('daily_briefing')]);
    expect(placedIds(p).sort()).toEqual(['daily_briefing', 'navigator']);
    expect(p.ops).toEqual(['daily_briefing']);
  });

  it('a retired lifecycle wins over a stage slot', () => {
    const p = placeAgents([makeAgent('sentinel', { lifecycle: 'retired' })]);
    expect(p.retired).toEqual(['sentinel']);
    expect(p.stages.ingest).toEqual([]);
  });

  it('keeps stage membership disjoint', () => {
    const all = (Object.keys(STAGE_AGENTS) as Stage[]).flatMap((s) => STAGE_AGENTS[s]);
    expect(new Set(all).size).toBe(all.length);
    for (const id of all) expect(REGISTERED.has(id), id).toBe(true);
  });
});

describe('layout', () => {
  const placement = placeAgents(AGENTS_FIXTURE);
  const feeds = FEEDS_FIXTURE;
  const layout = computeLayout({ width: 1100, placement, feeds, labelOf: (id) => id });

  it('gives every canvas agent a node, and none to retired / on-demand', () => {
    for (const id of Object.values(placement.stages).flat()) expect(layout.nodes[id], id).toBeDefined();
    for (const id of [...placement.retired, ...placement.onDemand]) expect(layout.nodes[id], id).toBeUndefined();
    expect(layout.nodes[HUB_THREATS]).toBeDefined();
  });

  it('runs stages left to right', () => {
    const x = (id: string) => layout.nodes[id]!.x;
    expect(x('app_store_monitor')).toBeLessThan(x('sentinel'));
    expect(x('sentinel')).toBeLessThan(x('cartographer'));
    expect(x('cartographer')).toBeLessThan(x('nexus'));
    expect(x('nexus')).toBeLessThan(x('observer'));
    expect(x('observer')).toBeLessThan(x('sparrow'));
  });

  it('never overlaps two nodes and stays inside the canvas', () => {
    const list = Object.values(layout.nodes).filter((n) => n.id !== FLIGHT_CONTROL && n.kind !== 'group');
    for (let i = 0; i < list.length; i++) {
      expect(list[i]!.x).toBeGreaterThan(0);
      expect(list[i]!.x).toBeLessThan(layout.width);
      expect(list[i]!.y).toBeLessThan(layout.height);
      for (let j = i + 1; j < list.length; j++) {
        const d = Math.hypot(list[i]!.x - list[j]!.x, list[i]!.y - list[j]!.y);
        expect(d, `${list[i]!.id} vs ${list[j]!.id}`).toBeGreaterThan(list[i]!.r + list[j]!.r);
      }
    }
  });

  it('lays feeds out by type, with nrd_hagezi on its own', () => {
    expect(layout.dots.some((d) => d.name === 'nrd_hagezi')).toBe(false);
    expect(layout.nodes[FEED_NRD]).toBeDefined();
    expect(layout.dots.filter((d) => d.group === 'social')).toHaveLength(4);
    expect(layout.dots.filter((d) => d.group === 'enrichment')).toHaveLength(5);
  });

  it('reads a missing feed_type as ingest', () => {
    expect(feedGroupOf({ feed_name: 'x', feed_type: undefined })).toBe('ingest');
    expect(feedGroupOf({ feed_name: 'nrd_hagezi', feed_type: 'ingest' })).toBe('nrd');
  });

  it('enforces a minimum width and hit-tests nodes, feed dots and the badge', () => {
    const narrow = computeLayout({ width: 320, placement, feeds, labelOf: (id) => id });
    expect(narrow.width).toBeGreaterThanOrEqual(1000);
    const n = layout.nodes.observer!;
    expect(hitTest(layout, n.x + 2, n.y - 2)?.id).toBe('observer');
    const dot = layout.dots.find((d) => d.name === 'phishtank')!;
    expect(hitTest(layout, dot.x, dot.y)).toEqual({ id: 'feeds:ingest', dot: 'phishtank' });
    const b = layout.badge;
    expect(hitTest(layout, b.x + b.w / 2, b.y + b.h / 2)?.id).toBe(FLIGHT_CONTROL);
    expect(hitTest(layout, 5, layout.height - 3)).toBeNull();
  });

  it('draws a backwards edge (navigator -> threats) that leaves leftwards', () => {
    const c = edgeCurve(layout.nodes.navigator!, layout.nodes[HUB_THREATS]!);
    expect(c[2]!).toBeLessThan(c[0]!);
  });

  it('maps a feed dot hover to its group lane', () => {
    const groups = new Map(feeds.map((f) => [f.feed_name, feedGroupOf(f)]));
    expect(canonicalHoverId('feed:phishtank', groups)).toBe('feeds:ingest');
    expect(canonicalHoverId('feed:reddit', groups)).toBe('feeds:social');
    expect(canonicalHoverId('feed:nrd_hagezi', groups)).toBe(FEED_NRD);
    expect(canonicalHoverId('nexus', groups)).toBe('nexus');
    expect(canonicalHoverId(null, groups)).toBeNull();
  });
});
