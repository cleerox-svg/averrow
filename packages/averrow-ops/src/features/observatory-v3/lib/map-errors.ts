/**
 * MapLibre emits `error` for many recoverable things (one tile 404, a sprite
 * or glyph hiccup, a flaky source). Only a failure to obtain the base style —
 * or losing the WebGL context — leaves nothing to show; everything else must
 * leave the map on screen.
 */

export interface MapErrorLike {
  error?: { message?: string; status?: number; url?: string } | null;
  sourceId?: string;
  tile?: unknown;
}

export type MapErrorSeverity = 'fatal' | 'transient';

export function classifyMapError(e: MapErrorLike, ctx: { styleLoaded: boolean }): MapErrorSeverity {
  if (ctx.styleLoaded) return 'transient';
  if (e.sourceId || e.tile) return 'transient';
  const msg = e.error?.message ?? '';
  const url = e.error?.url ?? '';
  if (/style/i.test(msg) || /style\.json/i.test(url)) return 'fatal';
  return 'transient';
}
