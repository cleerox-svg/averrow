import { describe, it, expect, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, DurableObject: class {}, WorkerEntrypoint: class {} }));
vi.mock("cloudflare:workflows", () => ({ NonRetryableError: class extends Error {} }));

import worker from "../src/index";
import { hasSqlite, openMigratedDb, d1FromSqlite, fakeKv } from "./sqlite-d1-harness";
import type { Env } from "../src/types";

const SECRET = "test-internal-secret";
const PATH = "/api/internal/cubes/backfill";
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function makeEnv() {
  const raw = openMigratedDb();
  // Capturing AUDIT_DB: records each audit_log INSERT's binds.
  const audits: unknown[][] = [];
  const auditDb = {
    prepare: (sql: string) => ({
      bind: (...binds: unknown[]) => ({
        run: async () => { if (/INSERT INTO audit_log/.test(sql)) audits.push(binds); return { meta: { changes: 1 } }; },
      }),
    }),
  };
  const env = { AVERROW_INTERNAL_SECRET: SECRET, DB: d1FromSqlite(raw), AUDIT_DB: auditDb, CACHE: fakeKv() } as unknown as Env;
  return { raw, env, audits };
}

const call = (path: string, env: Env, auth: string | null = `Bearer ${SECRET}`) => {
  const headers = new Headers();
  if (auth !== null) headers.set("Authorization", auth);
  return worker.fetch(new Request(`https://averrow.com${path}`, { method: "POST", headers }), env, execCtx);
};

const ndjson = async (res: Response): Promise<Array<Record<string, unknown>>> =>
  (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

describe.skipIf(!hasSqlite())(`${PATH}`, () => {
  it("401 without / with a wrong secret, and writes no audit row", async () => {
    const { env, audits } = makeEnv();
    expect((await call(`${PATH}?cube=all&days=1&dry_run=true`, env, null)).status).toBe(401);
    expect((await call(`${PATH}?cube=all&days=1&dry_run=true`, env, "Bearer nope")).status).toBe(401);
    expect(audits).toHaveLength(0);
  }, 60_000);

  it("delegates to handleCubeBackfill: dry_run streams per-hour NDJSON + summary, writes no cube rows, audits once", async () => {
    const { raw, env, audits } = makeEnv();
    const res = await call(`${PATH}?cube=all&days=1&dry_run=true`, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/x-ndjson");
    const lines = await ndjson(res);
    const hours = lines.filter((l) => "hour" in l);
    expect(hours).toHaveLength(24);
    expect(hours.every((l) => l.dry_run === true && l.error === null)).toBe(true);
    expect(lines[lines.length - 1]).toMatchObject({
      done: true, total_hours: 24, resume_from: null, dry_run: true, cube: "all", window_days: 1,
    });
    const n = (raw.prepare("SELECT COUNT(*) AS n FROM threat_cube_geo").all()[0] as { n: number }).n;
    expect(n).toBe(0);

    expect(audits).toHaveLength(1);
    // (id, user_id, action, resource_type, resource_id, details, ip, ua, outcome)
    const [, userId, action, resourceType, , details, , , outcome] = audits[0]!;
    expect(userId).toBeNull();
    expect(action).toBe("cube_backfill.internal");
    expect(resourceType).toBe("threat_cubes");
    expect(outcome).toBe("success");
    expect(JSON.parse(details as string)).toEqual({
      actor: "internal", cube: "all", days: "1", dry_run: true, resume_from: null,
    });
  }, 60_000);

  it("resume_from past the window processes nothing and is recorded in the audit row", async () => {
    const { env, audits } = makeEnv();
    const resume = "2999-01-01 00:00:00";
    const lines = await ndjson(await call(`${PATH}?cube=geo&days=1&dry_run=true&resume_from=${encodeURIComponent(resume)}`, env));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ done: true, total_hours: 0, cube: "geo" });
    expect(JSON.parse(audits[0]![5] as string)).toMatchObject({ cube: "geo", resume_from: resume });
  }, 60_000);

  it("invalid cube → handler's 400, audited as failure", async () => {
    const { env, audits } = makeEnv();
    const res = await call(`${PATH}?cube=nope`, env);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { success: boolean }).success).toBe(false);
    expect(audits).toHaveLength(1);
    expect(audits[0]![8]).toBe("failure");
    expect(JSON.parse(audits[0]![5] as string)).toMatchObject({ cube: "nope", dry_run: false });
  }, 60_000);
});
