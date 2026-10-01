/**
 * `checkDomain`'s PER-PROBE answer flags (`lib/domain-checker.ts`).
 *
 * ── Why this file exists ────────────────────────────────────────────
 *
 * Every existing test of the lookalike scanner MOCKS `checkDomain`, so
 * the flags its callers now gate their writes on had no coverage at all:
 * setting `webAnswered = true` unconditionally in the source left all 22
 * behavioural tests green. That is the same self-referential gap the
 * phantom-column round was about — the callers were tested against a
 * hand-written result object rather than against the function.
 *
 * So this drives the real function with a stubbed `fetch`, and asserts
 * the distinction the flags exist to draw:
 *
 *   an ANSWER   — a DoH reply we could parse (including NXDOMAIN), or any
 *                 HTTP response (including 403 / 404 / a redirect)
 *   NO ANSWER   — a timeout, a connection-level failure, a non-ok DoH
 *                 response, or a probe that was never attempted
 *
 * `resolved` is asserted alongside, because its scope is the thing the
 * old doc comment got wrong: it covers `registered` and NOTHING else.
 */

import { describe, it, expect, afterEach, vi } from "vitest";

import { checkDomain } from "../src/lib/domain-checker";

type FetchArgs = Parameters<typeof fetch>;

/** A DoH JSON reply. `answers` empty = a parseable NXDOMAIN-style miss. */
function doh(answers: string[]): Response {
  return new Response(
    JSON.stringify(answers.length ? { Answer: answers.map((data) => ({ data })) } : {}),
    { status: 200, headers: { "content-type": "application/dns-json" } },
  );
}

interface Plan {
  /** A-record query: a reply, or a thrown error / non-ok response. */
  a: Response | Error;
  mx: Response | Error;
  /** https HEAD, then the http fallback. */
  https?: Response | Error;
  http?: Response | Error;
}

function stubFetch(plan: Plan): void {
  vi.stubGlobal("fetch", vi.fn(async (...args: FetchArgs) => {
    const url = String(args[0]);
    const pick = (v: Response | Error | undefined): Response => {
      if (v === undefined) throw new Error("no web probe planned");
      if (v instanceof Error) throw v;
      return v;
    };
    if (url.includes("dns-query")) {
      return pick(url.includes("type=MX") ? plan.mx : plan.a);
    }
    return pick(url.startsWith("https://") ? plan.https : plan.http);
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("checkDomain — the A and MX answer flags", () => {
  it("both probes answer with records: everything is an observation", async () => {
    stubFetch({ a: doh(["1.2.3.4"]), mx: doh(["10 mail.example"]), https: new Response(null, { status: 200 }) });
    const r = await checkDomain("acm3.example");
    expect(r).toMatchObject({
      registered: true, resolved: true,
      aAnswered: true, mxAnswered: true, webAnswered: true,
      ip: "1.2.3.4", hasMx: true, hasWeb: true,
    });
  });

  it("both probes answer with NOTHING: that is still an observation", async () => {
    // A clean NXDOMAIN on both is a finding — "this domain does not
    // exist" — and must be distinguishable from a resolver outage.
    stubFetch({ a: doh([]), mx: doh([]) });
    const r = await checkDomain("acm3.example");
    expect(r).toMatchObject({
      registered: false, resolved: true,
      aAnswered: true, mxAnswered: true,
      hasMx: false, hasWeb: false,
    });
    // No probe was attempted, so there is no web answer either.
    expect(r.webAnswered).toBe(false);
  });

  it("A answers with a record while MX times out: resolved, but hasMx means nothing", async () => {
    // THE CASE that erased stored MX evidence. A SEEN A record
    // short-circuits `resolved`, so the caller used to treat
    // `hasMx: false` as authoritative and write 0 over a known 1.
    stubFetch({
      a: doh(["1.2.3.4"]),
      mx: new Error("timeout"),
      https: new Response(null, { status: 200 }),
    });
    const r = await checkDomain("acm3.example");
    expect(r.registered).toBe(true);
    expect(r.resolved).toBe(true);
    expect(r.aAnswered).toBe(true);
    // The flag is what tells the caller not to persist `hasMx`.
    expect(r.mxAnswered).toBe(false);
    expect(r.hasMx).toBe(false);
  });

  it("MX answers with a record while A times out: resolved, but ip is absent", async () => {
    // THE CASE that erased a known IP. `result.ip ?? null` wrote NULL
    // over `resolves_to`, which drops the row out of both page-analysis
    // cohorts (they require `resolves_to IS NOT NULL`).
    stubFetch({
      a: new Error("timeout"),
      mx: doh(["10 mail.example"]),
      https: new Response(null, { status: 200 }),
    });
    const r = await checkDomain("acm3.example");
    expect(r.registered).toBe(true);
    expect(r.resolved).toBe(true);
    expect(r.aAnswered).toBe(false);
    expect(r.ip).toBeUndefined();
    expect(r.mxAnswered).toBe(true);
    expect(r.hasMx).toBe(true);
  });

  it("A answers NOTHING while MX times out: NOT resolved", async () => {
    // The one case where `resolved` is false: nothing was found AND a
    // probe failed, so an MX-only registration cannot be ruled out —
    // which is exactly the BEC-precursor shape.
    stubFetch({ a: doh([]), mx: new Error("timeout") });
    const r = await checkDomain("acm3.example");
    expect(r.resolved).toBe(false);
    expect(r.registered).toBe(false);
  });

  it("a non-ok DoH response is NOT an answer", async () => {
    // The `!res.ok` half: the `if (res.ok)` block is simply not taken,
    // so no flag is set and no record is read.
    stubFetch({ a: new Response("rate limited", { status: 429 }), mx: doh([]) });
    const r = await checkDomain("acm3.example");
    expect(r.aAnswered).toBe(false);
    expect(r.mxAnswered).toBe(true);
    expect(r.resolved).toBe(false);
  });
});

describe("checkDomain — the WEB answer flag", () => {
  // A FUNCTION, not a shared const: a `Response` body is single-use, so
  // one object reused across tests reads as consumed on the second and
  // the DNS half silently reports "nothing found".
  const registered = (): Pick<Plan, "a" | "mx"> => ({ a: doh(["1.2.3.4"]), mx: doh([]) });

  it("a 200 is an answer: hasWeb true", async () => {
    stubFetch({ ...registered(), https: new Response(null, { status: 200 }) });
    const r = await checkDomain("acm3.example");
    expect(r.webAnswered).toBe(true);
    expect(r.hasWeb).toBe(true);
  });

  for (const status of [301, 403, 404, 500]) {
    it(`a ${status} is an ANSWER — there is a server there`, async () => {
      // Explicit per the contract: only a connection-level failure is
      // unanswered. A 403 from a WAF or a 404 from a parked host is a
      // web server, and is also a real observation either way.
      stubFetch({ ...registered(), https: new Response(null, { status }) });
      const r = await checkDomain("acm3.example");
      expect(r.webAnswered).toBe(true);
      expect(r.hasWeb).toBe(true);
    });
  }

  it("https fails but the http fallback answers: answered", async () => {
    stubFetch({
      ...registered(),
      https: new Error("TLS handshake failed"),
      http: new Response(null, { status: 200 }),
    });
    const r = await checkDomain("acm3.example");
    expect(r.webAnswered).toBe(true);
    expect(r.hasWeb).toBe(true);
  });

  it("BOTH probes fail at the connection level: NOT an answer", async () => {
    // THE DEFECT. Both branches ended in a bare `catch {}`, so a 3 s
    // timeout, a TCP reset, a TLS failure and a tarpit were all
    // indistinguishable from "serves nothing" — and the caller wrote
    // `has_web = 0` over a known 1, removing the row from the only
    // producer that could still alert on it.
    stubFetch({
      ...registered(),
      https: new Error("timeout"),
      http: new Error("ECONNRESET"),
    });
    const r = await checkDomain("acm3.example");
    expect(r.hasWeb).toBe(false);
    // ...and `hasWeb: false` is now marked as a default, not a finding.
    expect(r.webAnswered).toBe(false);
    // The DNS half of the check is unaffected and still authoritative.
    expect(r.registered).toBe(true);
    expect(r.resolved).toBe(true);
  });

  it("an unregistered domain gets no web probe, so no web answer", async () => {
    stubFetch({ a: doh([]), mx: doh([]) });
    const r = await checkDomain("acm3.example");
    expect(r.webAnswered).toBe(false);
    expect(r.hasWeb).toBe(false);
  });
});
