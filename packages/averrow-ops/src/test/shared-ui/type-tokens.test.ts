// P3-3 guards for the facelift type layer (packages/shared/src/theme/type.css).
//
// 1. The --type-* scale equals BRAND_BRIEF.md §9 G3.
// 2. Every @font-face url() points at an existing woff2, and every codepoint
//    in each font's cmap is inside the face's declared unicode-range.
// 3. Legacy contract: 'Geist' / 'Geist Mono' and the --font-* overrides
//    appear only under [data-accent] selectors (in type.css and in every app
//    stylesheet), so with no data-accent the families never resolve to Geist
//    and the browser downloads no Geist bytes.
// 4. Base element styles: unitless line-heights, no weight/tracking.
// 5. tokens.css imports type.css (after appearance.css), and the Tailwind
//    configs expose the scale as text-type-* utilities.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';

const PACKAGES = resolve(__dirname, '../../../..');
const THEME = resolve(PACKAGES, 'shared/src/theme');
const read = (p: string) => readFileSync(p, 'utf8');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const TYPE_PATH = resolve(THEME, 'type.css');
const TYPE = stripComments(read(TYPE_PATH));
const TOKENS = stripComments(read(resolve(THEME, 'tokens.css')));

/** Innermost rule blocks (selector + body); nested at-rule wrappers are skipped. */
function rules(css: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  for (const m of css.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    out.push({ selector: m[1]!.trim(), body: m[2]! });
  }
  return out;
}
function decls(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/([\w-]+)\s*:\s*([^;]+);?/g)) out.set(m[1]!, m[2]!.trim());
  return out;
}
/** True when EVERY selector in the list requires a data-accent attribute
 *  (a `[data-accent]` inside `:not(...)` does not count). */
function isAccentScoped(selectorList: string): boolean {
  return selectorList
    .split(/,(?![^(]*\))/)
    .every((sel) => /\[data-accent\]/.test(sel.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, '')));
}

const RULES = rules(TYPE);
const FONT_FACES = RULES.filter((r) => r.selector === '@font-face');
const ROOT = (() => {
  const r = RULES.find((x) => x.selector === ':root');
  if (!r) throw new Error('type.css has no plain :root block');
  return decls(r.body);
})();

// ── minimal WOFF2 → cmap reader (spec: https://www.w3.org/TR/WOFF2/) ──
const KNOWN_TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'];
function woff2Cmap(buf: Buffer): Set<number> {
  if (buf.toString('latin1', 0, 4) !== 'wOF2') throw new Error('not woff2');
  const numTables = buf.readUInt16BE(12);
  const compressedLength = buf.readUInt32BE(20);
  let off = 48;
  const base128 = () => {
    let v = 0;
    for (let i = 0; i < 5; i++) { const b = buf[off++]!; v = v * 128 + (b & 0x7f); if (!(b & 0x80)) return v; }
    throw new Error('bad UIntBase128');
  };
  const tables: Array<{ tag: string; len: number }> = [];
  for (let i = 0; i < numTables; i++) {
    const flags = buf[off++]!;
    let tag = KNOWN_TAGS[flags & 0x3f];
    if ((flags & 0x3f) === 63) { tag = buf.toString('latin1', off, off + 4); off += 4; }
    const version = flags >> 6;
    const orig = base128();
    const transformed = tag === 'glyf' || tag === 'loca' ? version !== 3 : version !== 0;
    tables.push({ tag: tag!, len: transformed ? base128() : orig });
  }
  const data = brotliDecompressSync(buf.subarray(off, off + compressedLength));
  let pos = 0;
  let cmap: Buffer | undefined;
  for (const t of tables) { if (t.tag === 'cmap') cmap = data.subarray(pos, pos + t.len); pos += t.len; }
  if (!cmap) throw new Error('no cmap');
  const cps = new Set<number>();
  const n = cmap.readUInt16BE(2);
  for (let i = 0; i < n; i++) {
    const sub = cmap.readUInt32BE(4 + i * 8 + 4);
    const fmt = cmap.readUInt16BE(sub);
    if (fmt === 4) {
      const segX2 = cmap.readUInt16BE(sub + 6);
      const ends = sub + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
      for (let s = 0; s < segX2; s += 2) {
        const end = cmap.readUInt16BE(ends + s), start = cmap.readUInt16BE(starts + s);
        const delta = cmap.readInt16BE(deltas + s), ro = cmap.readUInt16BE(ranges + s);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          const gid = ro === 0 ? (c + delta) & 0xffff
            : cmap.readUInt16BE(ranges + s + ro + (c - start) * 2);
          if (gid !== 0) cps.add(c);
        }
      }
    } else if (fmt === 12) {
      const groups = cmap.readUInt32BE(sub + 12);
      for (let g = 0; g < groups; g++) {
        const p = sub + 16 + g * 12;
        for (let c = cmap.readUInt32BE(p); c <= cmap.readUInt32BE(p + 4); c++) cps.add(c);
      }
    }
  }
  return cps;
}
function parseUnicodeRange(v: string): Array<[number, number]> {
  return v.split(',').map((part) => {
    const m = /^U\+([0-9A-F]+)(?:-([0-9A-F]+))?$/i.exec(part.trim());
    if (!m) throw new Error(`bad unicode-range part ${part}`);
    const lo = parseInt(m[1]!, 16);
    return [lo, m[2] ? parseInt(m[2], 16) : lo];
  });
}

describe('type scale tokens (BRAND_BRIEF §9 G3)', () => {
  // [size, line-height, weight, tracking]
  const G3: Record<string, [string, string, string, string]> = {
    display: ['32px', '36px', '600', '-0.03em'],
    h1: ['24px', '30px', '600', '0em'],
    h2: ['18px', '24px', '600', '0em'],
    body: ['14px', '21px', '400', '0em'],
    small: ['13px', '18px', '400', '0em'],
    label: ['12px', '16px', '500', '0.01em'],
    mono: ['13px', '20px', '400', '0em'],
  };
  for (const [role, [size, lh, weight, tracking]] of Object.entries(G3)) {
    it(`--type-${role}-* = ${size}/${lh}/${weight}/${tracking}`, () => {
      expect(ROOT.get(`--type-${role}-size`)).toBe(size);
      expect(ROOT.get(`--type-${role}-lh`)).toBe(lh);
      expect(ROOT.get(`--type-${role}-weight`)).toBe(weight);
      expect(ROOT.get(`--type-${role}-tracking`)).toBe(tracking);
    });
  }

  it('does not use the --text-* (colour) namespace', () => {
    expect(TYPE).not.toMatch(/--text-[\w-]*\s*:/);
  });
});

describe('@font-face', () => {
  it('declares Geist and Geist Mono, upright and italic, with swap', () => {
    const faces = FONT_FACES.map((f) => { const d = decls(f.body); return `${d.get('font-family')}/${d.get('font-style')}`; });
    expect(faces.sort()).toEqual(["'Geist Mono'/italic", "'Geist Mono'/normal", "'Geist'/italic", "'Geist'/normal"]);
    for (const f of FONT_FACES) {
      expect(decls(f.body).get('font-display')).toBe('swap');
      expect(decls(f.body).get('font-weight')).toBe('100 900');
    }
  });

  it('every url() resolves to an existing woff2 file', () => {
    for (const f of FONT_FACES) {
      const urls = [...f.body.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((m) => m[1]!);
      expect(urls).toHaveLength(1);
      const u = urls[0]!;
      expect(u.startsWith('./')).toBe(true);
      const file = resolve(dirname(TYPE_PATH), u);
      expect(existsSync(file), `${u} missing`).toBe(true);
      expect(file.endsWith('.woff2')).toBe(true);
      expect(statSync(file).size).toBeGreaterThan(1000);
    }
  });

  it("every cmap codepoint of each font is inside its face's unicode-range", () => {
    for (const f of FONT_FACES) {
      const d = decls(f.body);
      const url = /url\(\s*['"]?([^'")]+)/.exec(f.body)![1]!;
      const ranges = parseUnicodeRange(d.get('unicode-range')!);
      const cps = woff2Cmap(readFileSync(resolve(dirname(TYPE_PATH), url)));
      expect(cps.size, url).toBeGreaterThan(200);
      expect(cps.has(0x41) && cps.has(0x7a), `${url} lacks basic latin`).toBe(true);
      const outside = [...cps].filter((c) => !ranges.some(([lo, hi]) => c >= lo && c <= hi));
      expect(outside.map((c) => `U+${c.toString(16).toUpperCase()}`), url).toEqual([]);
    }
  });

  it('ships the OFL licence next to the fonts', () => {
    expect(read(resolve(THEME, 'fonts/OFL.txt'))).toMatch(/SIL Open Font License/);
  });
});

describe('legacy contract: Geist only under [data-accent]', () => {
  it('isAccentScoped rejects :not([data-accent]) and partly-scoped lists', () => {
    expect(isAccentScoped(':root[data-accent]')).toBe(true);
    expect(isAccentScoped(':where(:root[data-accent]) body h1')).toBe(true);
    expect(isAccentScoped(':root:not([data-accent])')).toBe(false);
    expect(isAccentScoped('body:not([data-accent] *)')).toBe(false);
    expect(isAccentScoped(':root[data-accent] code, pre')).toBe(false);
  });

  it('Geist family names appear only in @font-face or [data-accent] rules', () => {
    for (const r of RULES) {
      if (r.selector === '@font-face') continue;
      if (/Geist/.test(r.body)) expect(isAccentScoped(r.selector), r.selector).toBe(true);
    }
  });

  it('no app stylesheet names Geist outside a [data-accent] rule', () => {
    const cssFiles: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.css')) cssFiles.push(p);
      }
    };
    walk(resolve(PACKAGES, 'averrow-ops/src'));
    walk(resolve(PACKAGES, 'averrow-tenant/src'));
    expect(cssFiles.some((f) => f.endsWith('averrow-ops/src/index.css'))).toBe(true);
    expect(cssFiles.some((f) => f.endsWith('averrow-tenant/src/index.css'))).toBe(true);
    for (const f of cssFiles) {
      for (const r of rules(stripComments(read(f)))) {
        if (r.selector === '@font-face') continue;
        if (/Geist/i.test(r.body)) expect(isAccentScoped(r.selector), `${f}: ${r.selector}`).toBe(true);
      }
    }
  });

  it('--font-* and font-family overrides appear only under [data-accent]', () => {
    for (const r of RULES) {
      if (r.selector === '@font-face') continue;
      const d = decls(r.body);
      const touches = [...d.keys()].some((k) => k.startsWith('--font-') || k === 'font-family' || k === 'font');
      if (touches) expect(isAccentScoped(r.selector), r.selector).toBe(true);
    }
  });

  it('the --font-* overrides keep the legacy stacks as fallback', () => {
    const r = RULES.find((x) => x.selector === ':root[data-accent]');
    expect(r).toBeDefined();
    const d = decls(r!.body);
    expect(d.get('--font-sans')).toMatch(/^'Geist',.*'Plus Jakarta Sans'.*sans-serif$/);
    expect(d.get('--font-mono')).toMatch(/^'Geist Mono',.*'JetBrains Mono'.*monospace$/);
  });

  it('tokens.css (legacy :root) never names Geist', () => {
    expect(TOKENS).not.toMatch(/Geist/);
  });

  it('neither app\'s index.html source preloads a Geist font by hand (appearance-html adds them, FACELIFT on only)', () => {
    for (const app of ['averrow-ops', 'averrow-tenant']) {
      expect(read(resolve(PACKAGES, app, 'index.html'))).not.toMatch(/geist/i);
    }
  });
});

describe('base element styles', () => {
  const BASE = RULES.filter((r) => r.selector !== '@font-face' && r.selector !== ':root' && decls(r.body).has('font-size'));

  it('are all scoped under [data-accent]', () => {
    expect(BASE.length).toBe(3);
    for (const r of BASE) expect(isAccentScoped(r.selector), r.selector).toBe(true);
  });

  it('use unitless line-heights equal to the G3 ratios', () => {
    const want: Record<string, number> = { body: 21 / 14, h1: 30 / 24, h2: 24 / 18 };
    for (const r of BASE) {
      const el = /(body|h1|h2)$/.exec(r.selector)![1]!;
      const lh = decls(r.body).get('line-height')!;
      expect(lh, r.selector).toMatch(/^\d+(\.\d+)?$/);
      expect(Number(lh)).toBeCloseTo(want[el]!, 3);
    }
  });

  it('leave font-weight and letter-spacing inherited', () => {
    for (const r of BASE) {
      const d = decls(r.body);
      expect(d.has('font-weight'), r.selector).toBe(false);
      expect(d.has('letter-spacing'), r.selector).toBe(false);
    }
  });
});

describe('wiring', () => {
  it('tokens.css @imports type.css after appearance.css, before any rule', () => {
    const a = TOKENS.indexOf('@import "./appearance.css";');
    const t = TOKENS.indexOf('@import "./type.css";');
    expect(a).toBeGreaterThanOrEqual(0);
    expect(t).toBeGreaterThan(a);
    expect(TOKENS.indexOf('{')).toBeGreaterThan(t);
  });

  it('both Tailwind configs expose the text-type-* scale', () => {
    for (const app of ['averrow-ops', 'averrow-tenant']) {
      const cfg = read(resolve(PACKAGES, app, 'tailwind.config.ts'));
      for (const role of ['display', 'h1', 'h2', 'body', 'small', 'label', 'mono']) {
        expect(cfg, `${app} type-${role}`).toContain(`'type-${role}': ['var(--type-${role}-size)'`);
      }
    }
  });
});
