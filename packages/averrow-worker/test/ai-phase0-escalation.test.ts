/**
 * AI strategy Phase 0, task 0c — `platform_ai_calls_failing` escalates by
 * email (BRIEFING_RECIPIENT via Resend) exactly once per group_key, never
 * when createNotification deduped (created === 0), never for other types,
 * never throws, and never changes the alert's 'high' severity.
 *
 * lib/notifications + lib/briefing-email are module-mocked here, which is
 * why this lives apart from ai-phase0.test.ts. The real
 * sendPlatformEscalationEmail is exercised at the bottom via vi.importActual.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const notif = vi.hoisted(() => ({
  createNotification: vi.fn<(...a: unknown[]) => Promise<number>>(),
  recordDelivery: vi.fn<(...a: unknown[]) => Promise<void>>(),
}));
const mail = vi.hoisted(() => ({
  sendPlatformEscalationEmail: vi.fn<(...a: unknown[]) => Promise<{ sent: boolean; error?: string; recipient: string }>>(),
}));
vi.mock("../src/lib/notifications", () => notif);
vi.mock("../src/lib/briefing-email", () => mail);

import {
  emitPlatformNotification,
  renderPlatformAiCallsFailing,
  renderPlatformAiSpendBurst,
  EMAIL_ESCALATION_TYPES,
} from "../src/lib/platform-templates";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

// ═════════════════════════════════════════════════════════════════
// 0c. Email escalation for platform_ai_calls_failing
// ═════════════════════════════════════════════════════════════════

describe("0c. platform_ai_calls_failing email escalation", () => {
  /** Fake D1 that remembers whether an email delivery was recorded. */
  function makeNotifDb(state: { emailed: boolean }) {
    const sqls: string[] = [];
    const db = {
      prepare: (sql: string) => {
        sqls.push(sql);
        const s = {
          bind: () => s,
          first: async () => {
            if (sql.includes("notification_deliveries")) return state.emailed ? { hit: 1 } : null;
            if (sql.includes("FROM notifications")) return { id: "notif_1", user_id: "user_1" };
            return null;
          },
        };
        return s;
      },
    };
    return { db, sqls };
  }

  const rendered = () => renderPlatformAiCallsFailing({
    hours_since_last_call: 5,
    threshold_hours: 2,
    min_attempts: 3,
    failing_agents: [{ agent_id: "analyst", attempted: 9, first_failure_kind: "api_error", first_error: "HTTP 400 credit balance too low" }],
  });

  let state: { emailed: boolean };
  beforeEach(() => {
    state = { emailed: false };
    notif.createNotification.mockReset();
    notif.recordDelivery.mockReset();
    mail.sendPlatformEscalationEmail.mockReset();
    notif.recordDelivery.mockImplementation(async (...a: unknown[]) => {
      if (a[3] === "email" && (a[4] === "attempted" || a[4] === "succeeded")) state.emailed = true;
      if (a[3] === "email" && a[4] === "failed") state.emailed = false;
    });
    mail.sendPlatformEscalationEmail.mockResolvedValue({ sent: true, recipient: "ops@example.test" });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("allowlist is exactly platform_ai_calls_failing, and severity stays 'high' (no incident / public status)", () => {
    expect([...EMAIL_ESCALATION_TYPES]).toEqual(["platform_ai_calls_failing"]);
    expect(rendered().severity).toBe("high");
  });

  it("sends one email and records it on the email channel; a later re-emit for the same group_key sends nothing", async () => {
    const { db } = makeNotifDb(state);
    const env = { DB: db } as never;
    notif.createNotification.mockResolvedValue(1);

    expect(await emitPlatformNotification(env, "platform_ai_calls_failing", rendered())).toBe(1);
    // Next hourly tick: past the 50-min in-app dedupe, so created > 0 again.
    expect(await emitPlatformNotification(env, "platform_ai_calls_failing", rendered())).toBe(1);

    expect(mail.sendPlatformEscalationEmail).toHaveBeenCalledTimes(1);
    const arg = mail.sendPlatformEscalationEmail.mock.calls[0]![1] as Record<string, unknown>;
    expect(arg.severity).toBe("high");
    expect(String(arg.title)).toMatch(/AI calls failing/);
    const emailCalls = notif.recordDelivery.mock.calls.filter((c) => c[3] === "email").map((c) => [c[1], c[2], c[4]]);
    expect(emailCalls).toEqual([["notif_1", "user_1", "attempted"], ["notif_1", "user_1", "succeeded"]]);
    // The in-app notification itself is untouched: still severity high.
    expect((notif.createNotification.mock.calls[0]![1] as { severity: string }).severity).toBe("high");
  });

  it("created === 0 (in-app dedupe hit): no email and no D1 access", async () => {
    const { db, sqls } = makeNotifDb(state);
    notif.createNotification.mockResolvedValue(0);
    expect(await emitPlatformNotification({ DB: db } as never, "platform_ai_calls_failing", rendered())).toBe(0);
    expect(mail.sendPlatformEscalationEmail).not.toHaveBeenCalled();
    expect(sqls).toEqual([]);
  });

  it("types outside the allowlist never email", async () => {
    const { db } = makeNotifDb(state);
    notif.createNotification.mockResolvedValue(1);
    await emitPlatformNotification({ DB: db } as never, "platform_ai_spend_burst", renderPlatformAiSpendBurst({
      spent_24h_usd: 50, top_agent: "analyst", top_agent_cost_usd: 40, threshold_usd: 20,
    }));
    expect(mail.sendPlatformEscalationEmail).not.toHaveBeenCalled();
  });

  it("a failed send is recorded 'failed' and retried on the next emit", async () => {
    const { db } = makeNotifDb(state);
    notif.createNotification.mockResolvedValue(1);
    mail.sendPlatformEscalationEmail
      .mockResolvedValueOnce({ sent: false, error: "HTTP 403 / domain not verified", recipient: "x" })
      .mockResolvedValueOnce({ sent: true, recipient: "x" });

    await emitPlatformNotification({ DB: db } as never, "platform_ai_calls_failing", rendered());
    await emitPlatformNotification({ DB: db } as never, "platform_ai_calls_failing", rendered());

    expect(mail.sendPlatformEscalationEmail).toHaveBeenCalledTimes(2);
    const statuses = notif.recordDelivery.mock.calls.filter((c) => c[3] === "email").map((c) => c[4]);
    expect(statuses).toEqual(["attempted", "failed", "attempted", "succeeded"]);
  });

  it("never throws out of the emit path when the email transport throws", async () => {
    const { db } = makeNotifDb(state);
    notif.createNotification.mockResolvedValue(1);
    mail.sendPlatformEscalationEmail.mockRejectedValue(new Error("resend exploded"));
    await expect(emitPlatformNotification({ DB: db } as never, "platform_ai_calls_failing", rendered())).resolves.toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════
// The real helper (lib/briefing-email.ts sendPlatformEscalationEmail)
// ═════════════════════════════════════════════════════════════════

describe("sendPlatformEscalationEmail (real)", () => {
  type Real = typeof import("../src/lib/briefing-email");
  const load = () => vi.importActual<Real>("../src/lib/briefing-email");
  const alert = {
    title: "AI calls failing — 9 attempted, 0 succeeded",
    message: "msg <b>escaped</b>",
    recommended_action: "check credit",
    severity: "high",
    link: "/agents",
  };
  const kv = { get: vi.fn(), put: vi.fn() };

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("sends one Resend request to BRIEFING_RECIPIENT with an absolute /v2 link and escaped body", async () => {
    const { sendPlatformEscalationEmail } = await load();
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ id: "re_1" }), { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const r = await sendPlatformEscalationEmail(
      { RESEND_API_KEY: "re_key", BRIEFING_RECIPIENT: "ops@example.test", CACHE: kv } as never, alert);

    expect(r).toMatchObject({ sent: true, id: "re_1", recipient: "ops@example.test" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe("https://api.resend.com/emails");
    const body = JSON.parse(init.body) as { to: string[]; subject: string; html: string };
    expect(body.to).toEqual(["ops@example.test"]);
    expect(body.subject).toBe("[Averrow HIGH] AI calls failing — 9 attempted, 0 succeeded");
    expect(body.html).toContain("https://averrow.com/v2/agents");
    expect(body.html).not.toContain("<b>escaped</b>");
  });

  it("no RESEND_API_KEY → sent:false, no request", async () => {
    const { sendPlatformEscalationEmail } = await load();
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const r = await sendPlatformEscalationEmail({ CACHE: kv } as never, alert);
    expect(r.sent).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a network throw comes back as sent:false, never a throw", async () => {
    const { sendPlatformEscalationEmail } = await load();
    globalThis.fetch = vi.fn(async () => { throw new Error("socket hang up"); }) as unknown as typeof fetch;
    await expect(sendPlatformEscalationEmail({ RESEND_API_KEY: "k", CACHE: kv } as never, alert))
      .resolves.toMatchObject({ sent: false, error: "socket hang up" });
  });
});
