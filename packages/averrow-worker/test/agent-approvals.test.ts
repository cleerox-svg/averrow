/**
 * Phase 5.4a — agent_approvals lib tests.
 *
 * Verifies the lifecycle: createPending → approve | reject |
 * requestChanges → readback. Uses an in-memory map fake to simulate
 * the agent_approvals table; no real D1 is touched.
 */

import { describe, it, expect } from "vitest";
import {
  createPending, approve, reject, requestChanges,
  getApprovalState, listPending,
  type AgentApprovalRow, type ApprovalState,
} from "../src/lib/agent-approvals";

// ─── Fake D1 ────────────────────────────────────────────────────

interface FakeRow {
  agent_id: string;
  state: ApprovalState;
  requested_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  reviewer_notes: string | null;
  source_pr: string | null;
  created_at: string;
  updated_at: string;
}

function makeFakeDb() {
  const rows = new Map<string, FakeRow>();
  const now = () => new Date().toISOString().slice(0, 19).replace("T", " ");

  const stmt = (sql: string, args: readonly unknown[] = []) => ({
    bind: (...next: unknown[]) => stmt(sql, next),
    run: async () => {
      // INSERT OR IGNORE … VALUES (?, 'pending', datetime('now'), ?)
      if (/INSERT OR IGNORE INTO agent_approvals/.test(sql)) {
        const agentId = String(args[0]);
        const sourcePr = args[1] === null ? null : String(args[1]);
        if (!rows.has(agentId)) {
          rows.set(agentId, {
            agent_id: agentId, state: "pending",
            requested_at: now(),
            reviewed_at: null, reviewed_by: null, reviewer_notes: null,
            source_pr: sourcePr,
            created_at: now(), updated_at: now(),
          });
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      }
      // UPDATE … SET state = '...' WHERE agent_id = ? AND state IN (...)
      const updateMatch = sql.match(/UPDATE agent_approvals\s+SET state = '([^']+)'/);
      if (updateMatch) {
        const newState = updateMatch[1] as ApprovalState;
        const reviewer = String(args[0]);
        const notes = args[1] === null ? null : args[1] === undefined ? null : String(args[1]);
        const agentId = String(args[2]);
        const allowed = sql.match(/state IN \(([^)]+)\)/)?.[1] ?? "";
        const allowedStates = allowed.split(",").map((s) => s.replace(/[' ]/g, "")) as ApprovalState[];
        const row = rows.get(agentId);
        if (!row || !allowedStates.includes(row.state)) return { meta: { changes: 0 } };
        row.state = newState;
        row.reviewed_at = now();
        row.reviewed_by = reviewer;
        row.reviewer_notes = notes;
        row.updated_at = now();
        return { meta: { changes: 1 } };
      }
      return { meta: { changes: 0 } };
    },
    first: async () => {
      // SELECT … FROM agent_approvals WHERE agent_id = ?
      if (/FROM agent_approvals\s+WHERE agent_id =/.test(sql)) {
        return rows.get(String(args[0])) ?? null;
      }
      return null;
    },
    all: async () => {
      if (/FROM agent_approvals\s+WHERE state IN/.test(sql)) {
        const results = [...rows.values()]
          .filter((r) => r.state === "pending" || r.state === "changes_requested")
          .sort((a, b) => b.requested_at.localeCompare(a.requested_at));
        return { results };
      }
      return { results: [] };
    },
  });
  return {
    db: {
      prepare: (sql: string) => stmt(sql),
    } as unknown as D1Database,
    rows,
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe("agent-approvals lib (Phase 5.4a)", () => {
  it("createPending inserts a pending row that getApprovalState reads back", async () => {
    const { db } = makeFakeDb();
    const created = await createPending(db, "demo_agent", "https://github.com/example/pull/1");
    expect(created.agent_id).toBe("demo_agent");
    expect(created.state).toBe("pending");
    expect(created.source_pr).toBe("https://github.com/example/pull/1");

    const fetched = await getApprovalState(db, "demo_agent");
    expect(fetched?.state).toBe("pending");
  });

  it("createPending is idempotent — a second call doesn't overwrite the row", async () => {
    const { db } = makeFakeDb();
    const first = await createPending(db, "demo_agent", "pr-1");
    const second = await createPending(db, "demo_agent", "pr-2");
    expect(second.source_pr).toBe("pr-1"); // first wins
    expect(first.requested_at).toBe(second.requested_at);
  });

  it("approve flips pending → approved + records reviewer", async () => {
    const { db } = makeFakeDb();
    await createPending(db, "demo_agent");
    const approved = await approve(db, "demo_agent", "user_42", "looks good");
    expect(approved.state).toBe("approved");
    expect(approved.reviewed_by).toBe("user_42");
    expect(approved.reviewer_notes).toBe("looks good");
  });

  it("approve fails with a clear error when no pending row exists", async () => {
    const { db } = makeFakeDb();
    await expect(approve(db, "missing_agent", "user_42")).rejects.toThrow(/no pending approval row/);
  });

  it("reject requires notes (>= 5 chars)", async () => {
    const { db } = makeFakeDb();
    await createPending(db, "demo_agent");
    await expect(reject(db, "demo_agent", "user_42", "")).rejects.toThrow(/required/);
    await expect(reject(db, "demo_agent", "user_42", "too short")).resolves.toBeDefined();
    const after = await getApprovalState(db, "demo_agent");
    expect(after?.state).toBe("rejected");
  });

  it("requestChanges flips pending → changes_requested + leaves it visible to listPending", async () => {
    const { db } = makeFakeDb();
    await createPending(db, "demo_agent");
    await requestChanges(db, "demo_agent", "user_42", "needs better fallback");
    const pending = await listPending(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.state).toBe("changes_requested");
    expect(pending[0]?.reviewer_notes).toBe("needs better fallback");
  });

  it("listPending excludes approved + rejected agents", async () => {
    const { db } = makeFakeDb();
    await createPending(db, "agent_a");
    await createPending(db, "agent_b");
    await createPending(db, "agent_c");
    await approve(db, "agent_a", "user_42");
    await reject(db, "agent_b", "user_42", "rejected for testing");
    const pending = await listPending(db);
    expect(pending.map((r: AgentApprovalRow) => r.agent_id)).toEqual(["agent_c"]);
  });
});
