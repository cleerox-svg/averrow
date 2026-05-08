import { describe, it, expect } from "vitest";
import {
  dispatchSubmission,
  emailDraftSubmitter,
  pickSubmitter,
  type ProviderRecord,
  type TakedownRecord,
} from "../src/lib/takedown-submitters";
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
    evidence_detail:        "Detected by Cartographer. SSL cert issued 2 days ago. " +
                            "GreyNoise classifies the IP as malicious. Brand match score 0.95.",
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

function makeMockDb(captured: { sql: string; binds: unknown[] }[]) {
  const prepare = (sql: string) => ({
    bind: (...binds: unknown[]) => ({
      run:   async () => { captured.push({ sql, binds }); return { success: true }; },
      first: async () => null,
      all:   async () => ({ results: [] }),
    }),
  });
  return { prepare };
}

function makeEnv(captured: { sql: string; binds: unknown[] }[]): Env {
  return { DB: makeMockDb(captured) } as unknown as Env;
}

describe("emailDraftSubmitter", () => {
  it("handles any provider that has an abuse_email", () => {
    const provider = makeProvider();
    expect(emailDraftSubmitter.canHandle(makeTakedown(), provider)).toBe(true);
  });

  it("does NOT handle a provider with no abuse_email", () => {
    expect(emailDraftSubmitter.canHandle(
      makeTakedown(),
      makeProvider({ abuse_email: null }),
    )).toBe(false);
  });

  it("returns outcome='queued' (records intent, no outbound side effect)", async () => {
    const result = await emailDraftSubmitter.submit(makeTakedown(), makeProvider());
    expect(result.outcome).toBe("queued");
    expect(result.submitter_kind).toBe("email_draft");
    expect(result.submitter_target).toBe("abuse@cloudflare.com");
  });

  it("includes target value, severity, module, and evidence in the body", async () => {
    const result = await emailDraftSubmitter.submit(
      makeTakedown({ target_value: "phisher.example", severity: "CRITICAL", module_key: "social" }),
      makeProvider(),
    );
    expect(result.request_payload).toContain("phisher.example");
    expect(result.request_payload).toContain("CRITICAL");
    expect(result.request_payload).toContain("social");
    expect(result.request_payload).toContain("Brand match score 0.95");
  });

  it("truncates request_summary to 500 chars", async () => {
    const longDetail = "x".repeat(2000);
    const result = await emailDraftSubmitter.submit(
      makeTakedown({ evidence_detail: longDetail }),
      makeProvider(),
    );
    expect((result.request_summary ?? "").length).toBeLessThanOrEqual(500);
  });
});

describe("pickSubmitter", () => {
  it("returns the email-draft submitter for a provider with abuse_email", () => {
    expect(pickSubmitter(makeTakedown(), makeProvider())?.kind).toBe("email_draft");
  });

  it("returns null when no submitter matches", () => {
    expect(pickSubmitter(
      makeTakedown(),
      makeProvider({ abuse_email: null }),
    )).toBeNull();
  });
});

describe("dispatchSubmission", () => {
  it("writes a takedown_submissions audit row on success", async () => {
    const captured: { sql: string; binds: unknown[] }[] = [];
    const env = makeEnv(captured);

    const { result, submission_id } = await dispatchSubmission(
      env, makeTakedown(), makeProvider(),
    );

    expect(result.outcome).toBe("queued");
    expect(submission_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(captured).toHaveLength(1);
    expect(captured[0].sql).toContain("INSERT INTO takedown_submissions");
    // takedown_id is the second bind (id, takedown_id, ...)
    expect(captured[0].binds[1]).toBe("td-1");
    // outcome is the 8th bind
    expect(captured[0].binds[7]).toBe("queued");
  });

  it("records outcome='failed' with error_message when no submitter matches", async () => {
    const captured: { sql: string; binds: unknown[] }[] = [];
    const env = makeEnv(captured);

    const { result } = await dispatchSubmission(
      env, makeTakedown(), makeProvider({ abuse_email: null }),
    );

    expect(result.outcome).toBe("failed");
    expect(result.error_message).toContain("No submitter matched");
    expect(captured).toHaveLength(1);
    // outcome bind position
    expect(captured[0].binds[7]).toBe("failed");
  });

  it("catches submitter throws and records outcome='failed'", async () => {
    const captured: { sql: string; binds: unknown[] }[] = [];
    const env = makeEnv(captured);

    // Replace the email-draft submitter's submit with one that throws.
    // We can't easily inject; instead, force pickSubmitter() to find no
    // submitter by clearing abuse_email — covered by the previous test.
    // For thrown-error coverage we test the email-draft submitter
    // directly, which the dispatcher's try/catch wraps:
    const orig = emailDraftSubmitter.submit;
    (emailDraftSubmitter as { submit: typeof orig }).submit = async () => {
      throw new Error("boom");
    };

    try {
      const { result } = await dispatchSubmission(
        env, makeTakedown(), makeProvider(),
      );
      expect(result.outcome).toBe("failed");
      expect(result.error_message).toBe("boom");
    } finally {
      (emailDraftSubmitter as { submit: typeof orig }).submit = orig;
    }
  });
});
