// Generates packages/shared/src/theme/appearance.css from the approved
// palette sources in docs/brand/palettes/{indigo,violet,mono,lime}.css plus
// the review-fix OVERRIDES / computed extras below (this script is the real
// source for every value that differs from, or is not in, the palette files).
//
//   node packages/shared/scripts/gen-appearance.mjs
//
// Transformations vs the palette files (see BRAND_BRIEF §8-§10):
//   * Every rule is scoped under :root[data-accent], so NOTHING applies unless
//     an accent attribute is present (legacy look intact).
//   * Graphite is the default dark base (also when data-base is absent or
//     invalid); navy only applies for data-base="navy". Light ignores base.
//   * The --amber family (--amber*, --text-on-amber) is dropped: amber stays
//     the STATUS amber in every accent.
//   * Hex only (the palettes' oklch twins differ by <=2/255 in sRGB).
//   * Declarations are de-duplicated into layers: common (all accents) ->
//     per-accent -> per-base neutrals, to keep the CSS small.
//   * Aliases (--status-*, --chart-*, --disabled-*, ...) live in tokens.css and
//     follow these values through var(); only literals are emitted here.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const ACCENTS = ['indigo', 'violet', 'mono', 'lime'];
const MODES = ['graphite', 'navy', 'light'];

const DROP = (name) => name === '--text-on-amber' || name === '--amber' || name.startsWith('--amber-');
const NEUTRAL = /^--(bg-[\w-]+|border|border-(base|strong|sidebar)|text-(primary|secondary|tertiary|muted|help|inverse))$/;
// shell-v4.css redeclares tokens on `.shell-v4` (deeper dark cards in dark mode,
// boosted glows in every mode). A custom property declared on the shell element
// beats the value inherited from :root, so every shell token that this file also
// sets is re-emitted under a `… .shell-v4` selector (see shellOverrides()). The
// list is parsed from shell-v4.css, never hand-kept.
const SHELL_CSS = 'packages/averrow-ops/src/components/layout/shell-v4.css';

/** Custom-property declarations of one rule body. Split on `;` so a final
 *  declaration without a trailing `;` is still read. */
function customProps(body) {
  const out = [];
  for (const part of body.split(';')) {
    const m = /^\s*(--[\w-]+)\s*:\s*([\s\S]*\S)\s*$/.exec(part);
    if (m) out.push([m[1], m[2]]);
  }
  return out;
}

/** Parse the `.shell-v4` token blocks of shell-v4.css -> { all: Map, dark: Map }.
 *  Walks the brace structure so a token block nested in an @-rule (@media,
 *  @supports, ...) is detected and refused rather than silently flattened into
 *  an unconditional override. */
function parseShell(src) {
  const out = { all: new Map(), dark: new Map() };
  const flat = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const stack = []; // open-block preludes, outermost first
  let start = 0;
  for (let i = 0; i < flat.length; i++) {
    const ch = flat[i];
    if (ch === '{') {
      stack.push(flat.slice(start, i).trim().replace(/\s+/g, ' '));
      start = i + 1;
    } else if (ch === '}') {
      const sel = stack.pop();
      if (sel === undefined) throw new Error('gen-appearance: unbalanced "}" in shell-v4.css');
      const decls = customProps(flat.slice(start, i));
      start = i + 1;
      if (!decls.length || !/\.shell-v4\b/.test(sel)) continue;
      const atRule = stack.find((p) => p.startsWith('@'));
      if (atRule) {
        throw new Error(`gen-appearance: shell-v4.css declares custom properties on "${sel}" inside "${atRule}" - teach parseShell() to scope them instead of flattening`);
      }
      let kind;
      if (sel === '.shell-v4') kind = 'all';
      else if (sel === ':root:not([data-theme="light"]) .shell-v4') kind = 'dark';
      else throw new Error(`gen-appearance: unhandled shell-v4.css token selector "${sel}" - teach parseShell() about it`);
      for (const [k, v] of decls) out[kind].set(k, v);
    } else if (ch === ';' && stack.length === 0) {
      start = i + 1; // top-level statement (@import / @charset)
    }
  }
  if (stack.length) throw new Error('gen-appearance: unbalanced "{" in shell-v4.css');
  return out;
}
const SHELL = parseShell(readFileSync(resolve(root, SHELL_CSS), 'utf8'));
// Dark-only shell tokens are excluded from the shared dark layers (they are
// emitted per base together with the .shell-v4 copy).
const SHELL_TOKENS = [...SHELL.dark.keys()];

// ── colour helpers ───────────────────────────────────────────────────
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hexOf = (c) => '#' + c.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
const lin = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
function hsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const M = Math.max(r, g, b), m = Math.min(r, g, b), l = (M + m) / 2;
  let s = 0, h = 0;
  if (M !== m) {
    const d = M - m;
    s = l > 0.5 ? d / (2 - M - m) : d / (M + m);
    h = M === r ? (g - b) / d + (g < b ? 6 : 0) : M === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}
function unhsl([h, s, l]) {
  const f = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  return [f(p, q, h + 1 / 3), f(p, q, h), f(p, q, h - 1 / 3)].map((x) => x * 255);
}
const rgba = (c, a) => `rgba(${c.map(Math.round).join(', ')}, ${a})`;

/** Parse a colour literal -> [r, g, b, a]. Only 6-digit hex, rgb() with exactly
 *  3 comma-separated channels and rgba() with 3 channels + alpha are accepted;
 *  anything else (var(), keywords, 3/8-digit hex, space syntax) throws. */
function parseColour(v) {
  if (/^#[0-9a-f]{6}$/i.test(v)) return [...rgbOf(v), 1];
  const m = /^(rgba?)\(([^()]*)\)$/.exec(v);
  const parts = m ? m[2].split(',').map((x) => x.trim()) : [];
  const want = m?.[1] === 'rgba' ? 4 : 3;
  if (!m || parts.length !== want || !parts.every((x) => /^\d*\.?\d+$/.test(x))) {
    throw new Error(`gen-appearance: unsupported colour literal "${v}" (6-digit hex, rgb(r, g, b) or rgba(r, g, b, a) only)`);
  }
  const n = parts.map(Number);
  return want === 4 ? n : [...n, 1];
}
const isColour = (v) => { try { parseColour(v); return true; } catch { return false; } };
const alphaOf = (v) => parseColour(v)[3];
const rgbOfAny = (v) => parseColour(v).slice(0, 3);

class HoverContrastError extends Error {
  constructor(msg) { super(msg); this.name = 'HoverContrastError'; }
}
// What is enforced (every accent x mode; a miss is a build error):
//   * --primary-hover is distinguishable from --primary (luminance contrast
//     ratio >= HOVER_MIN_STEP) and keeps --primary-ink >= 4.5:1 on it;
//   * --primary-pressed is distinguishable from --primary-hover (same ratio)
//     and keeps --primary-ink >= 4.5:1 on it.
// Direction is a palette choice, not checked: indigo and violet hover/pressed
// DARKEN the fill (owner decision, OVERRIDES below); mono and lime keep their
// palette direction.
const HOVER_MIN_STEP = 1.1;
function checkHover(where, map) {
  const get = (k) => rgbOf(map.get(k));
  const ink = get('--primary-ink');
  for (const [from, to] of [['--primary', '--primary-hover'], ['--primary-hover', '--primary-pressed']]) {
    const step = contrast(get(from), get(to)), inkOn = contrast(ink, get(to));
    if (step < HOVER_MIN_STEP || inkOn < 4.5) {
      throw new HoverContrastError(`${where}: ${to} ${map.get(to)} fails (step from ${from} ${step.toFixed(2)} < ${HOVER_MIN_STEP} or ink ${inkOn.toFixed(2)} < 4.5)`);
    }
  }
}

// ── review-fix overrides (applied on top of the palette values) ──────
const SEV_LOW_DARK = {
  '--sev-low': '#60a5fa', '--sev-low-bg': 'rgba(59, 130, 246, 0.07)',
  '--sev-low-border': 'rgba(59, 130, 246, 0.2)', '--sev-low-glow': 'rgba(59, 130, 246, 0.4)',
  '--sev-low-text': '#bddaff',
};
const SEV_LOW_LIGHT = { ...SEV_LOW_DARK, '--sev-low-text': '#00519f' };

// Severity is constant across accents (CLAUDE.md §5); lime is the one
// documented exception: sev-info is unified with its emerald healthy green.
const OVERRIDES = {
  all: {
    // --violet stays one purple in every accent (the palettes repainted it pink
    // in indigo/violet and kept legacy #8B7CF6 in mono/lime).
    dark: { ...SEV_LOW_DARK, '--violet': '#a855f7', '--violet-text': '#d8b4fe' },
    light: { ...SEV_LOW_LIGHT, '--healthy': 'var(--green-text)', '--violet': '#a855f7', '--violet-text': '#7e22ce' },
    graphite: {
      // Graphite card vs page is ~1.1:1: stronger hairlines carry the separation.
      '--border-base': 'rgba(245, 245, 246, 0.11)', '--border': 'rgba(245, 245, 246, 0.11)',
      '--border-strong': 'rgba(245, 245, 246, 0.2)',
    },
  },
  indigo: {
    // Hover/pressed darken the fill (the palette hover was ~1.02:1 vs the fill).
    dark: { '--tag-nexus': '#c084fc', '--primary-hover': '#4350ec', '--primary-pressed': '#3640d0' },
    light: { '--tag-nexus': '#7e22ce' },
  },
  violet: {
    // Pink NEXUS tag: not teal (cyan-text/healthy/orbital-teal) and clearly not
    // the violet primary.
    dark: { '--tag-nexus': '#f0abfc', '--primary-hover': '#8338ec', '--primary-pressed': '#7020d6' },
    light: { '--tag-nexus': '#be185d' },
  },
  mono: {
    // Mono's primary is a neutral, so chart series 1 cannot follow it and five
    // chromatic series are needed: cyan leads, then the tokens.css hues plus
    // magenta (~298 dark / 300 light, >= 25deg from --violet 271 and pink 326).
    dark: { '--chart-1': '#20cadf', '--chart-2': '#ef6cb6', '--chart-3': '#5ed147', '--chart-4': '#b7e236', '--chart-5': '#e47de8' },
    light: { '--chart-1': '#078388', '--chart-2': '#c91d7e', '--chart-3': '#268613', '--chart-4': '#688807', '--chart-5': '#b620b6' },
  },
  lime: {
    // One emerald green: --green = --healthy (alias in tokens.css) = --sev-info.
    dark: {
      // Chart: yellow-green (75) is 8deg from the lime primary (83) -> magenta.
      '--chart-5': '#e47de8',
      '--green': '#10b981', '--green-glow': 'rgba(16, 185, 129, 0.2)',
      '--sev-info': '#10b981', '--sev-info-bg': 'rgba(16, 185, 129, 0.07)',
      '--sev-info-border': 'rgba(16, 185, 129, 0.15)', '--sev-info-glow': 'rgba(16, 185, 129, 0.4)',
    },
    light: {
      // Accent-as-text moves to the near-black olive (palette #3c6200 read as
      // the same family as the emerald healthy green).
      '--primary-text': '#2a3a12', '--focus-ring': '#2a3a12', '--text-accent': '#2a3a12',
      '--accent': '#2a3a12', '--accent-section': '#2a3a12',
      // Chart: the olive primary (84) and emerald healthy (163) leave no room
      // for the light cyan (182 is 19deg from 163) or olive (75): magenta, two
      // greens between them (111 / 137, each >= 25deg from 84, 163 and each
      // other) and pink.
      '--chart-2': '#b620b6', '--chart-3': '#2a8b18', '--chart-4': '#c91d7e', '--chart-5': '#178235',
      '--green': '#047857', '--green-text': '#047857', '--green-glow': 'rgba(4, 120, 87, 0.2)',
      '--sev-info': '#047857', '--sev-info-bg': 'rgba(4, 120, 87, 0.07)',
      '--sev-info-border': 'rgba(4, 120, 87, 0.15)', '--sev-info-glow': 'rgba(4, 120, 87, 0.4)',
    },
  },
};

/** Palette -> hex declarations for one block, keyed by token. */
function parsePalette(src) {
  const re = /\/\* ---- (dark navy|dark graphite|light)[^:]*: (hex fallbacks|oklch) ---- \*\//g;
  const marks = [];
  let m;
  while ((m = re.exec(src))) marks.push({ idx: m.index, end: re.lastIndex, key: m[1], fmt: m[2] });
  const out = {};
  marks.forEach((mk, i) => {
    if (mk.fmt === 'oklch') return;
    const body = src.slice(mk.end, i + 1 < marks.length ? marks[i + 1].idx : src.length);
    const decls = new Map();
    for (const d of body.matchAll(/^\s*(--[\w-]+)\s*:\s*([^;]+);/gm)) {
      if (!DROP(d[1])) decls.set(d[1], d[2].trim());
    }
    out[mk.key === 'dark navy' ? 'navy' : mk.key === 'dark graphite' ? 'graphite' : 'light'] = decls;
  });
  return out;
}

const sets = {}; // sets[accent][mode] = Map
for (const accent of ACCENTS) {
  const pal = parsePalette(readFileSync(resolve(root, `docs/brand/palettes/${accent}.css`), 'utf8'));
  sets[accent] = {};
  for (const mode of MODES) {
    const map = pal[mode];
    if (!map?.size) throw new Error(`${accent}: missing ${mode} block`);
    const kind = mode === 'light' ? 'light' : 'dark';
    const apply = (o) => Object.entries(o ?? {}).forEach(([k, v]) => map.set(k, v));
    apply(OVERRIDES.all[kind]);
    if (mode === 'graphite') apply(OVERRIDES.all.graphite);
    apply(OVERRIDES[accent][kind]);

    const primary = rgbOf(map.get('--primary'));
    checkHover(`${accent}/${mode}`, map);
    // Every hover alias is the one hover colour.
    map.set('--btn-primary-bg-hover', map.get('--primary-hover'));
    map.set('--accent-hover', map.get('--primary-hover'));
    map.set('--primary-border', rgba(primary, 0.38));
    map.set('--primary-tint-strong', rgba(primary, 0.22));
    map.set('--selection-bg', rgba(primary, kind === 'dark' ? 0.32 : 0.22));
    // link-hover: primary-text pushed 35% toward white (dark) / black (light).
    map.set('--link-hover', hexOf(mix(rgbOf(map.get('--primary-text')), kind === 'dark' ? [255, 255, 255] : [0, 0, 0], 0.35)));
    sets[accent][mode] = map;
  }
}

// ── layering ─────────────────────────────────────────────────────────
const intersect = (maps, exclude = () => false) => {
  const out = new Map();
  for (const [k, v] of maps[0]) {
    if (exclude(k)) continue;
    if (maps.every((m) => m.get(k) === v)) out.set(k, v);
  }
  return out;
};
const minus = (map, ...others) => new Map([...map].filter(([k]) => !others.some((o) => o.has(k))));
const noShell = (k) => SHELL_TOKENS.includes(k);

const allDark = ACCENTS.flatMap((a) => [sets[a].graphite, sets[a].navy]);
const allLight = ACCENTS.map((a) => sets[a].light);
const commonDark = intersect(allDark, (k) => NEUTRAL.test(k) || noShell(k));
// light: neutrals are shared across bases but differ per accent, so only non-neutral share.
const commonLight = intersect(allLight, (k) => NEUTRAL.test(k));

// Links follow the accent (legacy: amber-text, defined in tokens.css).
commonDark.set('--link', 'var(--primary-text)');
commonLight.set('--link', 'var(--primary-text)');

/** Shell tokens this file also sets for a combo. Dark-only shell tokens take
 *  the accent value; all-mode colour tokens (the glows) keep the accent colour
 *  at the shell's boosted alpha when the shell boosts it. A non-colour all-mode
 *  token (e.g. --card-shadow, --card-radius) re-emits the shell's own value -
 *  it is never replaced by an accent value. Anything else unexpected throws. */
function shellOverrides(map, kind) {
  const out = new Map();
  for (const [k, shellV] of SHELL.all) {
    if (!map.has(k)) continue;
    if (!isColour(shellV)) { out.set(k, shellV); continue; }
    const v = map.get(k);
    if (!isColour(v)) throw new Error(`gen-appearance: ${k} is a colour in shell-v4.css (${shellV}) but not in the palette (${v})`);
    out.set(k, alphaOf(shellV) <= alphaOf(v) ? v : rgba(rgbOfAny(v), alphaOf(shellV)));
  }
  if (kind === 'dark') {
    for (const [k, shellV] of SHELL.dark) {
      if (!map.has(k)) continue;
      const v = map.get(k);
      if (!isColour(shellV) || !isColour(v)) throw new Error(`gen-appearance: dark shell token ${k} is not a colour (shell ${shellV}, palette ${v}) - decide how to scope it`);
      out.set(k, v);
    }
  }
  return out;
}

const fmt = (map) => [...map].map(([k, v]) => `  ${k}: ${v};`).join('\n');
const block = (sel, map) => (map.size ? `${sel} {\n${fmt(map)}\n}\n` : '');

let css = `/* GENERATED by packages/shared/scripts/gen-appearance.mjs from docs/brand/palettes/*.css.
   DO NOT EDIT BY HAND - edit the palette sources or the script and re-run it.

   Appearance system (Phase 3). Every rule below is scoped under
   :root[data-accent], so with no data-accent attribute NONE of this applies
   and the legacy look in tokens.css is untouched.

   Layers: L0 neutrals (graphite default, navy via data-base="navy", light
   ignores base) + L1 accent + L2 semantic (--primary*, --link*, ...).
   Aliases (--status-*, --chart-*, --disabled-*) live in tokens.css.
   --amber stays the status amber in every accent. */

/* ---- common (identical in every accent) ---- */
`;
css += block(':root[data-accent]:not([data-theme="light"])', commonDark);
css += block(':root[data-accent][data-theme="light"]', commonLight);
css += `:root[data-accent] ::selection {\n  background: var(--selection-bg);\n  color: var(--text-selection);\n}\n`;

for (const accent of ACCENTS) {
  const { graphite, navy, light } = sets[accent];
  const accentDark = minus(intersect([graphite, navy], (k) => NEUTRAL.test(k) || noShell(k)), commonDark);
  const a = `:root[data-accent="${accent}"]`;
  css += `\n/* ---- ${accent} ---- */\n`;
  css += block(`${a}:not([data-theme="light"])`, accentDark);
  for (const [name, map] of [['graphite', graphite], ['navy', navy]]) {
    const sel = `${a}${name === 'navy' ? '[data-base="navy"]' : ':not([data-base="navy"])'}:not([data-theme="light"])`;
    const rest = minus(map, commonDark, accentDark);
    css += block(sel, rest);
    css += block(`${sel} .shell-v4`, shellOverrides(map, 'dark'));
  }
  css += block(`${a}[data-theme="light"]`, minus(light, commonLight));
  css += block(`${a}[data-theme="light"] .shell-v4`, shellOverrides(light, 'light'));
}

writeFileSync(resolve(root, 'packages/shared/src/theme/appearance.css'), css);
console.log('wrote packages/shared/src/theme/appearance.css', css.length, 'bytes');
