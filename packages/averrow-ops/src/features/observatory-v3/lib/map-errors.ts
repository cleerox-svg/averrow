/**
 * MapLibre emits `error` for many recoverable things (one tile 404, a sprite
 * or glyph hiccup, a flaky source). Only a failure to obtain the base style —
 * or losing the WebGL context — leaves nothing to show; everything else must
 * leave the map on screen.
 *
 * A sprite / glyph request lives under the style's directory
 * (`.../dark-matter-gl-style/sprite.json`), so matching on the word "style" is
 * wrong: the error is fatal only when the failed request IS the style document.
 */

export interface MapErrorLike {
  error?: { message?: string; status?: number; url?: string } | null;
  sourceId?: string;
  tile?: unknown;
}

export type MapErrorSeverity = 'fatal' | 'transient';

export interface MapErrorContext {
  /** True once `style.load` has fired — after that nothing is fatal. */
  styleLoaded: boolean;
  /** The base style document URL; a failed request for exactly this URL is fatal. */
  styleUrl?: string;
}

/** Compare URLs ignoring query / hash (MapLibre may append an access token or cache-buster). */
function sameResource(a: string, b: string): boolean {
  const strip = (u: string) => u.split('#')[0].split('?')[0];
  return strip(a) === strip(b);
}

export function classifyMapError(e: MapErrorLike, ctx: MapErrorContext): MapErrorSeverity {
  if (ctx.styleLoaded) return 'transient';
  if (e.sourceId || e.tile) return 'transient';
  const url = e.error?.url ?? '';
  if (url) {
    // A request URL is present: it is the style only if it equals the style URL.
    return ctx.styleUrl && sameResource(url, ctx.styleUrl) ? 'fatal' : 'transient';
  }
  // No URL: a style parse/validation failure surfaces as "Style ..." from MapLibre itself.
  return /^style\b/i.test(e.error?.message ?? '') ? 'fatal' : 'transient';
}
