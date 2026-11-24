import { describe, it, expect } from "vitest";
import { getTakedownIntegrations } from "../src/lib/takedown-integrations";
import type { Env } from "../src/types";

// Stub D1: routes the three queries by a fragment match and returns canned rows.
function makeEnv(opts: {
  stats?: Array<Record<string, unknown>>;
  errors?: Array<Record<string, unknown>>;
  providers?: Array<Record<string, unknown>>;
  vars?: Record<string, string>;
  /** Web Risk calls this month; undefined → the COUNT read throws. */
  webRiskMonth?: number;
}): Env {
  const stats = opts.stats ?? [];
  const errors = opts.errors ?? [];
  const providers = opts.providers ?? [];
  return {
    ...(opts.vars ?? {}),
    DB: {
      prepare: (sql: string) => ({
        bind: (..._b: unknown[]) => ({
          first: async () => {
            if (opts.webRiskMonth === undefined) throw new Error("no count");
            return { n: opts.webRiskMonth };
          },
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
  it("reports Web Risk's monthly usage against its cap, and only for Web Risk", async () => {
    const report = await getTakedownIntegrations(makeEnv({ webRiskMonth: 42 }), 168);
    const wr = report.integrations.find((i) => i.kind === "api_web_risk")!;
    expect(wr.monthly_quota).toEqual({ used: 42, cap: 100 });
    expect(report.integrations.filter((i) => i.monthly_quota)).toHaveLength(1);
    const capped = await getTakedownIntegrations(makeEnv({ webRiskMonth: 5, vars: { WEB_RISK_MONTHLY_CAP: "20" } }), 168);
    expect(capped.integrations.find((i) => i.kind === "api_web_risk")!.monthly_quota).toEqual({ used: 5, cap: 20 });
    const unreadable = await getTakedownIntegrations(makeEnv({}), 168);
    expect(unreadable.integrations.find((i) => i.kind === "api_web_risk")!.monthly_quota).toEqual({ used: null, cap: 100 });
  });


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

  describe("config block", () => {
    const PROVIDERS = [
      { id: 7, provider_name: "NetBeacon", provider_type: "registrar", abuse_email: null, abuse_url: "https://netbeacon.org",
        abuse_api_url: "https://api.netbeacon.org", abuse_api_type: "netbeacon", auto_submit_enabled: 1 },
      { id: 9, provider_name: "GoDaddy", provider_type: "registrar", abuse_email: "abuse@godaddy.com", abuse_url: null,
        abuse_api_url: null, abuse_api_type: "godaddy", auto_submit_enabled: 0 },
    ];

    it("lists the secret NAMES and optional vars each channel reads (never values)", async () => {
      const report = await getTakedownIntegrations(makeEnv({
        vars: { NETBEACON_API_KEY: "super-secret-value", GOOGLE_SERVICE_ACCOUNT_JSON: "{\"k\":1}" },
      }), 168);
      const byKind = Object.fromEntries(report.integrations.map((i) => [i.kind, i.config]));
      expect(byKind.api_netbeacon!.credential_secrets).toEqual(["NETBEACON_API_KEY"]);
      expect(byKind.api_netbeacon!.optional_vars).toEqual(["NETBEACON_API_BASE"]);
      expect(byKind.api_godaddy!.credential_secrets).toEqual(["GODADDY_API_KEY", "GODADDY_API_SECRET"]);
      expect(byKind.api_godaddy!.optional_vars).toEqual(["GODADDY_API_BASE"]);
      expect(byKind.api_web_risk!.credential_secrets).toEqual(["GOOGLE_SERVICE_ACCOUNT_JSON"]);
      expect(byKind.api_web_risk!.optional_vars).toEqual(["WEB_RISK_MONTHLY_CAP"]);
      expect(byKind.email_send!.credential_secrets).toEqual(["RESEND_API_KEY"]);
      expect(byKind.email_send!.optional_vars).toEqual([]);
      for (const k of ["email_draft", "followup_email_draft"]) {
        expect(byKind[k]!.credential_secrets).toEqual([]);
        expect(byKind[k]!.optional_vars).toEqual([]);
      }
      // No secret value ever appears in the report.
      const raw = JSON.stringify(report);
      expect(raw).not.toContain("super-secret-value");
      expect(raw).not.toContain('{"k":1}');
    });

    it("requires_live_mode is true for API + live email, false for drafts; send_mode mirrors the report", async () => {
      const report = await getTakedownIntegrations(makeEnv({ vars: { TAKEDOWN_SEND_MODE: "live" } }), 168);
      const live = Object.fromEntries(report.integrations.map((i) => [i.kind, i.config.requires_live_mode]));
      expect(live).toEqual({
        api_netbeacon: true, api_godaddy: true, api_web_risk: true,
        email_send: true, email_draft: false, followup_email_draft: false,
      });
      expect(report.integrations.every((i) => i.config.send_mode === "live")).toBe(true);
      const draft = await getTakedownIntegrations(makeEnv({}), 168);
      expect(draft.send_mode).toBe("draft");
      expect(draft.integrations.every((i) => i.config.send_mode === "draft")).toBe(true);
    });

    it("maps the provider row onto API kinds; auto_submit_editable only when a row exists", async () => {
      const report = await getTakedownIntegrations(makeEnv({ providers: PROVIDERS }), 168);
      const nb = report.integrations.find((i) => i.kind === "api_netbeacon")!;
      expect(nb.config.provider).toEqual({
        id: 7, provider_name: "NetBeacon", provider_type: "registrar", abuse_email: null,
        abuse_url: "https://netbeacon.org", abuse_api_url: "https://api.netbeacon.org",
        abuse_api_type: "netbeacon", auto_submit_enabled: true,
      });
      expect(nb.config.auto_submit_editable).toBe(true);
      const gd = report.integrations.find((i) => i.kind === "api_godaddy")!;
      expect(gd.config.provider?.auto_submit_enabled).toBe(false);
      expect(gd.config.provider?.abuse_email).toBe("abuse@godaddy.com");
      expect(gd.auto_submit_enabled).toBe(false);
      expect(gd.config.auto_submit_editable).toBe(true);
      // No web_risk row → null provider, not editable.
      const wr = report.integrations.find((i) => i.kind === "api_web_risk")!;
      expect(wr.config.provider).toBeNull();
      expect(wr.config.auto_submit_editable).toBe(false);
    });

    it("email kinds never carry a provider and are never editable", async () => {
      const report = await getTakedownIntegrations(makeEnv({ providers: PROVIDERS }), 168);
      for (const i of report.integrations.filter((x) => x.channel === "email")) {
        expect(i.config.provider).toBeNull();
        expect(i.config.auto_submit_editable).toBe(false);
      }
    });

    it("reports the lowest-id row when several share an abuse_api_type", async () => {
      const report = await getTakedownIntegrations(makeEnv({ providers: [
        { ...PROVIDERS[0], id: 3, provider_name: "NetBeacon (first)" },
        { ...PROVIDERS[0], id: 4, provider_name: "NetBeacon (second)", auto_submit_enabled: 0 },
      ] }), 168);
      const nb = report.integrations.find((i) => i.kind === "api_netbeacon")!;
      expect(nb.provider_name).toBe("NetBeacon (first)");
      expect(nb.config.provider?.id).toBe(3);
    });
  });
});
