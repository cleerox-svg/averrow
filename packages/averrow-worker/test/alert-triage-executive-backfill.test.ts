import { describe, it, expect } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { runAlertTriageBackfill } from "../src/lib/alert-triage";

// Minimal fake D1 for the backfill's executive_impersonation dispatch.
// Routes by SQL text:
//   - SELECT ... FROM alerts WHERE status = 'new'  → the alert batch
//   - SELECT ... FROM org_executives WHERE id IN   → the exec allowlists
//   - UPDATE alerts ...                            → records dismissals
interface AlertRowStub {
  id: string;
  brand_id: string;
  source_type: string | null;
  source_id: string | null;
  alert_type: string;
  details: string | null;
}
interface ExecRowStub {
  id: string;
  full_name: string | null;
  official_handles: string | null;
}

function mkDb(alerts: AlertRowStub[], execs: ExecRowStub[]) {
  const dismissedIds: string[] = [];
  const db = {
    prepare(sql: string) {
      const isAlertSelect = sql.includes("FROM alerts") && sql.includes("status = 'new'");
      const isExecSelect = sql.includes("FROM org_executives");
      const isUpdate = sql.trimStart().startsWith("UPDATE alerts");
      return {
        _bound: [] as unknown[],
        bind(...args: unknown[]) {
          this._bound = args;
          return this;
        },
        async all<T>() {
          if (isAlertSelect) return { results: alerts as unknown as T[] };
          if (isExecSelect) return { results: execs as unknown as T[] };
          return { results: [] as T[] };
        },
        async first<T>() {
          return null as T;
        },
        async run() {
          if (isUpdate) {
            const id = this._bound[this._bound.length - 1];
            if (typeof id === "string") dismissedIds.push(id);
          }
          return { meta: { changes: 1 } };
        },
      };
    },
  };
  return { db: db as unknown as D1Database, dismissedIds };
}

describe("runAlertTriageBackfill — executive_impersonation dispatch", () => {
  it("dismisses low-score + official-handle matches, keeps a real impersonator, and reports by_type", async () => {
    const alerts: AlertRowStub[] = [
      {
        id: "a-low",
        brand_id: "b1",
        source_type: "executive_monitor",
        source_id: "e1",
        alert_type: "executive_impersonation",
        details: JSON.stringify({ executive_id: "e1", platform: "twitter", handle: "janedoe9", score: 0.2 }),
      },
      {
        id: "a-official",
        brand_id: "b1",
        source_type: "executive_monitor",
        source_id: "e1",
        alert_type: "executive_impersonation",
        details: JSON.stringify({ executive_id: "e1", platform: "twitter", handle: "janedoe", score: 0.95 }),
      },
      {
        id: "a-real",
        brand_id: "b1",
        source_type: "executive_monitor",
        source_id: "e1",
        alert_type: "executive_impersonation",
        details: JSON.stringify({ executive_id: "e1", platform: "instagram", handle: "realjanedoe", score: 0.9 }),
      },
    ];
    const execs: ExecRowStub[] = [
      { id: "e1", full_name: "Jane Doe", official_handles: JSON.stringify({ twitter: "janedoe" }) },
    ];

    const { db, dismissedIds } = mkDb(alerts, execs);
    const result = await runAlertTriageBackfill(db);

    expect(result.scanned).toBe(3);
    // low-score (rule A) + official-handle (rule B) dismiss; real impersonator kept.
    expect(result.dismissed).toBe(2);
    expect(result.kept).toBe(1);
    expect(dismissedIds.sort()).toEqual(["a-low", "a-official"]);

    expect(result.by_type["executive_impersonation"]).toEqual({
      scanned: 3,
      dismissed: 2,
      kept: 1,
    });
  });

  it("keeps an exec alert whose executive_id has no registry row (empty allowlist, high score)", async () => {
    const alerts: AlertRowStub[] = [
      {
        id: "a-orphan",
        brand_id: "b1",
        source_type: "executive_monitor",
        source_id: "gone",
        alert_type: "executive_impersonation",
        details: JSON.stringify({ executive_id: "gone", platform: "twitter", handle: "janedoe1", score: 0.85 }),
      },
    ];
    const { db, dismissedIds } = mkDb(alerts, []);
    const result = await runAlertTriageBackfill(db);

    expect(result.dismissed).toBe(0);
    expect(result.kept).toBe(1);
    expect(dismissedIds).toEqual([]);
    expect(result.by_type["executive_impersonation"]).toEqual({ scanned: 1, dismissed: 0, kept: 1 });
  });
});
