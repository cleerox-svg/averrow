import { describe, expect, it } from 'vitest';
import type { Rgba } from '@averrow/shared/theme';
import { alphaOf, drawFlow, edgeStyle, makePalette, type DrawParams } from './FlowCanvas';
import { EDGES, computeLayout, placeAgents } from './model';
import { indexTimeline } from './activity';
import { AGENTS_FIXTURE, FEEDS_FIXTURE, FIXTURE_NOW, TIMELINE_FIXTURE } from './fixtures';

const NOW = Date.parse(FIXTURE_NOW);
const edge = (from: string, to: string) => EDGES.find((e) => e.from === from && e.to === to)!;

// A palette built the way the real page builds it: --border-base is
// translucent (about 11% white), exactly what made quiet edges vanish.
const translucent: Record<string, Rgba | null> = {
  '--border-base': [255, 255, 255, 28],
  '--text-muted': [139, 140, 141, 255],
  '--primary-text': [150, 172, 255, 255],
  '--primary': [76, 92, 248, 255],
};
const palette = makePalette(translucent);

describe('edge styles stay visible on a translucent border token', () => {
  const idle = { live: false, touches: false, dim: false };

  it('draws idle TABLE and INLINE edges at readable alpha', () => {
    expect(alphaOf(edgeStyle(edge('cartographer', 'nexus'), idle, palette).stroke)).toBeGreaterThanOrEqual(0.25);
    expect(alphaOf(edgeStyle(edge('threats', 'sentinel'), idle, palette).stroke)).toBeGreaterThanOrEqual(0.4);
  });

  it('keeps dimmed edges present, and well above the border token itself', () => {
    const dim = { ...idle, dim: true };
    const borderAlpha = alphaOf(palette('--border-base'));
    expect(borderAlpha).toBeLessThan(0.15); // the trap: this token is already faint
    for (const e of [edge('cartographer', 'nexus'), edge('threats', 'sentinel')]) {
      const a = alphaOf(edgeStyle(e, dim, palette).stroke);
      expect(a).toBeGreaterThanOrEqual(0.1);
    }
  });

  it('never builds a structure line from --border-base', () => {
    for (const e of EDGES.filter((x) => x.tier === 'spine' && x.mechanism !== 'EVENT')) {
      const s = edgeStyle(e, idle, palette).stroke;
      expect(alphaOf(s), `${e.from}>${e.to}`).toBeGreaterThan(alphaOf(palette('--border-base')) * 2);
    }
  });

  it('keeps the EVENT edge dashed and primary when dimmed', () => {
    const s = edgeStyle(edge('nexus', 'observer'), { live: false, touches: false, dim: true }, palette);
    expect(s.dash.length).toBeGreaterThan(0);
    expect(alphaOf(s.stroke)).toBeGreaterThanOrEqual(0.25);
  });
});

// ── a recording 2D context ────────────────────────────────────────────
interface Rec { calls: Array<[string, unknown[]]>; alphas: number[] }
function recorder(): { ctx: CanvasRenderingContext2D; rec: Rec } {
  const rec: Rec = { calls: [], alphas: [] };
  const base: Record<string, unknown> = { measureText: (t: string) => ({ width: t.length * 6 }) };
  const ctx = new Proxy(base, {
    get: (t, k: string) => (k in t ? t[k] : (...a: unknown[]) => { rec.calls.push([k, a]); }),
    set: (t, k: string, v) => { if (k === 'globalAlpha') rec.alphas.push(v as number); t[k] = v; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, rec };
}

const placement = placeAgents(AGENTS_FIXTURE);
const layout = computeLayout({ width: 1200, placement, feeds: FEEDS_FIXTURE, labelOf: (id) => id });
const byName = new Map(AGENTS_FIXTURE.map((a) => [a.name, a]));
const index = indexTimeline(TIMELINE_FIXTURE, FEEDS_FIXTURE);

function params(over: Partial<DrawParams> = {}): DrawParams {
  return {
    layout, palette, zoom: 1, agents: byName, index, hasTimeline: true, now: NOW,
    focus: null, selected: null, dotHover: null, reducedMotion: false, ...over,
  };
}

describe('drawFlow', () => {
  it.each([1, 1.6, 0.6])('clears the whole scaled canvas at zoom %s', (zoom) => {
    const { ctx, rec } = recorder();
    drawFlow(ctx, params({ zoom }));
    const clear = rec.calls.find(([k]) => k === 'clearRect')!;
    // The backing store is layout * zoom: clearing only layout.width/height
    // leaves a smeared strip at zoom > 1.
    expect(clear[1]).toEqual([0, 0, layout.width * zoom, layout.height * zoom]);
    const clearIdx = rec.calls.indexOf(clear);
    const scaleIdx = rec.calls.findIndex(([k]) => k === 'scale');
    expect(clearIdx).toBeLessThan(scaleIdx); // cleared in device space, before scaling
  });

  it('reports busy while a run or particle is live, idle when nothing moves', () => {
    expect(drawFlow(recorder().ctx, params())).toBe(true);
    const quiet = indexTimeline({ ...TIMELINE_FIXTURE, runs: [], pulls: [], events: [] }, FEEDS_FIXTURE);
    expect(drawFlow(recorder().ctx, params({ index: quiet }))).toBe(false);
  });

  it('is never busy under reduced motion', () => {
    expect(drawFlow(recorder().ctx, params({ reducedMotion: true }))).toBe(false);
  });

  it('does not dim the canvas when the focused id has no node', () => {
    const { ctx, rec } = recorder();
    drawFlow(ctx, params({ focus: 'daily_briefing' }));
    expect(rec.alphas.every((a) => a === 1)).toBe(true);
    const { ctx: c2, rec: r2 } = recorder();
    drawFlow(c2, params({ focus: 'nexus' }));
    expect(r2.alphas).toContain(0.3);
  });

  it('draws labels with a halo so edges never cut them', () => {
    const { ctx, rec } = recorder();
    drawFlow(ctx, params());
    const halos = rec.calls.filter(([k]) => k === 'strokeText').map(([, a]) => a[0]);
    expect(halos).toContain('sentinel');
    expect(halos).toContain('abuse inbox');
  });

  it('labels the inline satellite with a small cron tag', () => {
    const { ctx, rec } = recorder();
    drawFlow(ctx, params());
    expect(rec.calls.some(([k, a]) => k === 'fillText' && a[0] === 'inl')).toBe(true);
  });
});
