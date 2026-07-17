import { describe, it, expect } from "vitest";
import {
  followupDraftSubmitter,
  recordSubmissionAttempt,
} from "../src/lib/takedown-submitters";
import type { ProviderRecord, TakedownRecord } from "../src/lib/takedown-submitters";
import type { Env } from "../src/types";

function makeTakedown(overrides: Partial<TakedownRecord> = {}): TakedownRecord {
  return {
    id:                     "td-1",
    org_id:                 42,
    brand_id:               "b1",
    module_key:             "domain",
    target_type:            "domain",
    target_value:           "fake-acme.example",
    target_url:             "https://fake-acme.example/login",
    evidence_summary:       "Phishing site impersonating Acme.",
    evidence_detail:        "Detected by Cartographer. SSL cert issued 2 days ago.",
    provider_name:          "Cloudflare",
    provider_abuse_contact: "abuse@cloudflare.com",
    provider_method:        "email",
    severity:               "HIGH",
    ...overrides,
  };
}

function makeProvider(overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    id:                  101,
    provider_name:       "Cloudflare",
    provider_type:       "hosting",
    abuse_email:         "abuse@cloudflare.com",
    abuse_url:           "https://abuse.cloudflare.com/",
    abuse_api_url:       null,
    abuse_api_type:      "form",
    auto_submit_enabled: 1,
    ...overrides,
  };
}

function makeEnv(captured: { sql: string; binds: unknown[] }[]): Env {
  return {
    DB: {
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => ({
          run:   async () => { captured.push({ sql, binds }); return { success: true }; },
          first: async () => null,
          all:   async () => ({ results: [] }),
        }),
      }),
    },
  } as unknown as Env;
}

// S1: submitFollowup takes Env first; draft mode keeps historical behavior.
const draftEnv = { TAKEDOWN_SEND_MODE: "draft" } as unknown as Env;

describe("followupDraftSubmitter", () => {
  it("returns outcome='queued' (no outbound side effect)", async () => {
    const result = await followupDraftSubmitter.submitFollowup(
      draftEnv,
      makeTakedown(), makeProvider(),
      { originalSubmittedAt: "2026-05-01T00:00:00Z", hoursElapsed: 96 },
    );
    expect(result.outcome).toBe("queued");
    expect(result.submitter_kind).toBe("followup_email_draft");
    expect(result.submitter_target).toBe("abuse@cloudflare.com");
  });

  it("body references the prior ticket id when provided", async () => {
    const result = await followupDraftSubmitter.submitFollowup(
      draftEnv,
      makeTakedown(), makeProvider(),
      {
        originalSubmittedAt: "2026-05-01T00:00:00Z",
        priorTicketId:       "CF-12345",
        hoursElapsed:        50,
      },
    );
    expect(result.request_payload).toContain("CF-12345");
    expect(result.request_payload).toContain("Follow-up");
    expect(result.request_payload).toContain("50 hour(s)");
  });

  it("falls back to the takedown id when no prior ticket id is known", async () => {
    const result = await followupDraftSubmitter.submitFollowup(
      draftEnv,
      makeTakedown({ id: "td-abc" }), makeProvider(),
      { originalSubmittedAt: "2026-05-01T00:00:00Z", hoursElapsed: 24 },
    );
    expect(result.request_payload).toContain("td-abc");
    expect(result.request_payload).not.toContain("CF-12345");
  });

  it("body lists the original target value, severity, and module", async () => {
    const result = await followupDraftSubmitter.submitFollowup(
      draftEnv,
      makeTakedown({ target_value: "phisher.example", severity: "CRITICAL", module_key: "social" }),
      makeProvider(),
      { originalSubmittedAt: "2026-05-01T00:00:00Z", hoursElapsed: 72 },
    );
    expect(result.request_payload).toContain("phisher.example");
    expect(result.request_payload).toContain("CRITICAL");
    expect(result.request_payload).toContain("social");
  });

  it("truncates request_summary to 500 chars", async () => {
    const longDetail = "x".repeat(2000);
    const result = await followupDraftSubmitter.submitFollowup(
      draftEnv,
      makeTakedown({ evidence_detail: longDetail }), makeProvider(),
      { originalSubmittedAt: "2026-05-01T00:00:00Z", hoursElapsed: 24 },
    );
    expect((result.request_summary ?? "").length).toBeLessThanOrEqual(500);
  });

  it("kind matches Phase H's dedup pattern (followup_*)", () => {
    expect(followupDraftSubmitter.kind).toMatch(/^followup_/);
  });
});

describe("recordSubmissionAttempt", () => {
  it("writes a takedown_submissions row using the helper", async () => {
    const captured: { sql: string; binds: unknown[] }[] = [];
    const env = makeEnv(captured);

    const submissionId = await recordSubmissionAttempt(env, "td-xyz", 42, {
      outcome:          "queued",
      submitter_kind:   "followup_email_draft",
      submitter_target: "abuse@example.com",
      request_summary:  "summary",
      request_payload:  "body",
      duration_ms:      5,
    });

    expect(submissionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(captured).toHaveLength(1);
    expect(captured[0].sql).toContain("INSERT INTO takedown_submissions");
    expect(captured[0].binds[1]).toBe("td-xyz");
    expect(captured[0].binds[2]).toBe(42);
    expect(captured[0].binds[3]).toBe("followup_email_draft");
    expect(captured[0].binds[7]).toBe("queued");
  });
});

describe("Sparrow Phase H SQL shape (source-of-truth pin)", () => {
  it("declares takedown_authorizations + takedown_submissions in reads", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(
      resolve(__dirname, "../src/agents/sparrow.ts"),
      "utf-8",
    );
    expect(src).toContain('name: "takedown_authorizations"');
    expect(src).toContain('name: "takedown_submissions"');
  });

  it("Phase H query joins takedown_authorizations + extracts the SLA from scope_json", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(
      resolve(__dirname, "../src/agents/sparrow.ts"),
      "utf-8",
    );
    expect(src).toContain("auto_followup_breached_sla_hours");
    expect(src).toContain("json_extract(ta.scope_json");
    expect(src).toMatch(/submitter_kind LIKE 'followup_%'/);
  });

  it("Phase H respects the previous-followup-since-submission dedup", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(
      resolve(__dirname, "../src/agents/sparrow.ts"),
      "utf-8",
    );
    // Anti-join NOT EXISTS scoping the followup attempt's timestamp
    // strictly after the takedown's last submitted_at.
    expect(src).toContain("NOT EXISTS");
    expect(src).toMatch(/ts\.attempted_at\s*>\s*tr\.submitted_at/);
  });
});
