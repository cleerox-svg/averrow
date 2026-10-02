import { describe, it, expect } from "vitest";
import {
  decideAbuseMailboxThrottle,
  extractSenderDomain,
  extractSenderRegDomain,
  PER_SENDER_HOURLY_THRESHOLD,
  PER_DOMAIN_HOURLY_THRESHOLD,
  PER_ORG_HOURLY_THRESHOLD,
  GLOBAL_HOURLY_THRESHOLD,
} from "../src/lib/abuse-mailbox-throttle";
import type { Env } from "../src/types";

// ─── In-memory D1 stub ──────────────────────────────────────────
//
// The throttle decider issues up to four capped COUNT(*) queries against
// abuse_inbox_messages — by forwarded_by_email, forwarded_by_reg_domain,
// org_id, and globally. The stub answers by SQL marker and records binds
// so the tests can assert WHICH key each dimension used.

interface CountStubConfig {
  senderCount?: number;
  domainCount?: number;
  orgCount?: number;
  globalCount?: number;
}

function mkEnv(cfg: CountStubConfig, calls: Array<{ sql: string; binds: unknown[] }> = []): Env {
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          calls.push({ sql, binds });
          return {
            async first<T>(): Promise<T> {
              if (sql.includes("forwarded_by_email = ?")) return { n: cfg.senderCount ?? 0 } as T;
              if (sql.includes("forwarded_by_reg_domain = ?")) return { n: cfg.domainCount ?? 0 } as T;
              if (sql.includes("org_id = ?")) return { n: cfg.orgCount ?? 0 } as T;
              return { n: cfg.globalCount ?? 0 } as T;
            },
          };
        },
      };
    },
  };
  return { DB: db } as unknown as Env;
}

describe("extractSenderDomain / extractSenderRegDomain", () => {
  it("returns the domain portion lower-cased", () => {
    expect(extractSenderDomain("Alice@Example.COM")).toBe("example.com");
  });
  it("returns null for malformed input", () => {
    expect(extractSenderDomain("not-an-email")).toBeNull();
    expect(extractSenderDomain("@nope")).toBeNull();
    expect(extractSenderDomain("nope@")).toBeNull();
    expect(extractSenderDomain("")).toBeNull();
    expect(extractSenderDomain(null)).toBeNull();
    expect(extractSenderDomain(undefined)).toBeNull();
  });
  it("handles emails with multiple @ by taking the last one", () => {
    expect(extractSenderDomain("weird@local@domain.com")).toBe("domain.com");
  });
  it("reduces to the registrable domain", () => {
    expect(extractSenderRegDomain("a@mx1.mail.bad.example")).toBe("bad.example");
    expect(extractSenderRegDomain("a@x.bad.co.uk")).toBe("bad.co.uk");
  });
});

describe("decideAbuseMailboxThrottle", () => {
  it("passes when every dimension is well under its cap", async () => {
    const env = mkEnv({ senderCount: 1, domainCount: 5, orgCount: 10, globalCount: 50 });
    const d = await decideAbuseMailboxThrottle(env, "alice@example.com", { orgId: 7 });
    expect(d.throttled).toBe(false);
    expect(d.reason).toBeNull();
    expect(d).toMatchObject({
      sender_count_last_window: 1, domain_count_last_window: 5,
      org_count_last_window: 10, global_count_last_window: 50,
      sender_email: "alice@example.com", sender_domain: "example.com", sender_reg_domain: "example.com",
    });
  });

  it("keys the domain rule on the REGISTRABLE domain (rotating subdomains share a bucket)", async () => {
    const calls: Array<{ sql: string; binds: unknown[] }> = [];
    const env = mkEnv({ domainCount: PER_DOMAIN_HOURLY_THRESHOLD }, calls);
    const d = await decideAbuseMailboxThrottle(env, "bot@a17.mailer.bad.example", { orgId: 7 });
    expect(d.reason).toBe("domain_rate_limit");
    const domainCall = calls.find((c) => c.sql.includes("forwarded_by_reg_domain = ?"))!;
    expect(domainCall.binds[0]).toBe("bad.example");
    // every count reads at most `cap` rows
    expect(domainCall.binds[1]).toBe(PER_DOMAIN_HOURLY_THRESHOLD);
    expect(domainCall.sql).toMatch(/LIMIT \?/);
  });

  it("throttles by sender rule when sender count >= threshold", async () => {
    const env = mkEnv({ senderCount: PER_SENDER_HOURLY_THRESHOLD, domainCount: 30 });
    const d = await decideAbuseMailboxThrottle(env, "bot@example.com");
    expect(d.throttled).toBe(true);
    expect(d.reason).toBe("sender_rate_limit");
  });

  it("attributes to the most specific rule when several fire", async () => {
    const env = mkEnv({
      senderCount: PER_SENDER_HOURLY_THRESHOLD, domainCount: PER_DOMAIN_HOURLY_THRESHOLD,
      orgCount: PER_ORG_HOURLY_THRESHOLD, globalCount: GLOBAL_HOURLY_THRESHOLD,
    });
    expect((await decideAbuseMailboxThrottle(env, "spammer@bad.example", { orgId: 1 })).reason).toBe("sender_rate_limit");
  });

  it("per-org cap fires when sender/domain rotate", async () => {
    const env = mkEnv({ senderCount: 1, domainCount: 1, orgCount: PER_ORG_HOURLY_THRESHOLD });
    const d = await decideAbuseMailboxThrottle(env, "rotating1@fresh.example", { orgId: 9 });
    expect(d).toMatchObject({ throttled: true, reason: "org_rate_limit" });
  });

  it("global cap fires across all orgs", async () => {
    const env = mkEnv({ globalCount: GLOBAL_HOURLY_THRESHOLD });
    const d = await decideAbuseMailboxThrottle(env, "a@fresh.example", { orgId: 9 });
    expect(d).toMatchObject({ throttled: true, reason: "global_rate_limit" });
  });

  it("no sender: sender/domain rules skip, but org + global caps still apply", async () => {
    const quiet = await decideAbuseMailboxThrottle(mkEnv({ senderCount: 99, domainCount: 99 }), null, { orgId: 3 });
    expect(quiet.throttled).toBe(false);
    expect(quiet.sender_email).toBeNull();
    expect(quiet.sender_domain).toBeNull();
    const flood = await decideAbuseMailboxThrottle(mkEnv({ orgCount: PER_ORG_HOURLY_THRESHOLD }), null, { orgId: 3 });
    expect(flood.reason).toBe("org_rate_limit");
  });

  it("threshold is inclusive; threshold minus one does NOT fire", async () => {
    expect((await decideAbuseMailboxThrottle(mkEnv({ senderCount: PER_SENDER_HOURLY_THRESHOLD }), "e@example.com")).reason)
      .toBe("sender_rate_limit");
    const d = await decideAbuseMailboxThrottle(mkEnv({
      senderCount: PER_SENDER_HOURLY_THRESHOLD - 1, domainCount: PER_DOMAIN_HOURLY_THRESHOLD - 1,
      orgCount: PER_ORG_HOURLY_THRESHOLD - 1, globalCount: GLOBAL_HOURLY_THRESHOLD - 1,
    }), "e@example.com", { orgId: 1 });
    expect(d.throttled).toBe(false);
  });
});
