import { describe, it, expect } from 'vitest';
import { heatmapWeight, getArcColor, getSeverityColor, rgbCss, THREAT_TYPE_COLORS, TYPE_ORDER } from './map-colors';

describe('heatmapWeight', () => {
  it('prefers the server weight', () => {
    expect(heatmapWeight({ weight: 7, severity: 'low' })).toBe(7);
  });
  it('falls back to severity weights when weight is absent or invalid', () => {
    expect(heatmapWeight({ severity: 'critical' })).toBe(5);
    expect(heatmapWeight({ weight: 0, severity: 'high' })).toBe(3);
    expect(heatmapWeight({ weight: Number.NaN, severity: 'medium' })).toBe(2);
    expect(heatmapWeight({ severity: 'unknown' })).toBe(1);
    expect(heatmapWeight({})).toBe(1);
  });
});

describe('colours', () => {
  it('applies alpha overrides without mutating the table', () => {
    const c = getSeverityColor('critical', 10);
    expect(c[3]).toBe(10);
    expect(getSeverityColor('critical')[3]).toBe(255);
  });
  it('arc colour follows colorBy', () => {
    const a = { severity: 'critical', threat_type: 'phishing' };
    expect(getArcColor(a, 'severity')).toEqual(getSeverityColor('critical'));
    expect(getArcColor(a, 'type')).not.toEqual(getSeverityColor('critical'));
  });
  it('rgbCss drops alpha', () => {
    expect(rgbCss([1, 2, 3, 4])).toBe('rgb(1, 2, 3)');
  });
});

describe('threat type palette', () => {
  it('gives every threat type a visually distinct colour (legend must be decodable)', () => {
    const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    for (let i = 0; i < TYPE_ORDER.length; i++) {
      for (let j = i + 1; j < TYPE_ORDER.length; j++) {
        const d = dist(THREAT_TYPE_COLORS[TYPE_ORDER[i]], THREAT_TYPE_COLORS[TYPE_ORDER[j]]);
        expect(d, `${TYPE_ORDER[i]} vs ${TYPE_ORDER[j]}`).toBeGreaterThan(60);
      }
    }
  });
});
