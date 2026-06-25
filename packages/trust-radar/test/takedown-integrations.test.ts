import { describe, it, expect } from "vitest";
import { getTakedownIntegrations } from "../src/lib/takedown-integrations";
import type { Env } from "../src/types";

// Stub D1: routes the three queries by a fragment match and returns canned rows.
function makeEnv(opts: {
  stats?: Array<Record<string, unknown>>;
  errors?: Array<Record<string, unknown>>;
  providers?: Array<Record<string, unknown>>;
  vars?: Record<string, string>;
}): Env {
  const stats = opts.stats ?? [];
  const errors = opts.errors ?? [];
  const providers = opts.providers ?? [];
  return {
    ...(opts.vars ?? {}),
    DB: {
      prepare: (sql: string) => ({
        bind: (..._b: unknown[]) => ({
          all: async () => {
            if (sql.includes("GROUP BY submitter_kind")) return { results: stats };
            if (sql.includes("error_message IS NOT NULL")) return { results: errors };
            return { results: providers };
          },
        }),
        all: async () => ({ results: providers }), // provider query has no bind()
      }),
    },
  } as unknown as Env;
}

describe("getTakedownIntegrations", () => {
  it("lists all registered integrations even with zero submissions", async () => {
    const report = await getTakedownIntegrations(makeEnv({}), 168);
    const kinds = report.integrations.map((i) => i.kind);
    expect(kinds).toEqual([
      "api_netbeacon", "api_godaddy", "api_web_risk",
      "email_send", "email_draft", "followup_email_draft",
    ]);
    expect(report.window_hours).toBe(168);
  });

  it("computes success_rate over decided outcomes (excludes queued)", async () => {
    const report = await getTakedownIntegrations(makeEnv({
      stats: [{ kind: "api_netbeacon", total: 10, submitted: 8, queued: 0, rejected: 1, failed: 1, last_submission_at: "2026-06-25T00:00:00Z" }],
    }), 168);
    const nb = report.integrations.find((i) => i.kind === "api_netbeacon")!;
    expect(nb.success_rate).toBe(80); // 8 / (8+1+1)
    expect(nb.last_submission_at).toBe("2026-06-25T00:00:00Z");
  });

  it("null success_rate when nothing decided (only queued)", async () => {
    const report = await getTakedownIntegrations(makeEnv({
      stats: [{ kind: "email_draft", total: 5, submitted: 0, queued: 5, rejected: 0, failed: 0, last_submission_at: "x" }],
    }), 168);
    const d = report.integrations.find((i) => i.kind === "email_draft")!;
    expect(d.success_rate).toBeNull();
  });

  it("derives status: live when configured + enabled + live send mode", async () => {
    const report = await getTakedownIntegrations(makeEnv({
      vars: { TAKEDOWN_SEND_MODE: "live", NETBEACON_API_KEY: "k" },
      providers: [{ provider_name: "NetBeacon", abuse_api_type: "netbeacon", auto_submit_enabled: 1 }],
    }), 168);
    const nb = report.integrations.find((i) => i.kind === "api_netbeacon")!;
    expect(nb.configured).toBe(true);
    expect(nb.auto_submit_enabled).toBe(true);
    expect(nb.provider_name).toBe("NetBeacon");
    expect(nb.status).toBe("live");
  });

  it("status=disabled when configured but auto_submit_enabled=0", async () => {
    const report = await getTakedownIntegrations(makeEnv({
      vars: { TAKEDOWN_SEND_MODE: "live", NETBEACON_API_KEY: "k" },
      providers: [{ provider_name: "NetBeacon", abuse_api_type: "netbeacon", auto_submit_enabled: 0 }],
    }), 168);
    expect(report.integrations.find((i) => i.kind === "api_netbeacon")!.status).toBe("disabled");
  });

  it("status=paused when enabled but global send mode is draft", async () => {
    const report = await getTakedownIntegrations(makeEnv({
      vars: { TAKEDOWN_SEND_MODE: "draft", GODADDY_API_KEY: "k", GODADDY_API_SECRET: "s" },
      providers: [{ provider_name: "GoDaddy", abuse_api_type: "godaddy", auto_submit_enabled: 1 }],
    }), 168);
    const gd = report.integrations.find((i) => i.kind === "api_godaddy")!;
    expect(gd.configured).toBe(true);
    expect(gd.status).toBe("paused");
  });

  it("status=unconfigured when the credential is absent", async () => {
    const report = await getTakedownIntegrations(makeEnv({
      vars: { TAKEDOWN_SEND_MODE: "live" },
      providers: [{ provider_name: "GoDaddy", abuse_api_type: "godaddy", auto_submit_enabled: 1 }],
    }), 168);
    const gd = report.integrations.find((i) => i.kind === "api_godaddy")!;
    expect(gd.configured).toBe(false);
    expect(gd.status).toBe("unconfigured");
  });

  it("godaddy needs BOTH key and secret to be configured", async () => {
    const report = await getTakedownIntegrations(makeEnv({
      vars: { TAKEDOWN_SEND_MODE: "live", GODADDY_API_KEY: "k" }, // secret missing
      providers: [{ provider_name: "GoDaddy", abuse_api_type: "godaddy", auto_submit_enabled: 1 }],
    }), 168);
    expect(report.integrations.find((i) => i.kind === "api_godaddy")!.configured).toBe(false);
  });

  it("email_draft is always 'active' (no credential needed)", async () => {
    const report = await getTakedownIntegrations(makeEnv({ vars: { TAKEDOWN_SEND_MODE: "draft" } }), 168);
    const d = report.integrations.find((i) => i.kind === "email_draft")!;
    expect(d.configured).toBe(true);
    expect(d.auto_submit_enabled).toBeNull();
    expect(d.status).toBe("active");
  });

  it("surfaces the most recent error per kind", async () => {
    const report = await getTakedownIntegrations(makeEnv({
      stats: [{ kind: "api_godaddy", total: 2, submitted: 0, queued: 0, rejected: 0, failed: 2, last_submission_at: "x" }],
      errors: [
        { kind: "api_godaddy", error_message: "HTTP 500 newest", attempted_at: "2026-06-25T02:00:00Z" },
        { kind: "api_godaddy", error_message: "HTTP 500 older", attempted_at: "2026-06-25T01:00:00Z" },
      ],
      vars: { TAKEDOWN_SEND_MODE: "live", GODADDY_API_KEY: "k", GODADDY_API_SECRET: "s" },
    }), 168);
    expect(report.integrations.find((i) => i.kind === "api_godaddy")!.last_error).toBe("HTTP 500 newest");
  });
});
