// Router-level check: POST /api/briefings/generate ("Run Briefing Now") is
// admin-only (owner decision). It writes a threat_briefings row and emails
// the briefing recipient, so the level-3 staff sub-roles and the read-only
// auditor seat must be refused at the route guard, before the handler runs.
// The read side (GET /api/briefings/latest) stays on requireStaff.
//
// Harness matches test/audit-routes-permission.test.ts: the briefing
// handlers are stubbed so a request that gets past the guard returns a
// sentinel 200 without touching D1 or email. The guard runs for real
// against a signed JWT.

import { describe, it, expect, vi } from "vitest";
import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import { registerThreatRoutes } from "../src/routes/threats";
import { signJWT } from "../src/lib/jwt";
import type { Env, UserRole } from "../src/types";

const handlerCalls = vi.hoisted(() => ({ generate: 0, latest: 0, history: 0 }));

vi.mock("../src/handlers/briefing", () => {
  const sentinel = (): Response =>
    new Response(JSON.stringify({ success: true, data: "handler-reached" }), { status: 200 });
  return {
    handleGenerateBriefing: async (): Promise<Response> => {
      handlerCalls.generate++;
      return sentinel();
    },
    handleLatestBriefing: async (): Promise<Response> => {
      handlerCalls.latest++;
      return sentinel();
    },
    handleListBriefingHistory: async (): Promise<Response> => {
      handlerCalls.history++;
      return sentinel();
    },
  };
});

const SECRET = "test-secret-briefing-generate-admin-gate";

// requireAuth reads `SELECT status FROM users` (must be active) and the
// forced-logout KV key (must be null). The rate limiter reads/writes the
// same CACHE stub (get → null keeps the counter at 0). Both pass so only
// the role check is under test.
function makeEnv(): Env {
  const db = {
    prepare() {
      return {
        bind() {
          return {
            async first<T>() {
              return { status: "active" } as unknown as T;
            },
            async run() {
              return { success: true };
            },
          };
        },
      };
    },
  };
  const cache = {
    async get() {
      return null;
    },
    async put() {},
  };
  return { JWT_SECRET: SECRET, DB: db, CACHE: cache } as unknown as Env;
}

async function requestAs(role: UserRole | null, method: "GET" | "POST", path: string): Promise<Request> {
  const headers: Record<string, string> = {};
  if (role) {
    const token = await signJWT(
      { sub: `user_${role}`, email: `${role}@averrow.local`, role },
      SECRET,
      300,
    );
    headers.Authorization = `Bearer ${token}`;
  }
  return new Request(`https://averrow.com${path}`, { method, headers });
}

function buildRouter(): RouterType<IRequest> {
  const router = Router();
  registerThreatRoutes(router);
  return router;
}

const GENERATE = "/api/briefings/generate";
const ALLOWED: UserRole[] = ["super_admin", "admin"];
const DENIED: UserRole[] = ["analyst", "sales", "support", "billing", "auditor", "client"];
const STAFF: UserRole[] = ["super_admin", "admin", "analyst", "sales", "support", "billing", "auditor"];

describe("POST /api/briefings/generate — admin-only", () => {
  it("no token gets 401 and the handler never runs", async () => {
    handlerCalls.generate = 0;
    const res = (await buildRouter().fetch(await requestAs(null, "POST", GENERATE), makeEnv())) as Response;
    expect(res.status).toBe(401);
    expect(handlerCalls.generate).toBe(0);
  });

  for (const role of DENIED) {
    it(`${role} gets 403 and the handler never runs`, async () => {
      handlerCalls.generate = 0;
      const res = (await buildRouter().fetch(await requestAs(role, "POST", GENERATE), makeEnv())) as Response;
      expect(res.status).toBe(403);
      const body = await res.json<{ success: boolean; error: string }>();
      expect(body.success).toBe(false);
      expect(handlerCalls.generate).toBe(0);
    });
  }

  for (const role of ALLOWED) {
    it(`${role} reaches the handler`, async () => {
      handlerCalls.generate = 0;
      const res = (await buildRouter().fetch(await requestAs(role, "POST", GENERATE), makeEnv())) as Response;
      expect(res.status).toBe(200);
      const body = await res.json<{ success: boolean; data: string }>();
      expect(body.data).toBe("handler-reached");
      expect(handlerCalls.generate).toBe(1);
    });
  }
});

describe("briefing reads stay staff-readable", () => {
  for (const [path, key] of [
    ["/api/briefings/latest", "latest"],
    ["/api/briefings/history", "history"],
  ] as const) {
    for (const role of STAFF) {
      it(`GET ${path}: ${role} reaches the handler`, async () => {
        handlerCalls[key] = 0;
        const res = (await buildRouter().fetch(await requestAs(role, "GET", path), makeEnv())) as Response;
        expect(res.status).toBe(200);
        const body = await res.json<{ success: boolean; data: string }>();
        expect(body.data).toBe("handler-reached");
        expect(handlerCalls[key]).toBe(1);
      });
    }

    it(`GET ${path}: client gets 403 and the handler never runs`, async () => {
      handlerCalls[key] = 0;
      const res = (await buildRouter().fetch(await requestAs("client", "GET", path), makeEnv())) as Response;
      expect(res.status).toBe(403);
      expect(handlerCalls[key]).toBe(0);
    });
  }
});
