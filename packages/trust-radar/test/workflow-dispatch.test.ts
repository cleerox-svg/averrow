import { describe, it, expect, beforeEach } from "vitest";
import {
  dispatchWorkflow,
  getCooldownUntil,
  getLastDispatchAt,
  DEFAULT_WORKFLOW_COOLDOWN_SEC,
} from "../src/lib/workflow-dispatch";

class FakeKV {
  store = new Map<string, string>();
  ttls = new Map<string, number>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(
    key: string,
    value: string,
    opts?: { expirationTtl?: number },
  ): Promise<void> {
    this.store.set(key, value);
    if (opts?.expirationTtl !== undefined) this.ttls.set(key, opts.expirationTtl);
  }
}

class FakeDB {
  inserts: Array<{ agent_id: string; event_type: string; severity: string; message: string }> = [];
  prepare(_sql: string) {
    const inserts = this.inserts;
    return {
      bind: (
        _id: string,
        agent_id: string,
        event_type: string,
        message: string,
        _metadata: string,
        severity: string,
      ) => ({
        run: async () => {
          inserts.push({ agent_id, event_type, severity, message });
          return { success: true, meta: {}, results: [] };
        },
      }),
    };
  }
}

class FakeWorkflowOK {
  async create(args: { id?: string; params: Record<string, unknown> }): Promise<{ id: string }> {
    return { id: args.id ?? "wf_inst_abc" };
  }
}

class FakeWorkflowPlatformError {
  async create(): Promise<{ id: string }> {
    throw new Error("WorkflowInternalError: Attempt failed due to internal workflows error");
  }
}

class FakeWorkflowGenericError {
  async create(): Promise<{ id: string }> {
    throw new Error("ENOTFOUND something else entirely");
  }
}

function makeEnv() {
  return {
    CACHE: new FakeKV() as unknown as KVNamespace,
    DB: new FakeDB() as unknown as D1Database,
    _cache: undefined as unknown as FakeKV,
    _db: undefined as unknown as FakeDB,
  };
}

function withInternals(env: ReturnType<typeof makeEnv>) {
  // Re-cast to access the underlying fakes for assertions.
  return {
    env,
    cache: env.CACHE as unknown as FakeKV,
    db: env.DB as unknown as FakeDB,
  };
}

describe("dispatchWorkflow", () => {
  let envBundle: ReturnType<typeof withInternals>;
  beforeEach(() => {
    envBundle = withInternals(makeEnv());
  });

  it("dispatches successfully and stamps last-dispatch KV", async () => {
    const result = await dispatchWorkflow(envBundle.env, {
      workflow: new FakeWorkflowOK() as unknown as Workflow,
      workflowName: "nexus-run",
      agentId: "nexus",
    });
    expect(result.kind).toBe("dispatched");
    if (result.kind !== "dispatched") return;
    expect(result.instance_id).toBe("wf_inst_abc");

    const last = await getLastDispatchAt(envBundle.env.CACHE, "nexus-run");
    expect(last).not.toBeNull();

    const cooldown = await getCooldownUntil(envBundle.env.CACHE, "nexus-run");
    expect(cooldown).toBeNull();

    const dispatchedLog = envBundle.db.inserts.find((r) => r.event_type === "workflow_dispatched");
    expect(dispatchedLog).toBeDefined();
    expect(dispatchedLog?.severity).toBe("info");
  });

  it("sets cooldown on WorkflowInternalError", async () => {
    const result = await dispatchWorkflow(envBundle.env, {
      workflow: new FakeWorkflowPlatformError() as unknown as Workflow,
      workflowName: "nexus-run",
      agentId: "nexus",
    });
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.cooldown_set).toBe(true);

    const cooldownUntil = await getCooldownUntil(envBundle.env.CACHE, "nexus-run");
    expect(cooldownUntil).not.toBeNull();
    // Cooldown should land within +/- 5 sec of (now + DEFAULT TTL).
    const expectedMs = Date.now() + DEFAULT_WORKFLOW_COOLDOWN_SEC * 1000;
    const diffMs = Math.abs((cooldownUntil!.getTime()) - expectedMs);
    expect(diffMs).toBeLessThan(5000);

    const log = envBundle.db.inserts.find((r) => r.event_type === "workflow_dispatch_failed");
    expect(log).toBeDefined();
    expect(log?.severity).toBe("warning");
  });

  it("does NOT set cooldown on generic errors", async () => {
    const result = await dispatchWorkflow(envBundle.env, {
      workflow: new FakeWorkflowGenericError() as unknown as Workflow,
      workflowName: "nexus-run",
      agentId: "nexus",
    });
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.cooldown_set).toBe(false);

    const cooldownUntil = await getCooldownUntil(envBundle.env.CACHE, "nexus-run");
    expect(cooldownUntil).toBeNull();

    const log = envBundle.db.inserts.find((r) => r.event_type === "workflow_dispatch_failed");
    expect(log?.severity).toBe("critical");
  });

  it("skips dispatch while cooldown is active", async () => {
    // First call sets cooldown via platform error.
    await dispatchWorkflow(envBundle.env, {
      workflow: new FakeWorkflowPlatformError() as unknown as Workflow,
      workflowName: "nexus-run",
      agentId: "nexus",
    });

    // Second call uses a healthy workflow but cooldown should block it.
    const result = await dispatchWorkflow(envBundle.env, {
      workflow: new FakeWorkflowOK() as unknown as Workflow,
      workflowName: "nexus-run",
      agentId: "nexus",
    });
    expect(result.kind).toBe("cooldown");
    if (result.kind !== "cooldown") return;
    expect(result.cooldown_remaining_sec).toBeGreaterThan(0);
    expect(result.cooldown_remaining_sec).toBeLessThanOrEqual(DEFAULT_WORKFLOW_COOLDOWN_SEC);

    const skipLog = envBundle.db.inserts.find((r) => r.event_type === "workflow_cooldown_skip");
    expect(skipLog).toBeDefined();
  });

  it("isolates cooldown per workflow name", async () => {
    await dispatchWorkflow(envBundle.env, {
      workflow: new FakeWorkflowPlatformError() as unknown as Workflow,
      workflowName: "nexus-run",
      agentId: "nexus",
    });

    // cartographer-backfill should still dispatch — different KV key.
    const result = await dispatchWorkflow(envBundle.env, {
      workflow: new FakeWorkflowOK() as unknown as Workflow,
      workflowName: "cartographer-backfill",
      agentId: "cartographer",
    });
    expect(result.kind).toBe("dispatched");
  });

  it("forwards explicit dispatch id when provided", async () => {
    const result = await dispatchWorkflow(envBundle.env, {
      workflow: new FakeWorkflowOK() as unknown as Workflow,
      workflowName: "nexus-run",
      agentId: "nexus",
      id: "custom-id-123",
    });
    expect(result.kind).toBe("dispatched");
    if (result.kind !== "dispatched") return;
    expect(result.instance_id).toBe("custom-id-123");
  });
});
