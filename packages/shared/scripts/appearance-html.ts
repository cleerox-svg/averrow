// Vite plugin shared by averrow-ops and averrow-tenant: generates the
// appearance parts of each app's index.html from the single FACELIFT switch in
// ../src/theme/appearanceDefaults.ts, so flipping (or reverting) the facelift
// is one line.
//
//   import { appearanceHtml } from '../shared/scripts/appearance-html';
//   plugins: [react(), appearanceHtml()]
//
// What it does (transformAppearanceHtml, order 'pre', dev + build):
//   * fills the inline no-flash bootstrap's constants line
//     (`__APPEARANCE_ACCENTS__`, `__APPEARANCE_BASES__`,
//     `__APPEARANCE_DEFAULT_ACCENT__`, `__APPEARANCE_DEFAULT_BASE__`) from
//     ACCENTS / BASES / the derived defaults;
//   * fills `__APPEARANCE_THEME_COLOR__` (theme-color meta);
//   * FACELIFT on: removes the Google Fonts block (the two preconnects and the
//     Plus Jakarta Sans / JetBrains Mono stylesheet). Removal is by WHOLE
//     source line: each entry of GOOGLE_FONTS_LINES must appear exactly once,
//     byte-for-byte (attribute order, quoting, ` />`), alone on its line; the
//     line's indentation and newline go with it. Editing those tags in
//     index.html means editing GOOGLE_FONTS_LINES too (the build fails
//     otherwise). With FACELIFT off the lines are not checked or touched. The
//     families stay in the --font-* stacks as fallback names only.
//   * FACELIFT on: swaps the ops legacy body paint (`bg-cockpit`, #080E18,
//     which is not a token) for the page token, so graphite / light show
//     correctly before React mounts and on overscroll (BODY_SWAPS; an
//     index.html without that tag, e.g. tenant, is left alone).
// Every __APPEARANCE_*__ marker must be present exactly once, or the build
// fails: a placeholder left in the page would be a runtime error in the
// bootstrap.
//
// Font preloads (fontPreloadTags, order 'post', BUILD ONLY, FACELIFT on):
// the Geist upright sans + mono woff2 are emitted by Vite from type.css with
// hashed names, so the hrefs are read from the output bundle (each asset's
// originalFileNames) and prefixed with the resolved `base`. The build fails if
// either file is missing from the bundle. The dev server gets no preload (a
// preload URL that differs from the one the CSS requests would download the
// font twice).
//
// PWA manifest (writeBundle, FACELIFT on): the copied public/manifest.json's
// theme_color / background_color are rewritten to the facelift page colour
// (both keys must exist, or the build fails). Apps without a manifest.json in
// the output are left alone.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ACCENTS, BASES, FACELIFT, appearanceFlags } from '../src/theme/appearanceDefaults';

/** The Geist files preloaded when the facelift is on (upright only: the
 *  italics are rare and load on demand). */
export const PRELOADED_FONTS = ['geist-sans-latin-var.woff2', 'geist-mono-latin-var.woff2'] as const;

/** The Google Fonts block removed when the facelift is on (each line exactly
 *  as written in both index.html files, without its leading indentation). */
export const GOOGLE_FONTS_LINES = [
  '<link rel="preconnect" href="https://fonts.googleapis.com" />',
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />',
  '<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700;800&display=swap" rel="stylesheet" />',
] as const;

const jsString = (v: string | null): string => (v === null ? 'null' : `'${v}'`);
const jsArray = (vs: readonly string[]): string => `[${vs.map((v) => `'${v}'`).join(', ')}]`;

function replaceOnce(html: string, find: string, replacement: string): string {
  const first = html.indexOf(find);
  if (first < 0 || html.indexOf(find, first + find.length) >= 0) {
    throw new Error(`appearance-html: expected exactly one ${JSON.stringify(find)} in index.html`);
  }
  return html.slice(0, first) + replacement + html.slice(first + find.length);
}

/** Legacy body tags replaced when the facelift is on: [exact source, replacement].
 *  The page token (with the facelift page colour as fallback before the CSS
 *  bundle defines it) and the primary text colour follow mode / base. */
export const BODY_SWAPS: ReadonlyArray<readonly [string, string]> = [
  ['<body class="bg-cockpit text-parchment">',
    '<body style="background-color: var(--bg-page, #0a0b0e); color: var(--text-primary, #f6f7f7)">'],
];

/** Fill the appearance markers in an index.html source for one value of the
 *  facelift switch (pure; the plugin passes FACELIFT). */
export function transformAppearanceHtml(html: string, facelift: boolean = FACELIFT): string {
  const flags = appearanceFlags(facelift);
  let out = html;
  out = replaceOnce(out, '__APPEARANCE_ACCENTS__', jsArray(ACCENTS));
  out = replaceOnce(out, '__APPEARANCE_BASES__', jsArray(BASES));
  out = replaceOnce(out, '__APPEARANCE_DEFAULT_ACCENT__', jsString(flags.defaultAccent));
  out = replaceOnce(out, '__APPEARANCE_DEFAULT_BASE__', jsString(flags.defaultBase));
  out = replaceOnce(out, '__APPEARANCE_THEME_COLOR__', flags.themeColor);
  if (facelift) {
    for (const line of GOOGLE_FONTS_LINES) {
      // Drop the whole source line: indentation, the tag and its newline.
      const m = new RegExp(`\\n[ \\t]*${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*(?=\\n)`).exec(out);
      if (!m || out.indexOf(line, m.index + m[0].length) >= 0) {
        throw new Error(`appearance-html: expected exactly one Google Fonts line ${JSON.stringify(line)} in index.html`);
      }
      out = out.slice(0, m.index) + out.slice(m.index + m[0].length);
    }
    for (const [from, to] of BODY_SWAPS) {
      if (out.includes(from)) out = replaceOnce(out, from, to);
    }
  }
  return out;
}

/** The bundle entries fontPreloadTags reads (structural subset of Rollup's
 *  OutputAsset / OutputChunk). */
export interface BundleEntry {
  type: string;
  fileName: string;
  names?: readonly string[];
  originalFileNames?: readonly string[];
  name?: string;
}

export interface HtmlTag {
  tag: string;
  attrs: Record<string, string | boolean>;
  injectTo: 'head';
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i < 0 ? p : p.slice(i + 1);
}

/** <link rel="preload"> tags for the Geist upright fonts, resolved from the
 *  build output. Empty when the facelift is off. Throws when on and a font is
 *  not in the bundle (a preload to a missing file would be a wasted 404). */
export function fontPreloadTags(
  bundle: Record<string, BundleEntry>, base: string, facelift: boolean = FACELIFT,
): HtmlTag[] {
  if (!facelift) return [];
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return PRELOADED_FONTS.map((font) => {
    const asset = Object.values(bundle).find((e) => {
      if (e.type !== 'asset') return false;
      const sources = [...(e.originalFileNames ?? []), ...(e.names ?? []), ...(e.name ? [e.name] : [])];
      return sources.some((s) => basename(s) === font);
    });
    if (!asset) throw new Error(`appearance-html: ${font} is not in the build output; cannot preload it`);
    return {
      tag: 'link',
      attrs: { rel: 'preload', href: `${prefix}${asset.fileName}`, as: 'font', type: 'font/woff2', crossorigin: true },
      injectTo: 'head' as const,
    };
  });
}

/** Rewrite a PWA manifest's colours to the facelift page colour (pure). */
export function transformManifest(json: string, facelift: boolean = FACELIFT): string {
  if (!facelift) return json;
  const color = appearanceFlags(true).themeColor;
  let out = json;
  for (const key of ['theme_color', 'background_color']) {
    const re = new RegExp(`("${key}"\\s*:\\s*)"[^"]*"`);
    if (!re.test(out)) throw new Error(`appearance-html: manifest.json has no "${key}" to set to the facelift colour`);
    out = out.replace(re, `$1"${color}"`);
  }
  return out;
}

// Minimal structural Vite plugin types (vite is not a dependency of
// @averrow/shared, so its types are not importable from here).
interface HtmlCtx { bundle?: Record<string, BundleEntry> }
interface AppearancePlugin {
  name: string;
  configResolved?: (config: { base: string; command: string }) => void;
  transformIndexHtml?: {
    order: 'pre' | 'post';
    handler: (html: string, ctx: HtmlCtx) => string | { html: string; tags: HtmlTag[] };
  };
  writeBundle?: (options: { dir?: string }) => void;
}

export function appearanceHtml(): AppearancePlugin[] {
  let base = '/';
  return [
    {
      name: 'averrow-appearance-html',
      configResolved(config) { base = config.base; },
      transformIndexHtml: { order: 'pre', handler: (html) => transformAppearanceHtml(html) },
    },
    {
      name: 'averrow-appearance-font-preload',
      transformIndexHtml: {
        order: 'post',
        handler: (html, ctx) => (ctx.bundle ? { html, tags: fontPreloadTags(ctx.bundle, base) } : html),
      },
      writeBundle(options) {
        if (!FACELIFT || !options.dir) return;
        const file = join(options.dir, 'manifest.json');
        if (!existsSync(file)) return;
        writeFileSync(file, transformManifest(readFileSync(file, 'utf8')));
      },
    },
  ];
}
