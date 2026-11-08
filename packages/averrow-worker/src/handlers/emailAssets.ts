/**
 * Long-cache wrapper for the hosted email logo (facelift Phase 4).
 *
 * Gmail's image proxy refuses to show an image whose revalidation fails
 * instead of serving its stale copy (PR-BB / PR-BF). The old logos got a
 * one-year `immutable` header from the frozen legacy `public/_headers`;
 * the R3 PNG ships in the ops build (`/v2/email/averrow-mark-r3.png`),
 * which that file can't cover without touching the freeze. So emails
 * reference `/email/averrow-mark-r3.png` instead: no static asset exists at
 * that path, the asset layer misses and the request reaches the Worker
 * (no `run_worker_first` in wrangler.toml), and this handler fetches the
 * PNG from the ASSETS binding and re-serves it with the long cache.
 *
 * The bytes never change under this filename — a new mark gets a new name.
 */

import type { Env } from "../types";

/** Public path emails reference (EMAIL_LOGO_URL). */
export const EMAIL_LOGO_PATH = "/email/averrow-mark-r3.png";
/** Where the ops build actually ships the file. */
export const EMAIL_LOGO_ASSET_PATH = "/v2/email/averrow-mark-r3.png";
export const EMAIL_LOGO_CACHE_CONTROL = "public, max-age=31536000, immutable";

export async function handleEmailLogo(request: Request, env: Env): Promise<Response> {
  const assetUrl = new URL(EMAIL_LOGO_ASSET_PATH, request.url).toString();
  // Pass conditional headers through so a revalidation can 304.
  const headers = new Headers();
  for (const h of ["If-None-Match", "If-Modified-Since"]) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  const asset = await env.ASSETS.fetch(new Request(assetUrl, { method: "GET", headers }));
  if (asset.status !== 200 && asset.status !== 304) {
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
  const out = new Headers({
    "Content-Type": "image/png",
    "Cache-Control": EMAIL_LOGO_CACHE_CONTROL,
  });
  for (const h of ["ETag", "Last-Modified"]) {
    const v = asset.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(request.method === "HEAD" || asset.status === 304 ? null : asset.body, {
    status: asset.status,
    headers: out,
  });
}
