import { describe, it, expect } from "vitest";
import {
  buildClassifyPrompt,
  parseClassifyResult,
  severityFor,
  type AbuseClassifyContext,
} from "../src/lib/abuse-mailbox-classifier";

describe("buildClassifyPrompt", () => {
  it("formats a phishing-style message with brand context", () => {
    const ctx: AbuseClassifyContext = {
      original_from:         "billing@acme-secure.example",
      original_subject:      "URGENT: Your account will be suspended",
      original_body_snippet: "Click here to verify your password",
      url_count:             3,
      attachment_count:      0,
      brand_name:            "Acme",
      brand_domain:          "acme.com",
    };
    const prompt = buildClassifyPrompt(ctx);
    expect(prompt).toContain("Customer brand: Acme (acme.com)");
    expect(prompt).toContain("From: billing@acme-secure.example");
    expect(prompt).toContain("Subject: URGENT: Your account will be suspended");
    expect(prompt).toContain("URLs in body: 3");
    expect(prompt).toContain("Attachments: 0");
    expect(prompt).toContain("Click here to verify your password");
    expect(prompt.endsWith("Return JSON.")).toBe(true);
  });

  it("omits brand line when brand is null", () => {
    const prompt = buildClassifyPrompt({
      original_from:         "spam@example.com",
      original_subject:      "Buy gift cards",
      original_body_snippet: null,
      url_count:             1,
      attachment_count:      0,
      brand_name:            null,
      brand_domain:          null,
    });
    expect(prompt).not.toContain("Customer brand:");
    expect(prompt).toContain("From: spam@example.com");
  });

  it("truncates body snippet to 1500 chars", () => {
    const sentinel = "Z".repeat(5000);   // unique char so we count only the snippet
    const prompt = buildClassifyPrompt({
      original_from:         null,
      original_subject:      null,
      original_body_snippet: sentinel,
      url_count:             0,
      attachment_count:      0,
      brand_name:            null,
      brand_domain:          null,
    });
    const zCount = (prompt.match(/Z/g) ?? []).length;
    expect(zCount).toBe(1500);
  });
});

describe("parseClassifyResult", () => {
  it("accepts a fully-formed verdict", () => {
    const result = parseClassifyResult({
      classification: "phishing",
      action:         "takedown",
      confidence:     85,
      reasoning:      "Lookalike domain harvesting credentials.",
    });
    expect(result).toEqual({
      classification: "phishing",
      action:         "takedown",
      confidence:     85,
      reasoning:      "Lookalike domain harvesting credentials.",
    });
  });

  it("rejects unknown classification", () => {
    expect(parseClassifyResult({
      classification: "wat",
      action:         "review",
      confidence:     50,
      reasoning:      "ok",
    })).toBeNull();
  });

  it("rejects unknown action", () => {
    expect(parseClassifyResult({
      classification: "phishing",
      action:         "destroy",
      confidence:     50,
      reasoning:      "ok",
    })).toBeNull();
  });

  it("rejects out-of-range confidence", () => {
    expect(parseClassifyResult({
      classification: "phishing",
      action:         "review",
      confidence:     150,
      reasoning:      "ok",
    })).toBeNull();
    expect(parseClassifyResult({
      classification: "phishing",
      action:         "review",
      confidence:     -5,
      reasoning:      "ok",
    })).toBeNull();
  });

  it("rejects empty reasoning", () => {
    expect(parseClassifyResult({
      classification: "spam",
      action:         "safe",
      confidence:     20,
      reasoning:      "",
    })).toBeNull();
  });

  it("rounds confidence + caps reasoning length", () => {
    const result = parseClassifyResult({
      classification: "ambiguous",
      action:         "review",
      confidence:     50.7,
      reasoning:      "x".repeat(500),
    });
    expect(result?.confidence).toBe(51);
    expect(result?.reasoning.length).toBeLessThanOrEqual(240);
  });

  it("rejects null + non-objects", () => {
    expect(parseClassifyResult(null)).toBeNull();
    expect(parseClassifyResult("oops")).toBeNull();
    expect(parseClassifyResult(42)).toBeNull();
  });
});

describe("severityFor", () => {
  it("malware always pages — CRITICAL regardless of confidence", () => {
    expect(severityFor("malware", 1)).toBe("CRITICAL");
    expect(severityFor("malware", 99)).toBe("CRITICAL");
  });

  it("phishing escalates by confidence threshold (80)", () => {
    expect(severityFor("phishing", 79)).toBe("MEDIUM");
    expect(severityFor("phishing", 80)).toBe("HIGH");
    expect(severityFor("phishing", 99)).toBe("HIGH");
  });

  it("spam + benign are LOW", () => {
    expect(severityFor("spam", 50)).toBe("LOW");
    expect(severityFor("benign", 50)).toBe("LOW");
  });

  it("ambiguous is MEDIUM (operator review)", () => {
    expect(severityFor("ambiguous", 50)).toBe("MEDIUM");
  });
});
