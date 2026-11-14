/**
 * Hosted DMARC reporting — the two new staff read routes keep the sibling
 * routes' requireStaff guard (client → 403, staff reach the handler), and
 * the Worker's email() handler routes the RUA addresses (any case) to the
 * DMARC receiver while every other local part goes where it went before.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, DurableObject: class {}, WorkerEntrypoint: class {} }));
vi.mock("cloudflare:workflows", () => ({ NonRetryableError: class extends Error {} }));

const { reached, dmarcCalls, trapCalls, abuseCalls } = vi.hoisted(() => ({
  reached: async (): Promise<Response> =>
    new Response(JSON.stringify({ success: true, data: "handler-reached" }), { status: 200 }),
  dmarcCalls: [] as string[],
  trapCalls: [] as string[],
  abuseCalls: [] as string[],
}));
vi.mock("../src/handlers/dmarcReports", () => ({
  handleGetDmarcOverview: reached,
  handleGetDmarcReports: reached,
  handleGetDmarcStats: reached,
  handleGetDmarcSources: reached,
  handleGetDmarcSetup: reached,
  handleGetDmarcSpoofSources: reached,
}));

vi.mock("../src/dmarc-receiver", () => ({
  handleDmarcEmail: async (m: { to: string }) => {
    dmarcCalls.push(m.to);
    return { status: "dropped", reason: "unparseable" };
  },
}));
vi.mock("../src/spam-trap", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  handleSpamTrapEmail: async (m: { to: string }) => {
    trapCalls.push(m.to);
  },
}));
vi.mock("../src/handlers/abuseMailboxEmail", () => ({
  handleAbuseMailboxEmail: async (m: { to: string }) => {
    abuseCalls.push(m.to);
  },
}));

import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import { registerEmailSecurityRoutes } from "../src/routes/email-security";
import { signJWT } from "../src/lib/jwt";
import worker from "../src/index";
import type { Env, UserRole } from "../src/types";

const SECRET = "test-secret-dmarc-sensor-routes";

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
  const cache = { async get() { return null; }, async put() {} };
  return { JWT_SECRET: SECRET, DB: db, CACHE: cache } as unknown as Env;
}

async function getAs(role: UserRole, path: string): Promise<Request> {
  const token = await signJWT({ sub: `user_${role}`, email: `${role}@averrow.local`, role }, SECRET, 300);
  return new Request(`https://averrow.com${path}`, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
}

function buildRouter(): RouterType<IRequest> {
  const router = Router();
  registerEmailSecurityRoutes(router);
  return router;
}

const PATHS = [
  "/api/dmarc-reports/brand_x/setup",
  "/api/dmarc-reports/brand_x/spoof-sources?days=7",
];

describe("DMARC sensor routes — staff-only", () => {
  for (const path of PATHS) {
    it(`GET ${path} — client gets 403`, async () => {
      const res = (await buildRouter().fetch(await getAs("client", path), makeEnv())) as Response;
      expect(res.status).toBe(403);
    });
    for (const role of ["analyst", "auditor", "super_admin"] as UserRole[]) {
      it(`GET ${path} — ${role} reaches the handler`, async () => {
        const res = (await buildRouter().fetch(await getAs(role, path), makeEnv())) as Response;
        expect(res.status).toBe(200);
        expect(((await res.json()) as { data: string }).data).toBe("handler-reached");
      });
    }
    it(`GET ${path} — missing token gets 401`, async () => {
      const res = (await buildRouter().fetch(new Request(`https://averrow.com${path}`), makeEnv())) as Response;
      expect(res.status).toBe(401);
    });
  }
});

describe("email() routing", () => {
  beforeEach(() => {
    dmarcCalls.length = 0;
    trapCalls.length = 0;
    abuseCalls.length = 0;
  });

  async function deliver(to: string): Promise<void> {
    const pending: Array<Promise<unknown>> = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext;
    const message = {
      from: "sender@example.net", to, headers: new Headers(),
      raw: new Blob(["x"]).stream() as ReadableStream<Uint8Array>, rawSize: 1,
      setReject: () => { throw new Error("must not reject"); },
      forward: async () => {},
    };
    await worker.email(message, {} as Env, ctx);
    await Promise.all(pending);
  }

  it("routes every RUA address, any case, to the DMARC receiver", async () => {
    for (const to of ["dmarc_rua@averrow.ca", "DMARC_RUA@Averrow.CA", "dmarc_rua@trustradar.ca", "dmarc_rua@averrow.com"]) {
      await deliver(to);
    }
    expect(dmarcCalls).toHaveLength(4);
    expect(trapCalls).toEqual([]);
  });

  it("leaves every other local part where it was", async () => {
    await deliver("abuse@averrow.ca");
    await deliver("report-acme@averrow.ca");
    await deliver("hannah.bennett@trustradar.ca");
    await deliver("dmarc_rua@lrxradar.com");
    expect(dmarcCalls).toEqual([]);
    expect(abuseCalls).toEqual(["abuse@averrow.ca", "report-acme@averrow.ca"]);
    expect(trapCalls).toEqual(["hannah.bennett@trustradar.ca", "dmarc_rua@lrxradar.com"]);
  });
});
