import { describe, it, expect } from "vitest";
import {
  decideAbuseMailboxThrottle,
  extractSenderDomain,
  PER_SENDER_HOURLY_THRESHOLD,
  PER_DOMAIN_HOURLY_THRESHOLD,
} from "../src/lib/abuse-mailbox-throttle";
import type { Env } from "../src/types";

// ─── In-memory D1 stub ──────────────────────────────────────────
//
// The throttle decider issues two parallel COUNT(*) queries against
// abuse_inbox_messages — one filtered by forwarded_by_email, one by
// forwarded_by_domain. We don't need a real SQLite engine here; we
// just need a prepare/bind/first pair that returns the canned counts
// the test set up.

interface CountStubConfig {
  senderCount: number;
  domainCount: number;
}

function mkEnv(cfg: CountStubConfig): Env {
  const db = {
    prepare(sql: string) {
      const isSenderQuery = sql.includes("forwarded_by_email");
      const isDomainQuery = sql.includes("forwarded_by_domain");
      return {
        bind(_value: string) {
          return {
            async first<T>(): Promise<T> {
              if (isSenderQuery) return { n: cfg.senderCount } as T;
              if (isDomainQuery) return { n: cfg.domainCount } as T;
              return { n: 0 } as T;
            },
          };
        },
      };
    },
  };
  return { DB: db } as unknown as Env;
}

describe("extractSenderDomain", () => {
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
});

describe("decideAbuseMailboxThrottle", () => {
  it("passes when sender + domain are well under thresholds", async () => {
    const env = mkEnv({ senderCount: 1, domainCount: 5 });
    const d = await decideAbuseMailboxThrottle(env, "alice@example.com");
    expect(d.throttled).toBe(false);
    expect(d.reason).toBeNull();
    expect(d.sender_count_last_window).toBe(1);
    expect(d.domain_count_last_window).toBe(5);
    expect(d.sender_email).toBe("alice@example.com");
    expect(d.sender_domain).toBe("example.com");
  });

  it("throttles by sender rule when sender count >= threshold", async () => {
    const env = mkEnv({ senderCount: PER_SENDER_HOURLY_THRESHOLD, domainCount: 30 });
    const d = await decideAbuseMailboxThrottle(env, "bot@example.com");
    expect(d.throttled).toBe(true);
    expect(d.reason).toBe("sender_rate_limit");
  });

  it("throttles by domain rule when sender is under but domain is over", async () => {
    const env = mkEnv({ senderCount: 5, domainCount: PER_DOMAIN_HOURLY_THRESHOLD });
    const d = await decideAbuseMailboxThrottle(env, "alice@bad.example");
    expect(d.throttled).toBe(true);
    expect(d.reason).toBe("domain_rate_limit");
  });

  it("attributes to the sender rule when both fire (more specific)", async () => {
    const env = mkEnv({
      senderCount: PER_SENDER_HOURLY_THRESHOLD + 5,
      domainCount: PER_DOMAIN_HOURLY_THRESHOLD + 100,
    });
    const d = await decideAbuseMailboxThrottle(env, "spammer@bad.example");
    expect(d.throttled).toBe(true);
    expect(d.reason).toBe("sender_rate_limit");
  });

  it("passes through when sender email is null (no rate-limit dimension)", async () => {
    const env = mkEnv({ senderCount: 99, domainCount: 99 });
    const d = await decideAbuseMailboxThrottle(env, null);
    expect(d.throttled).toBe(false);
    expect(d.reason).toBeNull();
    expect(d.sender_email).toBeNull();
    expect(d.sender_domain).toBeNull();
  });

  it("threshold is inclusive — count == threshold fires the rule", async () => {
    const env = mkEnv({ senderCount: PER_SENDER_HOURLY_THRESHOLD, domainCount: 0 });
    const d = await decideAbuseMailboxThrottle(env, "edge@example.com");
    expect(d.throttled).toBe(true);
    expect(d.reason).toBe("sender_rate_limit");
  });

  it("threshold minus one does NOT fire", async () => {
    const env = mkEnv({ senderCount: PER_SENDER_HOURLY_THRESHOLD - 1, domainCount: PER_DOMAIN_HOURLY_THRESHOLD - 1 });
    const d = await decideAbuseMailboxThrottle(env, "edge@example.com");
    expect(d.throttled).toBe(false);
  });
});
