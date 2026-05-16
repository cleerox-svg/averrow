import { describe, it, expect } from "vitest";
import {
  interpretAuth,
  buildFindings,
  type DeterminationContextForFindings,
} from "../src/lib/abuse-mailbox-responder";

// ─── interpretAuth ──────────────────────────────────────────────

describe("interpretAuth", () => {
  it("returns null when no auth verdicts are present", () => {
    expect(interpretAuth(null, "phishing")).toBeNull();
    expect(interpretAuth(undefined, "phishing")).toBeNull();
    expect(interpretAuth({ spf: null, dkim: null, dmarc: null }, "phishing")).toBeNull();
  });

  it("for confirmed phishing with all-fail auth: leans into impersonation language", () => {
    const s = interpretAuth({ spf: "fail", dkim: "fail", dmarc: "fail" }, "phishing");
    expect(s).toMatch(/impersonated/i);
  });

  it("for confirmed phishing with all-pass auth: notes attacker controls the domain", () => {
    const s = interpretAuth({ spf: "pass", dkim: "pass", dmarc: "pass" }, "phishing");
    expect(s).toMatch(/controls/i);
  });

  it("for benign with all-pass auth: reassures the recipient", () => {
    const s = interpretAuth({ spf: "pass", dkim: "pass", dmarc: "pass" }, "benign");
    expect(s).toMatch(/legitimate sender/i);
  });

  it("for benign with all-fail auth: still flags the spoof concern", () => {
    const s = interpretAuth({ spf: "fail", dkim: "fail", dmarc: "fail" }, "benign");
    expect(s).toMatch(/wasn't actually sent/i);
  });

  it("mixed pass + fail gets the forward/relay language", () => {
    const s = interpretAuth({ spf: "pass", dkim: "fail", dmarc: "pass" }, "phishing");
    expect(s).toMatch(/mixed results/i);
  });

  it("'none' verdicts (no policy run) produce the no-strong-signal line", () => {
    const s = interpretAuth({ spf: "none", dkim: "none", dmarc: "none" }, "spam");
    expect(s).toMatch(/didn't produce a strong signal/i);
  });
});

// ─── buildFindings ──────────────────────────────────────────────

function mkCtx(over: Partial<DeterminationContextForFindings>): DeterminationContextForFindings {
  return {
    messageId: "msg-1",
    originalSubject: "Test",
    classification: "phishing",
    confidence: 92,
    reasoning: "looks bad",
    action: "takedown",
    ...over,
  };
}

describe("buildFindings", () => {
  it("returns [] when no extra context is provided", () => {
    expect(buildFindings(mkCtx({}))).toEqual([]);
  });

  it("renders the auth bullet when verdicts are present", () => {
    const out = buildFindings(mkCtx({
      authResults: { spf: "fail", dkim: "fail", dmarc: "fail" },
    }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/impersonated/i);
  });

  it("for confirmed verdicts with promoted URLs: surfaces 'platform smarter' framing", () => {
    const out = buildFindings(mkCtx({
      classification: "phishing",
      urlCount: 3,
      promotedCount: 3,
    }));
    expect(out.join(" ")).toMatch(/3 links? in the message/);
    expect(out.join(" ")).toMatch(/threat intelligence/i);
    expect(out.join(" ")).toMatch(/platform smarter/i);
  });

  it("for benign verdict with URLs: surfaces 'no matches' line", () => {
    const out = buildFindings(mkCtx({
      classification: "benign",
      urlCount: 2,
      promotedCount: 0,
    }));
    expect(out.join(" ")).toMatch(/2 links? in the message/);
    expect(out.join(" ")).toMatch(/no matches|none matched/i);
  });

  it("for spam verdict with URLs: surfaces the commercial framing", () => {
    const out = buildFindings(mkCtx({
      classification: "spam",
      urlCount: 5,
      promotedCount: 0,
    }));
    expect(out.join(" ")).toMatch(/mostly commercial/i);
  });

  it("attachment line fires when attachmentCount > 0", () => {
    const out = buildFindings(mkCtx({
      classification: "malware",
      attachmentCount: 1,
    }));
    expect(out.join(" ")).toMatch(/1 attachment .* malicious/i);
  });

  it("attachment line uses neutral language for non-malware verdicts", () => {
    const out = buildFindings(mkCtx({
      classification: "benign",
      attachmentCount: 2,
    }));
    expect(out.join(" ")).toMatch(/2 attachments were inspected/);
  });

  it("correlation line fires only when count > 0 and references campaign tracking", () => {
    const out = buildFindings(mkCtx({
      classification: "phishing",
      correlatedCount: 4,
    }));
    expect(out.join(" ")).toMatch(/4 indicators in this message match/);
    expect(out.join(" ")).toMatch(/ongoing campaign/i);
  });

  it("zero counts suppress their bullets entirely", () => {
    const out = buildFindings(mkCtx({
      classification: "phishing",
      urlCount: 0,
      attachmentCount: 0,
      correlatedCount: 0,
      promotedCount: 0,
    }));
    expect(out).toEqual([]);
  });

  it("singular vs plural noun agreement", () => {
    const singular = buildFindings(mkCtx({
      classification: "phishing", urlCount: 1, promotedCount: 1,
    })).join(" ");
    const plural = buildFindings(mkCtx({
      classification: "phishing", urlCount: 5, promotedCount: 3,
    })).join(" ");
    expect(singular).toMatch(/1 link in the message/);
    expect(singular).toMatch(/1 new indicator has/);
    expect(plural).toMatch(/5 links in the message/);
    expect(plural).toMatch(/3 new indicators have/);
  });

  it("full happy path renders auth + URLs + correlation in order", () => {
    const out = buildFindings(mkCtx({
      classification: "phishing",
      authResults: { spf: "fail", dkim: "fail", dmarc: "fail" },
      urlCount: 3,
      attachmentCount: 1,
      correlatedCount: 2,
      promotedCount: 3,
    }));
    expect(out).toHaveLength(4);
    expect(out[0]).toMatch(/impersonated/i);
    expect(out[1]).toMatch(/3 links/);
    expect(out[2]).toMatch(/1 attachment/);
    expect(out[3]).toMatch(/2 indicators .* match/);
  });
});
