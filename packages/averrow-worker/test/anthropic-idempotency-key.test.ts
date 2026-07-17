import { describe, it, expect } from "vitest";
import { computeIdempotencyKey } from "../src/lib/anthropic";

const BASE_OPTS = {
  agentId: "cartographer",
  runId: "run_abc",
  model: "claude-haiku-4-5-20251001",
  system: "Score this hosting provider.",
  messages: [{ role: "user" as const, content: "Provider: AS4837 China Unicom" }],
  maxTokens: 256,
};

describe("computeIdempotencyKey", () => {
  it("produces a 16-char hex string", async () => {
    const key = await computeIdempotencyKey(BASE_OPTS);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic — same input yields same key", async () => {
    const a = await computeIdempotencyKey(BASE_OPTS);
    const b = await computeIdempotencyKey(BASE_OPTS);
    expect(a).toBe(b);
  });

  it("changes when agentId differs", async () => {
    const a = await computeIdempotencyKey(BASE_OPTS);
    const b = await computeIdempotencyKey({ ...BASE_OPTS, agentId: "sentinel" });
    expect(a).not.toBe(b);
  });

  it("changes when runId differs", async () => {
    const a = await computeIdempotencyKey(BASE_OPTS);
    const b = await computeIdempotencyKey({ ...BASE_OPTS, runId: "run_xyz" });
    expect(a).not.toBe(b);
  });

  it("changes when model differs", async () => {
    const a = await computeIdempotencyKey(BASE_OPTS);
    const b = await computeIdempotencyKey({ ...BASE_OPTS, model: "claude-sonnet-4-6" });
    expect(a).not.toBe(b);
  });

  it("changes when system prompt differs", async () => {
    const a = await computeIdempotencyKey(BASE_OPTS);
    const b = await computeIdempotencyKey({ ...BASE_OPTS, system: "Different system." });
    expect(a).not.toBe(b);
  });

  it("changes when messages content differs", async () => {
    const a = await computeIdempotencyKey(BASE_OPTS);
    const b = await computeIdempotencyKey({
      ...BASE_OPTS,
      messages: [{ role: "user", content: "Provider: AS13335 Cloudflare" }],
    });
    expect(a).not.toBe(b);
  });

  it("changes when maxTokens differs", async () => {
    const a = await computeIdempotencyKey(BASE_OPTS);
    const b = await computeIdempotencyKey({ ...BASE_OPTS, maxTokens: 512 });
    expect(a).not.toBe(b);
  });

  it("null runId yields stable key (different from undefined would also be stable)", async () => {
    const a = await computeIdempotencyKey({ ...BASE_OPTS, runId: null });
    const b = await computeIdempotencyKey({ ...BASE_OPTS, runId: null });
    expect(a).toBe(b);
  });

  it("retry of the same logical call (e.g. workflow step.do retry) produces same key", async () => {
    // Simulate: workflow attempt 1 + attempt 2 build the same opts object.
    const attempt1 = await computeIdempotencyKey(BASE_OPTS);
    // Fresh object literal, same shape — what a retry would produce.
    const attempt2 = await computeIdempotencyKey({
      agentId: "cartographer",
      runId: "run_abc",
      model: "claude-haiku-4-5-20251001",
      system: "Score this hosting provider.",
      messages: [{ role: "user", content: "Provider: AS4837 China Unicom" }],
      maxTokens: 256,
    });
    expect(attempt1).toBe(attempt2);
  });
});
