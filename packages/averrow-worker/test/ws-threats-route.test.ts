// Appsec pin: `/ws/threats` used to upgrade straight into the
// ThreatPushHub Durable Object with no authentication. Nothing ever
// connected to it (no ops/tenant/marketing/legacy client) and nothing ever
// broadcast through the hub, so the route was removed rather than guarded.
//
// Two layers:
//   1. Behavioural — drive the real public router (registerPublicRoutes,
//      including its catch-all) with an unauthenticated WebSocket upgrade
//      and assert it 404s without ever touching the THREAT_PUSH_HUB binding.
//   2. Static — no route file may re-mount a `/ws/...` path without a staff
//      auth guard. If live push is ever wired, the route must come back
//      behind requireStaff/requireAdmin (and this pin updated deliberately).

import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Router } from "itty-router";
import type { IRequest, RouterType } from "itty-router";
import { registerPublicRoutes } from "../src/routes/public";
import type { Env } from "../src/types";

function makeEnv() {
  const hubGet = vi.fn(() => {
    throw new Error("THREAT_PUSH_HUB must not be reached from /ws/threats");
  });
  const hubIdFromName = vi.fn(() => {
    throw new Error("THREAT_PUSH_HUB must not be reached from /ws/threats");
  });
  const env = {
    // Static-asset binding: no file at /ws/threats, so 404 like prod.
    ASSETS: { fetch: vi.fn(async () => new Response("not found", { status: 404 })) },
    THREAT_PUSH_HUB: { get: hubGet, idFromName: hubIdFromName },
  } as unknown as Env;
  return { env, hubGet, hubIdFromName };
}

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

describe("/ws/threats — unauthenticated WebSocket upgrade", () => {
  it("is not routed: an anonymous upgrade gets 404 and never reaches the Durable Object", async () => {
    const router: RouterType<IRequest> = Router();
    registerPublicRoutes(router);
    const { env, hubGet, hubIdFromName } = makeEnv();

    const res = (await router.fetch(
      new Request("https://averrow.com/ws/threats", {
        headers: { Upgrade: "websocket", Connection: "Upgrade" },
      }),
      env,
      ctx,
    )) as Response;

    expect(res.status).toBe(404);
    expect(res.status).not.toBe(101);
    expect(hubIdFromName).not.toHaveBeenCalled();
    expect(hubGet).not.toHaveBeenCalled();
  });

  it("the internal /broadcast sub-path is not reachable either", async () => {
    const router: RouterType<IRequest> = Router();
    registerPublicRoutes(router);
    const { env, hubGet } = makeEnv();

    const res = (await router.fetch(
      new Request("https://averrow.com/ws/threats/broadcast", {
        method: "POST",
        body: JSON.stringify({ type: "threat_new", payload: {} }),
      }),
      env,
      ctx,
    )) as Response;

    expect(res.status).toBe(404);
    expect(hubGet).not.toHaveBeenCalled();
  });
});

describe("/ws/* routes — static pin", () => {
  const routesDir = resolve(__dirname, "../src/routes");
  const files = readdirSync(routesDir).filter((f) => f.endsWith(".ts"));
  const WS_ROUTE_RE = /router\.(get|all|post)\s*\(\s*["'](\/ws\/[^"']*)["']/g;
  const GUARD_RE = /\brequire(Staff|StaffMutation|Admin|SuperAdmin)\s*\(/;

  it("no route file mounts a /ws/* path without a staff guard", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(resolve(routesDir, file), "utf-8");
      for (const m of src.matchAll(WS_ROUTE_RE)) {
        // Inspect the registration line plus the handler's opening lines.
        const start = m.index ?? 0;
        const window = src.slice(start, start + 400);
        if (!GUARD_RE.test(window)) offenders.push(`${file}: ${m[1]!.toUpperCase()} ${m[2]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
