import { describe, it, expect, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, DurableObject: class {}, WorkerEntrypoint: class {} }));
vi.mock("cloudflare:workflows", () => ({ NonRetryableError: class extends Error {} }));

import worker from "../src/index";
import { hasSqlite, openMigratedDb, d1FromSqlite, fakeKv } from "./sqlite-d1-harness";
import { insertThreats } from "./nexus-fixtures";
import type { Env } from "../src/types";

const SECRET = "test-internal-secret";
const PATH = "/api/internal/nexus/cluster-retirement";
const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function makeEnv() {
  const raw = openMigratedDb();
  raw.prepare(
    `INSERT INTO infrastructure_clusters (id, cluster_name, asns, attack_types, status)
     VALUES ('88888888-0000-4000-8000-000000000008', 'n', '["AS13335"]', '["phishing"]', 'superseded')`,
  ).run();
  insertThreats(raw, [{ id: "r1", cluster_id: "88888888-0000-4000-8000-000000000008" }]);
  const env = { AVERROW_INTERNAL_SECRET: SECRET, DB: d1FromSqlite(raw), CACHE: fakeKv() } as unknown as Env;
  return { raw, env };
}

const call = (path: string, env: Env, method: string, auth: string | null = `Bearer ${SECRET}`) => {
  const headers = new Headers();
  if (auth !== null) headers.set("Authorization", auth);
  return worker.fetch(new Request(`https://averrow.com${path}`, { method, headers }), env, execCtx);
};

describe.skipIf(!hasSqlite())(`${PATH}`, () => {
  it("401 without / with a wrong secret", async () => {
    const { env } = makeEnv();
    expect((await call(PATH, env, "GET", null)).status).toBe(401);
    expect((await call(PATH, env, "POST", "Bearer nope")).status).toBe(401);
  }, 60_000);

  it("GET returns the dry-run report", async () => {
    const { env } = makeEnv();
    const res = await call(PATH, env, "GET");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { legacy_threat_refs: { threats: number } } };
    expect(body.success).toBe(true);
    expect(body.data.legacy_threat_refs.threats).toBe(1);
  }, 60_000);

  it("POST is a dry run by default; dry_run=0 applies", async () => {
    const { raw, env } = makeEnv();
    const stamp = () => (raw.prepare("SELECT cluster_id FROM threats WHERE id = 'r1'").all()[0] as { cluster_id: string | null }).cluster_id;
    const dry = (await (await call(PATH, env, "POST")).json()) as { data: { dry_run: boolean } };
    expect(dry.data.dry_run).toBe(true);
    expect(stamp()).toBe("88888888-0000-4000-8000-000000000008");
    const applied = (await (await call(`${PATH}?dry_run=0`, env, "POST")).json()) as { data: { dry_run: boolean; done: boolean } };
    expect(applied.data).toMatchObject({ dry_run: false, done: true });
    expect(stamp()).toBeNull();
  }, 60_000);
});
