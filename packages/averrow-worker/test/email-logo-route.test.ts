// Facelift Phase 4 review fix: the hosted email logo needs a one-year
// immutable Cache-Control for Gmail's image proxy (PR-BB / PR-BF). The PNG
// ships in the ops build at /v2/email/, which the frozen public/_headers
// can't cover, so emails reference the Worker route /email/averrow-mark-r3.png
// that re-serves it from ASSETS with the long cache.

import { describe, it, expect, vi } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Router } from "itty-router";
import type { IRequest, RouterType } from "itty-router";
import { registerPublicRoutes } from "../src/routes/public";
import { EMAIL_LOGO_PATH, EMAIL_LOGO_ASSET_PATH, EMAIL_LOGO_CACHE_CONTROL } from "../src/handlers/emailAssets";
import { EMAIL_LOGO_URL } from "../src/templates/brand";
import { DEFAULT_ABUSE_BRANDING } from "../src/lib/abuse-mailbox-branding";
import type { Env } from "../src/types";

const WORKER = resolve(__dirname, "..");
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeEnv(asset: (req: Request) => Response) {
  const fetch = vi.fn(async (req: Request) => asset(req));
  return { env: { ASSETS: { fetch } } as unknown as Env, fetch };
}

async function hit(env: Env, init?: RequestInit): Promise<Response> {
  const router: RouterType<IRequest> = Router();
  registerPublicRoutes(router);
  return (await router.fetch(new Request(`https://averrow.com${EMAIL_LOGO_PATH}`, init), env, ctx)) as Response;
}

describe("GET /email/averrow-mark-r3.png", () => {
  it("emails and the abuse default branding point at the Worker route", () => {
    expect(EMAIL_LOGO_URL).toBe(`https://averrow.com${EMAIL_LOGO_PATH}`);
    expect(DEFAULT_ABUSE_BRANDING.logoUrl).toBe(EMAIL_LOGO_URL);
  });

  it("re-serves the ops-built PNG with a one-year immutable cache, PNG type and ETag", async () => {
    const { env, fetch } = makeEnv(() => new Response(PNG, {
      status: 200,
      headers: { "Content-Type": "image/png", ETag: '"abc"', "Cache-Control": "public, max-age=0, must-revalidate" },
    }));
    const res = await hit(env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(EMAIL_LOGO_CACHE_CONTROL);
    expect(EMAIL_LOGO_CACHE_CONTROL).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("ETag")).toBe('"abc"');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    const req = fetch.mock.calls[0]![0] as Request;
    expect(new URL(req.url).pathname).toBe(EMAIL_LOGO_ASSET_PATH);
  });

  it("passes a conditional request through and returns the asset's 304", async () => {
    const { env, fetch } = makeEnv((req) =>
      req.headers.get("If-None-Match") === '"abc"'
        ? new Response(null, { status: 304, headers: { ETag: '"abc"' } })
        : new Response(PNG, { status: 200 }));
    const res = await hit(env, { headers: { "If-None-Match": '"abc"' } });
    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe('"abc"');
    expect(res.headers.get("Cache-Control")).toBe(EMAIL_LOGO_CACHE_CONTROL);
    expect((fetch.mock.calls[0]![0] as Request).headers.get("If-None-Match")).toBe('"abc"');
  });

  it("404s (uncached) when the ops build didn't ship the file", async () => {
    const { env } = makeEnv(() => new Response("nope", { status: 404 }));
    const res = await hit(env);
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("is reachable: no static asset shadows the path", () => {
    // Static assets are matched before the Worker. The route only runs
    // because nothing is shipped at /email/… — keep it that way.
    expect(existsSync(resolve(WORKER, "public", EMAIL_LOGO_PATH.slice(1)))).toBe(false);
    expect(existsSync(resolve(WORKER, "../averrow-marketing/public/email"))).toBe(false);
    expect(existsSync(resolve(WORKER, "../averrow-marketing/src/pages/email"))).toBe(false);
    // The file it re-serves does ship (ops public/ → public/v2/).
    expect(existsSync(resolve(WORKER, "../averrow-ops/public/email/averrow-mark-r3.png"))).toBe(true);
  });
});
