/**
 * The places the Observatory depends on MapLibre behaviour that is not part of its documented API, in one file so a
 * MapLibre upgrade has a single place to look:
 *
 *   1. the web worker URL. MapLibre 6 is ESM-only and, under a bundler, cannot find its worker on its own: the app
 *      hands it the bundled worker (`setWorkerUrl`). Done once per page, before the first `Map` is built.
 *   2. `map.transform`. MapLibre 6 removed it (`Map` now composes a `Camera`; the transform lives on `map._camera`).
 *      Two things still read it: this feature (latitude range, globe occlusion) and `@deck.gl/mapbox` (9.2 - 9.4 read
 *      `map.transform.height`, `.elevation`, `._nearZ` and `._farZ` every interleaved frame, and no released deck.gl
 *      has dropped that). `installTransformAlias` puts a read-only `transform` accessor back on the map instance.
 *
 * Everything here is guarded and degrades to "not applied", never to a throw.
 */

import { setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

let workerReady = false;
/** Dev-only, once per kind: a compat step that did not apply is silent in production by design (it degrades), but a developer should see it. */
const warnedKinds = new Set<string>();
function devWarn(kind: string, message: string): void {
  if (process.env.NODE_ENV === 'production' || warnedKinds.has(kind)) return;
  warnedKinds.add(kind);
  console.warn(`[observatory] ${message}`);
}
/** Test hook: forget which dev warnings were already shown. */
export function resetCompatWarnings(): void { warnedKinds.clear() }
/** Point MapLibre at the bundled worker (idempotent). Returns whether it was applied. */
export function ensureMapWorker(): boolean {
  if (workerReady) return true;
  try {
    if (typeof workerUrl !== 'string' || workerUrl === '') {
      devWarn('worker', 'ensureMapWorker: no bundled MapLibre worker URL, so MapLibre falls back to its own default and may fail to start a worker under this bundler. Re-check lib/maplibre-compat.ts.');
      return false;
    }
    setWorkerUrl(workerUrl);
    workerReady = true;
  } catch (err) {
    /* a stub or an old library: MapLibre falls back to its own default */
    devWarn('worker', `ensureMapWorker: setWorkerUrl failed (${err instanceof Error ? err.message : String(err)}); MapLibre falls back to its own default worker.`);
  }
  return workerReady;
}

/** What the Observatory (and deck.gl) read off a map to find its transform. */
interface TransformHolder {
  transform?: unknown;
  _camera?: { transform?: unknown } | null;
}

/**
 * The map's transform, whichever way this MapLibre exposes it: `map.transform` (5.x) or `map._camera.transform` (6.x).
 * `null` when neither exists (a test stub, a future major).
 */
export function mapTransform(map: unknown): unknown {
  const m = map as TransformHolder | null | undefined;
  if (!m) return null;
  return m.transform ?? m._camera?.transform ?? null;
}

/**
 * Restore `map.transform` as a read-only accessor onto the camera's transform when this MapLibre no longer has it,
 * so `@deck.gl/mapbox` keeps working in interleaved mode. A no-op on MapLibre 5 (the property is there) and when there
 * is no camera to alias. Returns whether an alias was installed. Callers that need to know whether deck.gl can read a
 * transform at all should use `canInterleave(map)`: this return is false on MapLibre 5 too, where nothing was needed.
 */
export function installTransformAlias(map: unknown): boolean {
  const m = map as TransformHolder | null | undefined;
  if (!m || m.transform !== undefined) return false;
  if (!m._camera) {
    devWarn('transform', 'installTransformAlias: this map has neither `transform` nor `_camera`; deck.gl cannot read its transform, so the globe is not drawn interleaved. Re-check lib/maplibre-compat.ts.');
    return false;
  }
  Object.defineProperty(m, 'transform', { configurable: true, enumerable: false, get: () => (map as TransformHolder)._camera?.transform });
  return true;
}

/** Whether `@deck.gl/mapbox` can read this map's transform (native on MapLibre 5, or aliased on 6 by `installTransformAlias`, which must have run): exactly what deck.gl reads, `map.transform`: the precondition for the interleaved globe overlay. */
export function canInterleave(map: unknown): boolean {
  return (map as TransformHolder | null | undefined)?.transform != null;
}
