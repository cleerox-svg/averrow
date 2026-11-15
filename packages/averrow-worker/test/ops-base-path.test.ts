// The staff SPA moved from /v2 to /ops as a day-one HARD CUT (owner decision
// 2026-11-15): /ops/* serves the shell exactly as /v2/* used to, /v2 and /v2/*
// are a plain 404 (no redirect, no stub), and every static file that cannot
// import the constant is pinned to it here.

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Router } from "itty-router";
import type { IRequest, RouterType } from "itty-router";
import { registerPublicRoutes } from "../src/routes/public";
import { OPS_BASE, OPS_HOME, RETIRED_OPS_BASE, opsUrl } from "../src/lib/app-paths";
import type { Env } from "../src/types";

const WORKER = resolve(__dirname, "..");
const OPS_PKG = resolve(WORKER, "../averrow-ops");
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

const SHELL = "<!doctype html><html><body>ops shell</body></html>";

/** ASSETS that has the built ops app only (index.html + one hashed asset). */
function makeEnv() {
  const fetch = vi.fn(async (req: Request) => {
    const p = new URL(req.url).pathname;
    if (p === "/ops/index.html") return new Response(SHELL, { status: 200, headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=0, must-revalidate" } });
    if (p === "/ops/assets/index-ABC.js") return new Response("console.log(1)", { status: 200, headers: { "Content-Type": "text/javascript" } });
    if (p === "/ops/sw.js") return new Response("// sw", { status: 200, headers: { "Content-Type": "text/javascript" } });
    // A stale deployment could still hold these; the Worker must not serve them.
    if (p.startsWith("/v2/")) return new Response("STALE V2", { status: 200 });
    return new Response("nope", { status: 404 });
  });
  return { env: { ASSETS: { fetch } } as unknown as Env, fetch };
}

async function get(path: string, env: Env, method = "GET"): Promise<Response> {
  const router: RouterType<IRequest> = Router();
  registerPublicRoutes(router);
  return (await router.fetch(new Request(`https://averrow.com${path}`, { method }), env, ctx)) as Response;
}

describe("constants", () => {
  it("OPS_BASE is /ops and OPS_HOME has the trailing slash", () => {
    expect(OPS_BASE).toBe("/ops");
    expect(OPS_HOME).toBe("/ops/");
    expect(RETIRED_OPS_BASE).toBe("/v2");
    expect(opsUrl("https://averrow.com", "/admin")).toBe("https://averrow.com/ops/admin");
    expect(opsUrl("https://averrow.com/", "admin")).toBe("https://averrow.com/ops/admin");
  });
});

describe("/ops serves the staff shell", () => {
  it.each(["/ops/", "/ops/deep/link", "/ops/brands/abc?tab=x", "/ops/login"])("%s -> shell, no-cache", async (p) => {
    const { env } = makeEnv();
    const res = await get(p, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SHELL);
    expect(res.headers.get("Cache-Control")).toBe("no-cache, no-store, must-revalidate");
    expect(res.headers.get("Pragma")).toBe("no-cache");
    expect(res.headers.get("Expires")).toBe("0");
  });

  it("a real file under /ops is served as the file", async () => {
    const { env } = makeEnv();
    const js = await get("/ops/assets/index-ABC.js", env);
    expect(js.status).toBe(200);
    expect(await js.text()).toBe("console.log(1)");
    const sw = await get("/ops/sw.js", env);
    expect(await sw.text()).toBe("// sw");
  });

  it("bare /ops goes to /ops/", async () => {
    const { env } = makeEnv();
    const res = await get("/ops", env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://averrow.com/ops/");
  });
});

describe("/v2 is retired: plain 404, never the shell, never a stale file", () => {
  it.each(["/v2", "/v2/", "/v2/anything", "/v2/brands/x", "/v2/sw.js", "/v2/manifest.json", "/v2/assets/index-ABC.js", "/v2/index.html"])("GET %s -> 404", async (p) => {
    const { env, fetch } = makeEnv();
    const res = await get(p, env);
    expect(res.status).toBe(404);
    expect(res.headers.get("Location")).toBeNull();
    expect(await res.text()).toBe("Not found");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    // Never even asked the asset layer.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("other methods 404 too", async () => {
    const { env } = makeEnv();
    expect((await get("/v2/x", env, "POST")).status).toBe(404);
    expect((await get("/v2/x", env, "HEAD")).status).toBe(404);
  });
});

describe("redirects into the app point at /ops", () => {
  it("/login -> /ops/login", async () => {
    const { env } = makeEnv();
    const res = await get("/login", env);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://averrow.com/ops/login");
  });
});

// The pre-React app was deleted on 2026-11-15 (owner decision; screenshots in
// docs/history/legacy-app/). Its URLs are plain 404s now: no redirect table,
// no /legacy page. /login stays (above); marketing pages are untouched.
describe("deleted legacy app paths", () => {
  it.each([
    "/legacy", "/observatory", "/brands", "/admin", "/admin/users", "/admin/feeds",
    "/dashboard.html", "/app.js", "/styles.css", "/manifest.json",
  ])("%s -> 404, no redirect into the app", async (p) => {
    const { env } = makeEnv();
    const res = await get(p, env);
    expect(res.status).toBe(404);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("/security (a marketing page served by ASSETS) is unaffected", async () => {
    const fetch = vi.fn(async (req: Request) =>
      new URL(req.url).pathname === "/security"
        ? new Response("<html>security</html>", { status: 200, headers: { "Content-Type": "text/html" } })
        : new Response("nope", { status: 404 }));
    const env = { ASSETS: { fetch } } as unknown as Env;
    const res = await get("/security", env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>security</html>");
  });
});

describe("static files that can't import the constant are pinned to it", () => {
  const read = (p: string) => readFileSync(p, "utf8");

  it("manifest.json id/start_url/scope = /ops/ and every icon is under /ops/", () => {
    const m = JSON.parse(read(resolve(OPS_PKG, "public/manifest.json")));
    expect(m.id).toBe(OPS_HOME);
    expect(m.start_url).toBe(OPS_HOME);
    expect(m.scope).toBe(OPS_HOME);
    for (const i of m.icons) expect(i.src.startsWith(`${OPS_BASE}/`)).toBe(true);
  });

  it("sw.js is scoped to /ops/ and mentions /v2 only in the legacy payload mapping", () => {
    const sw = read(resolve(OPS_PKG, "public/sw.js"));
    expect(sw).toContain("'/ops/index.html'");
    expect(sw).toContain("startsWith('/ops/assets/')");
    expect(sw).toContain("function opsPath");
    const v2Lines = sw.split("\n").filter((l) => l.includes("/v2"));
    expect(v2Lines.length).toBeLessThanOrEqual(2);
    expect(v2Lines.join("\n")).toMatch(/path === '\/v2'/);
  });

  it("index.html icon + manifest links, and public/_headers rules, use /ops", () => {
    const html = read(resolve(OPS_PKG, "index.html"));
    expect(html).toContain(`href="${OPS_BASE}/manifest.json"`);
    expect(html).toContain(`href="${OPS_BASE}/favicon.svg"`);
    expect(html).not.toMatch(/href="\/v2/);
    const headers = read(resolve(WORKER, "public/_headers"));
    expect(headers).toMatch(/^\/ops\/assets\/\*$/m);
    expect(headers).toMatch(/^\/ops\/email\/\*$/m);
    expect(headers).not.toMatch(/^\/v2\//m);
  });

  it("vite builds to base /ops/ into public/ops (and never public/v2)", () => {
    const cfg = read(resolve(OPS_PKG, "vite.config.ts"));
    expect(cfg).toContain("OPS_BASE_PATH");
    expect(cfg).not.toContain("/v2");
    const base = read(resolve(OPS_PKG, "src/lib/basePath.ts"));
    expect(base).toContain("export const OPS_BASE_PATH = '/ops';");
  });

  it("robots.txt disallows /ops/ and no longer mentions /v2", async () => {
    const { renderRobotsTxt } = await import("../src/templates/robots-sitemap");
    const txt = renderRobotsTxt();
    expect(txt).toContain("Disallow: /ops/");
    expect(txt).not.toContain("/v2");
  });
});
