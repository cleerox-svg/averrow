// The global `.data-row` hover (ops index.css) follows AVERROW_UI_STANDARD "Table row standard" under the facelift:
// token fill that darkens, no glow gradient, no primary/amber rail. The legacy rules stay only for FACELIFT=false.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(__dirname, '../../index.css'), 'utf8');

/** Every rule whose selector list mentions `:root[data-accent] ... .data-row`, as [selector, body]. */
function facelift(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const m of css.matchAll(/([^{}]*:root\[data-accent\][^{}]*\.data-row[^{}]*)\{([^}]*)\}/g)) out.push([m[1]!.trim(), m[2]!]);
  return out;
}

describe('global .data-row hover under the facelift', () => {
  const rules = facelift();

  it('has token hover rules for dark and light', () => {
    const dark = rules.find(([sel]) => sel === ':root[data-accent] .data-row:hover');
    const light = rules.find(([sel]) => sel === ':root[data-accent][data-theme="light"] .data-row:hover');
    expect(dark?.[1]).toContain('background: var(--bg-page)');
    expect(light?.[1]).toContain('color-mix(in srgb, var(--text-primary) 6%, transparent)');
  });

  it('uses no glow gradient, shadow, amber or primary rail', () => {
    expect(rules.length).toBeGreaterThan(5);
    for (const [sel, body] of rules) {
      expect(body, sel).not.toMatch(/gradient|box-shadow|--amber|--primary|rgba?\(/);
    }
  });

  it('severity rows keep only their severity-token left border', () => {
    for (const sev of ['critical', 'high', 'medium', 'low', 'info']) {
      const r = rules.find(([sel]) => sel.includes(`.data-row--${sev}:hover`));
      expect(r?.[1], sev).toContain(`var(--sev-${sev}-border)`);
    }
  });

  it('keeps the legacy glow rule un-gated for FACELIFT=false', () => {
    expect(css).toMatch(/\n\.data-row:hover \{[^}]*--primary-glow/);
  });
});
