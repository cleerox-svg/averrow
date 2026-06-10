import { describe, it, expect } from "vitest";
import {
  dispatchSubmission,
  emailDraftSubmitter,
  emailSendSubmitter,
  isLiveSendMode,
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

function makeEnv(
  captured: { sql: string; binds: unknown[] }[],
  vars: Record<string, string> = {},
): Env {
  return { DB: makeMockDb(captured), ...vars } as unknown as Env;
}

// Submitter selection is pure over (env.TAKEDOWN_SEND_MODE, provider).
const draftEnv = makeEnv([], { TAKEDOWN_SEND_MODE: "draft" });
const liveEnv  = makeEnv([], { TAKEDOWN_SEND_MODE: "live" });
const unsetEnv = makeEnv([]);

describe("isLiveSendMode (S1)", () => {
  it("is live only on the exact 'live' value", () => {
    expect(isLiveSendMode(liveEnv)).toBe(true);
    expect(isLiveSendMode(draftEnv)).toBe(false);
    expect(isLiveSendMode(unsetEnv)).toBe(false);
    expect(isLiveSendMode(makeEnv([], { TAKEDOWN_SEND_MODE: "LIVE" }))).toBe(false);
  });
});

describe("emailDraftSubmitter", () => {
  it("handles any provider that has an abuse_email", () => {
    const provider = makeProvider();
    expect(emailDraftSubmitter.canHandle(draftEnv, makeTakedown(), provider)).toBe(true);
  });

  it("does NOT handle a provider with no abuse_email", () => {
    expect(emailDraftSubmitter.canHandle(
      draftEnv,
      makeTakedown(),
      makeProvider({ abuse_email: null }),
    )).toBe(false);
  });

  it("returns outcome='queued' (records intent, no outbound side effect)", async () => {
    const result = await emailDraftSubmitter.submit(draftEnv, makeTakedown(), makeProvider());
    expect(result.outcome).toBe("queued");
    expect(result.submitter_kind).toBe("email_draft");
    expect(result.submitter_target).toBe("abuse@cloudflare.com");
  });

  it("includes target value, severity, module, and evidence in the body", async () => {
    const result = await emailDraftSubmitter.submit(
      draftEnv,
      makeTakedown({ target_value: "phisher.example", severity: "CRITICAL", module_key: "social" }),
      makeProvider(),
    );
    expect(result.request_payload).toContain("phisher.example");
    expect(result.request_payload).toContain("CRITICAL");
    expect(result.request_payload).toContain("social");
    expect(result.request_payload).toContain("Brand match score 0.95");
  });

  it("audit payload preserves the historical To/Subject preamble shape", async () => {
    const result = await emailDraftSubmitter.submit(draftEnv, makeTakedown(), makeProvider());
    const lines = (result.request_payload ?? "").split("\n");
    expect(lines[0]).toBe("To: abuse@cloudflare.com");
    expect(lines[1]).toMatch(/^Subject: \[Averrow\] Takedown request/);
    expect(lines[2]).toBe("");
  });

  it("truncates request_summary to 500 chars", async () => {
    const longDetail = "x".repeat(2000);
    const result = await emailDraftSubmitter.submit(
      draftEnv,
      makeTakedown({ evidence_detail: longDetail }),
      makeProvider(),
    );
    expect((result.request_summary ?? "").length).toBeLessThanOrEqual(500);
  });
});

describe("emailSendSubmitter (S1)", () => {
  it("only handles providers in live mode", () => {
    const provider = makeProvider();
    expect(emailSendSubmitter.canHandle(liveEnv, makeTakedown(), provider)).toBe(true);
    expect(emailSendSubmitter.canHandle(draftEnv, makeTakedown(), provider)).toBe(false);
    expect(emailSendSubmitter.canHandle(unsetEnv, makeTakedown(), provider)).toBe(false);
  });

  it("never handles a provider with no abuse_email, even live", () => {
    expect(emailSendSubmitter.canHandle(
      liveEnv,
      makeTakedown(),
      makeProvider({ abuse_email: null }),
    )).toBe(false);
  });

  it("returns outcome='failed' (not throw) when RESEND_API_KEY is missing", async () => {
    // Live mode but no key — must degrade to a failed audit row so the
    // takedown stays 'draft' and the next Sparrow tick retries.
    const result = await emailSendSubmitter.submit(liveEnv, makeTakedown(), makeProvider());
    expect(result.outcome).toBe("failed");
    expect(result.error_message).toContain("RESEND_API_KEY");
    expect(result.request_payload).toContain("td-1");
  });
});

describe("pickSubmitter", () => {
  it("returns the email-draft submitter in draft mode (pre-S1 behavior)", () => {
    expect(pickSubmitter(draftEnv, makeTakedown(), makeProvider())?.kind).toBe("email_draft");
  });

  it("returns the email-draft submitter when the mode var is unset (safe default)", () => {
    expect(pickSubmitter(unsetEnv, makeTakedown(), makeProvider())?.kind).toBe("email_draft");
  });

  it("returns the live email submitter in live mode", () => {
    expect(pickSubmitter(liveEnv, makeTakedown(), makeProvider())?.kind).toBe("email");
  });

  it("returns null when no submitter matches, in any mode", () => {
    expect(pickSubmitter(draftEnv, makeTakedown(), makeProvider({ abuse_email: null }))).toBeNull();
    expect(pickSubmitter(liveEnv,  makeTakedown(), makeProvider({ abuse_email: null }))).toBeNull();
  });
});

describe("dispatchSubmission", () => {
  it("writes a takedown_submissions audit row on success", async () => {
    const captured: { sql: string; binds: unknown[] }[] = [];
    const env = makeEnv(captured, { TAKEDOWN_SEND_MODE: "draft" });

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
    const env = makeEnv(captured, { TAKEDOWN_SEND_MODE: "draft" });

    const { result } = await dispatchSubmission(
      env, makeTakedown(), makeProvider({ abuse_email: null }),
    );

    expect(result.outcome).toBe("failed");
    expect(result.error_message).toContain("No submitter matched");
    expect(captured).toHaveLength(1);
    // outcome bind position
    expect(captured[0].binds[7]).toBe("failed");
  });

  it("in live mode without a Resend key, records the live submitter's failure", async () => {
    // End-to-end through the dispatcher: live mode selects the email
    // submitter, the send fails (no key), and the audit row carries
    // outcome='failed' — the takedown will stay 'draft' for retry.
    const captured: { sql: string; binds: unknown[] }[] = [];
    const env = makeEnv(captured, { TAKEDOWN_SEND_MODE: "live" });

    const { result } = await dispatchSubmission(env, makeTakedown(), makeProvider());

    expect(result.submitter_kind).toBe("email");
    expect(result.outcome).toBe("failed");
    expect(captured[0].binds[7]).toBe("failed");
  });

  it("catches submitter throws and records outcome='failed'", async () => {
    const captured: { sql: string; binds: unknown[] }[] = [];
    const env = makeEnv(captured, { TAKEDOWN_SEND_MODE: "draft" });

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
