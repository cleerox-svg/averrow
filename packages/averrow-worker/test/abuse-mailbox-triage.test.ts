/**
 * Abuse-mailbox per-message triage: rules pass → sleep → exactly-once
 * determination, against a migration-derived SQLite schema (so every
 * column the new SQL names must really exist).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Env } from "../src/types";
import { runAbuseTriagePipeline, DETERMINATION_DELAY, type TriageStep } from "../src/lib/abuse-mailbox-triage-pipeline";
import { runAbuseRulesPass } from "../src/lib/abuse-mailbox-rules-runner";
import { deliverAbuseDetermination, sweepAbuseDeterminations } from "../src/lib/abuse-mailbox-determination";
import { runAbuseClassifierBackfill } from "../src/lib/abuse-mailbox-classifier";
import { hasSqlite, openDerivedDb, d1FromSqlite, fakeKv, type SqliteDb } from "./sqlite-d1-harness";

interface ResendCall { to: string[]; subject: string; html: string; text: string }

const realFetch = globalThis.fetch;
let resendCalls: ResendCall[];
let resendStatus: number;

beforeEach(() => {
  resendCalls = [];
  resendStatus = 200;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://api.resend.com/emails") {
      resendCalls.push(JSON.parse(String(init?.body)) as ResendCall);
      return new Response(JSON.stringify({ id: "re_1" }), { status: resendStatus });
    }
    return new Response("unexpected fetch", { status: 500 });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const ATTACKER_SUBJECT_TOKEN = "zz-attacker-subject-token";

function setup(): { raw: SqliteDb; env: Env } {
  const raw = openDerivedDb(["abuse_inbox_messages", "threats", "brands", "named_threats", "email_optouts"]);
  // Notifications, branding and other tables are outside the unit.
  const db = d1FromSqlite(raw, {
    swallow: (sql) => /notification|org_abuse_branding|abuse_branding|users|org_members|FROM organizations/i.test(sql),
  });
  const env = { DB: db, CACHE: fakeKv(), AI_MODE: "rules_only", RESEND_API_KEY: "re_test" } as unknown as Env;
  return { raw, env };
}

function insertMessage(raw: SqliteDb, id: string, over: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id,
    org_id: 1,
    brand_id: null,
    forwarded_by_email: "reporter@customer.test",
    inbound_alias: "verify-acme@averrow.com",
    original_from: "notify@bad-acme.example",
    original_subject: `Urgent ${ATTACKER_SUBJECT_TOKEN}`,
    original_body_snippet: "Your account will be locked. Click the link.",
    url_count: 1,
    attachment_count: 0,
    extracted_urls: JSON.stringify([{ url: "https://evil-login.example/verify", domain: "evil-login.example", count: 1 }]),
    attachment_names: "[]",
    auth_results: JSON.stringify({ spf: null, dkim: null, dmarc: null }),
    correlated_threat_ids: "[]",
    classification: "pending",
    ...over,
  };
  const cols = Object.keys(row);
  raw.prepare(
    `INSERT INTO abuse_inbox_messages (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
  ).run(...cols.map((c) => row[c]));
}

function insertThreat(raw: SqliteDb, over: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id: "thr_known",
    source_feed: "openphish",
    threat_type: "phishing",
    malicious_url: "https://evil-login.example/other",
    malicious_domain: "evil-login.example",
    status: "active",
    ...over,
  };
  const cols = Object.keys(row);
  raw.prepare(
    `INSERT INTO threats (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
  ).run(...cols.map((c) => row[c]));
}

function readRow(raw: SqliteDb, id: string): Record<string, unknown> {
  return raw.prepare(
    `SELECT classification, classified_by, severity, ai_action, classification_reason,
            classification_confidence, determination_sent_at, promoted_threat_ids,
            responder_suppressed_reason
       FROM abuse_inbox_messages WHERE id = ?`,
  ).all(id)[0] as Record<string, unknown>;
}

function mockStep(): TriageStep & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async do<T>(name: string, fn: () => Promise<T>): Promise<T> {
      calls.push(`do:${name}`);
      return fn();
    },
    async sleep(name: string, duration: WorkflowSleepDuration): Promise<void> {
      calls.push(`sleep:${name}:${String(duration)}`);
    },
  };
}

describe.skipIf(!hasSqlite())("abuse-mailbox triage workflow pipeline", () => {
  let raw: SqliteDb;
  let env: Env;
  beforeEach(() => { ({ raw, env } = setup()); });

  it("happy path: classify → sleep → send exactly once (M1, rules)", async () => {
    insertThreat(raw);
    insertMessage(raw, "m1");
    const step = mockStep();

    const out = await runAbuseTriagePipeline(env, { messageId: "m1" }, step);

    expect(step.calls).toEqual([
      "do:classify",
      `sleep:await-determination:${String(DETERMINATION_DELAY)}`,
      "do:send-determination",
    ]);
    expect(out).toMatchObject({ rules: "malicious", ai: "skipped", delivery: "sent" });
    const row = readRow(raw, "m1");
    expect(row).toMatchObject({
      classification: "phishing", classified_by: "rules", severity: "HIGH",
      ai_action: "escalate", classification_confidence: 90,
    });
    expect(String(row.classification_reason)).toMatch(/^m1_intel_correlation:1/);
    expect(row.determination_sent_at).not.toBeNull();
    // URL on the matched domain promoted into threats as abuse_mailbox.
    expect(JSON.parse(String(row.promoted_threat_ids))).toHaveLength(1);
    expect(resendCalls).toHaveLength(1);
  });

  it("is idempotent with the cron sweeper: replay + sweep never send twice", async () => {
    insertThreat(raw);
    insertMessage(raw, "m1");
    await runAbuseTriagePipeline(env, { messageId: "m1" }, mockStep());
    // Workflow step replay, then the hourly sweeper.
    expect(await deliverAbuseDetermination(env, "m1")).toBe("already_sent");
    const sweep = await sweepAbuseDeterminations(env);
    expect(sweep.sent).toBe(0);
    await runAbuseTriagePipeline(env, { messageId: "m1" }, mockStep());
    expect(resendCalls).toHaveLength(1);
  });

  it("sweeper delivers when the Workflow never ran, then the late Workflow is a no-op", async () => {
    insertMessage(raw, "m2");
    const pass = await runAbuseRulesPass(env);
    expect(pass).toMatchObject({ scanned: 1, review: 1, malicious: 0 });
    expect(readRow(raw, "m2")).toMatchObject({ classification: "ambiguous", classified_by: "rules", severity: "MEDIUM", ai_action: "review" });

    expect((await sweepAbuseDeterminations(env)).sent).toBe(1);
    const late = await runAbuseTriagePipeline(env, { messageId: "m2" }, mockStep());
    expect(late).toMatchObject({ rules: "not_pending", delivery: "already_sent" });
    expect(resendCalls).toHaveLength(1);
  });

  it("transient send failure releases the claim so the sweeper retries", async () => {
    insertMessage(raw, "m3");
    resendStatus = 503;
    const out = await runAbuseTriagePipeline(env, { messageId: "m3" }, mockStep());
    expect(out.delivery).toBe("send_failed");
    expect(readRow(raw, "m3").determination_sent_at).toBeNull();
    resendStatus = 200;
    expect((await sweepAbuseDeterminations(env)).sent).toBe(1);
    expect(readRow(raw, "m3").determination_sent_at).not.toBeNull();
  });

  it("a backscatter-suppressed row is classified but never emailed", async () => {
    insertMessage(raw, "m4", { responder_suppressed_reason: "backscatter:from_envelope_mismatch" });
    await runAbuseRulesPass(env);
    expect(readRow(raw, "m4").classified_by).toBe("rules");
    expect(await deliverAbuseDetermination(env, "m4")).toBe("not_ready");
    expect((await sweepAbuseDeterminations(env)).candidates).toBe(0);
    expect(resendCalls).toHaveLength(0);
  });

  it("negative M1 cases stay review: abuse_mailbox-sourced and non-active (down) threats", async () => {
    insertThreat(raw, { id: "self", source_feed: "abuse_mailbox", malicious_url: "https://evil-login.example/verify" });
    insertThreat(raw, { id: "old", status: "down" });
    insertMessage(raw, "m5");
    await runAbuseRulesPass(env);
    expect(readRow(raw, "m5")).toMatchObject({ classification: "ambiguous", classified_by: "rules" });
  });

  it("rules determination email: no confidence %, fixed note, no attacker strings beyond the echoed subject block", async () => {
    insertThreat(raw);
    insertMessage(raw, "m6", {
      original_body_snippet: "Pay at https://evil-login.example/verify from 203.0.113.9",
    });
    await runAbuseTriagePipeline(env, { messageId: "m6" }, mockStep());
    expect(resendCalls).toHaveLength(1);
    const { html, text } = resendCalls[0]!;
    for (const body of [html, text]) {
      expect(body).not.toMatch(/\d+% confidence/);
      expect(body).not.toContain("evil-login.example");
      expect(body).not.toContain("203.0.113.9");
      expect(body).not.toContain("m1_intel_correlation");
      expect(body).toContain("Links in this message match infrastructure already confirmed malicious in our threat intelligence.");
      expect(body).toContain("Reported to our threat team");
    }
  });

  it("rules review email leads with the analyst next step", async () => {
    insertMessage(raw, "m7");
    await runAbuseTriagePipeline(env, { messageId: "m7" }, mockStep());
    const { text } = resendCalls[0]!;
    expect(text).toContain("An analyst will review your report; we'll only contact you if we need more context.");
    expect(text).not.toMatch(/% confidence/);
    expect(text).not.toContain("no_intel_match");
  });
});

describe.skipIf(!hasSqlite())("AI pass vs rules verdicts", () => {
  let raw: SqliteDb;
  let env: Env;
  beforeEach(() => { ({ raw, env } = setup()); });

  it("under rules_only the AI pass leaves rules rows untouched", async () => {
    insertMessage(raw, "a1");
    await runAbuseRulesPass(env);
    const r = await runAbuseClassifierBackfill(env);
    expect(r.skipped_rules_only).toBe(true);
    expect(readRow(raw, "a1")).toMatchObject({ classification: "ambiguous", classified_by: "rules" });
  });

  it("with AI enabled, a rules MALICIOUS row is never selected or overwritten, and rules rows are never auto-graduated", async () => {
    insertThreat(raw);
    insertMessage(raw, "a2");                                       // → M1 malicious
    insertMessage(raw, "a3", { extracted_urls: "[]", url_count: 0 }); // → review
    await runAbuseRulesPass(env);
    // Simulate a review row at its last AI attempt.
    raw.prepare(`UPDATE abuse_inbox_messages SET classification_attempts = 2 WHERE id = 'a3'`).run();

    const aiEnv = { ...env, AI_MODE: "enabled" } as unknown as Env;
    // callAnthropic fails (fetch mock returns 500 for non-Resend URLs / no key).
    const r = await runAbuseClassifierBackfill(aiEnv, { deferDetermination: true });
    expect(r.scanned).toBe(1); // only the review row
    expect(readRow(raw, "a2")).toMatchObject({ classification: "phishing", classified_by: "rules" });
    expect(readRow(raw, "a3")).toMatchObject({ classification: "ambiguous", classified_by: "rules" });
  });
});
