import { describe, expect, it } from 'vitest';
import { AGENT_METADATA } from '@/lib/agent-metadata';
import {
  MIN_IDENTITY_CONTRAST, agentIdentityHex, buildIdentity, contrastRatio, ensureContrast, hexToRgb, inkFor, mixRgb,
  type RGB,
} from './colors';
import { drawFailedBadge, drawFlow, makePalette, type DrawParams } from './FlowCanvas';
import { HUB_THREATS, computeLayout, placeAgents } from './model';
import { indexTimeline } from './activity';
import { AGENTS_FIXTURE, FEEDS_FIXTURE, FIXTURE_NOW, TIMELINE_FIXTURE, makeAgent } from './fixtures';

// The light-theme card and text tokens, and the dark ones, as the page resolves them.
const LIGHT_BG: RGB = [255, 255, 255];
const LIGHT_TEXT: RGB = [20, 21, 26];
const DARK_BG: RGB = [21, 22, 25];
const DARK_TEXT: RGB = [246, 247, 247];

describe('identity colour maths', () => {
  it('parses hex and mixes toward an anchor', () => {
    expect(hexToRgb('#C83C3C')).toEqual([200, 60, 60]);
    expect(hexToRgb('#fff')).toEqual([255, 255, 255]);
    expect(hexToRgb('nope')).toBeNull();
    expect(mixRgb([0, 0, 0], [100, 100, 100], 0.5)).toEqual([50, 50, 50]);
  });

  it('every registry colour reaches 3:1 against the light card after adjustment', () => {
    for (const meta of Object.values(AGENT_METADATA)) {
      const rgb = hexToRgb(meta.color)!;
      const out = ensureContrast(rgb, LIGHT_BG, LIGHT_TEXT);
      expect(contrastRatio(out, LIGHT_BG), `${meta.id} ${meta.color}`).toBeGreaterThanOrEqual(MIN_IDENTITY_CONTRAST);
    }
  });

  it('every registry colour reaches 3:1 against the dark card too', () => {
    for (const meta of Object.values(AGENT_METADATA)) {
      const out = ensureContrast(hexToRgb(meta.color)!, DARK_BG, DARK_TEXT);
      expect(contrastRatio(out, DARK_BG), meta.id).toBeGreaterThanOrEqual(MIN_IDENTITY_CONTRAST);
    }
  });

  it('leaves a colour that already passes untouched and darkens a pale one on light', () => {
    const teal: RGB = [10, 138, 181];
    expect(ensureContrast(teal, LIGHT_BG, LIGHT_TEXT)).toEqual(teal);
    const pale: RGB = hexToRgb('#FCD34D')!;
    const darker = ensureContrast(pale, LIGHT_BG, LIGHT_TEXT);
    expect(contrastRatio(pale, LIGHT_BG)).toBeLessThan(3);
    expect(darker).not.toEqual(pale);
    // dark theme: the same pale colour already passes and is kept
    expect(ensureContrast(pale, DARK_BG, DARK_TEXT)).toEqual(pale);
  });

  it('picks readable ink for a filled node', () => {
    expect(inkFor([255, 230, 120], [255, 255, 255], [10, 11, 14])).toEqual([10, 11, 14]);
    expect(inkFor([20, 40, 120], [255, 255, 255], [10, 11, 14])).toEqual([255, 255, 255]);
  });
});

describe('identity resolution', () => {
  const byName = new Map(AGENTS_FIXTURE.map((a) => [a.name, a]));
  const identity = buildIdentity({
    bg: DARK_BG, anchor: DARK_TEXT, primary: [76, 92, 248],
    feeds: { 'feeds:ingest': [10, 138, 181], 'feeds:social': [167, 139, 250], 'feeds:enrichment': [60, 184, 120] },
    agents: byName,
  });

  it('uses the API colour, then the registry colour, then the primary', () => {
    expect(agentIdentityHex('nexus', { color: '#123456' })).toBe('#123456');
    expect(agentIdentityHex('nexus', { color: 'not a colour' })).toBe(AGENT_METADATA.nexus.color);
    expect(agentIdentityHex('nexus', undefined)).toBe(AGENT_METADATA.nexus.color);
    expect(agentIdentityHex('daily_briefing', undefined)).toBeUndefined();
    const custom = buildIdentity({ bg: DARK_BG, anchor: DARK_TEXT, primary: [200, 100, 50], feeds: {}, agents: new Map([['x', { color: '#336699' }]]) });
    expect(custom.rgb('x')).toEqual([51, 102, 153]);
    expect(custom.rgb('unknown_job')).toEqual([200, 100, 50]);
  });

  it('gives the hub the primary and each feed type its own colour', () => {
    expect(identity.rgb(HUB_THREATS)).toEqual([76, 92, 248]);
    const groups = ['feeds:ingest', 'feeds:enrichment', 'feeds:social'].map((g) => identity.css(g));
    expect(new Set(groups).size).toBe(3);
  });

  it('formats alpha into rgba()', () => {
    expect(identity.css('feeds:ingest', 0.5)).toBe('rgba(10,138,181,0.5)');
  });
});

// ── failure reads without relying on hue ──────────────────────────────
function recorder() {
  const calls: Array<[string, unknown[]]> = [];
  const base: Record<string, unknown> = { measureText: (t: string) => ({ width: t.length * 6 }) };
  const ctx = new Proxy(base, {
    get: (t, k: string) => (k in t ? t[k] : (...a: unknown[]) => { calls.push([k, a]); }),
    set: (t, k: string, v) => { t[k] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

describe('failed nodes', () => {
  const palette = makePalette({});
  it('draws a red badge with a x glyph on the node, whatever the agent colour', () => {
    const { ctx, calls } = recorder();
    drawFailedBadge(ctx, palette, { x: 100, y: 100, r: 15 });
    const lines = calls.filter(([k]) => k === 'lineTo');
    expect(calls.some(([k, a]) => k === 'arc' && Math.abs((a[0] as number) - 112) < 1 && a[2] === 6)).toBe(true);
    expect(lines).toHaveLength(2); // the two strokes of the x
  });

  it('adds the x badge to a failed node even when its colour is red-family, and not to a healthy one', () => {
    const placement = placeAgents(AGENTS_FIXTURE);
    const layout = computeLayout({ width: 1200, placement, feeds: FEEDS_FIXTURE, labelOf: (id) => id });
    const index = indexTimeline(TIMELINE_FIXTURE, FEEDS_FIXTURE);
    const NOW = Date.parse(FIXTURE_NOW);
    const redAgents = new Map(AGENTS_FIXTURE.map((a) => [a.name, makeAgent(a.name, { ...a, color: '#C83C3C' })]));
    const blueAgents = new Map(AGENTS_FIXTURE.map((a) => [a.name, makeAgent(a.name, { ...a, color: '#38BDF8' })]));
    const make = (agents: Map<string, ReturnType<typeof makeAgent>>): DrawParams => ({
      layout, palette, zoom: 1, agents, index, hasTimeline: true, now: NOW, focus: null, selected: null,
      dotHover: null, reducedMotion: true,
      identity: buildIdentity({ bg: DARK_BG, anchor: DARK_TEXT, primary: [76, 92, 248], feeds: {}, agents }),
    });
    const attributor = layout.nodes.attributor!; // fixture: its last run failed
    const badgeAt = (calls: Array<[string, unknown[]]>, n: { x: number; y: number; r: number }) => calls.some(
      ([k, a]) => k === 'arc' && a[2] === 6 && Math.abs((a[0] as number) - (n.x + n.r * 0.8)) < 0.5,
    );
    for (const agents of [redAgents, blueAgents]) {
      const { ctx, calls } = recorder();
      drawFlow(ctx, make(agents));
      expect(badgeAt(calls, attributor)).toBe(true);
      expect(badgeAt(calls, layout.nodes.sentinel!)).toBe(false); // healthy
    }
  });
});
