import { describe, it, expect } from 'vitest';
import { buildBotShareModel, botHover, BOT_FILL_ALPHA } from './bot-share';
import type { BotDensityPoint } from '../bot-density';

const stops: [[number, number, number, number], [number, number, number, number], [number, number, number, number]] = [
  [96, 165, 250, 230], [229, 168, 50, 230], [248, 113, 113, 240],
];
const pt = (code: string, bot_pct: number, bound?: 'lower' | 'upper'): BotDensityPoint => ({
  code, name: code === 'DE' ? 'Germany' : code, bot_pct, traffic_pct: 3, rank: 1, position: [10, 51], ...(bound ? { bound } : {}),
} as BotDensityPoint);

describe('buildBotShareModel', () => {
  const m = buildBotShareModel([pt('DE', 20), pt('NL', 60), pt('FR', 80, 'upper'), pt('BE', 50, 'lower')], stops, 30, '2026-10-13');
  it('colours low to high along the scale and uses the fixed fill alpha', () => {
    expect(m.colors.get('DE')![0]).toBeLessThan(m.colors.get('NL')![0]);
    expect(m.colors.get('NL')![3]).toBe(BOT_FILL_ALPHA);
    expect(m.domain).toMatchObject({ minBot: 20, maxBot: 80 });
  });
  it('marks only provably-above-average countries (a ceiling proves nothing)', () => {
    expect([...m.above].sort()).toEqual(['BE', 'NL']);
  });
  it('keeps the as-of date and the average for the legend', () => {
    expect(m.asOf).toBe('2026-10-13');
    expect(m.globalAvg).toBe(30);
  });
});

describe('botHover', () => {
  it('splits the old tooltip sentence into title + lines', () => {
    const h = botHover(pt('DE', 20), 30);
    expect(h.title).toBe('Germany (DE)');
    expect(h.lines.join(' | ')).toMatch(/Bot share 20\.0% of its traffic/);
    expect(h.lines.join(' | ')).toMatch(/global avg 30\.0%/);
  });
});
