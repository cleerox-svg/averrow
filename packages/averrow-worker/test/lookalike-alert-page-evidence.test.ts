/**
 * Lane 3 Phase 3 step 16 — page evidence on `lookalike_domain_active`
 * alerts.
 *
 * `buildPageEvidenceDetails` is the pure slice of the scanner's
 * `createAlert` details object. The page-analysis result was already in
 * scope at the alert site and was discarded; these tests lock what is
 * now carried, what is deliberately NOT carried, and that a skipped or
 * failed analysis degrades to an empty spread rather than regressing
 * alert creation.
 */

import { describe, it, expect } from "vitest";
import { buildPageEvidenceDetails } from "../src/scanners/lookalike-domains";
import type { PagePhishingResult } from "../src/lib/page-phishing-scorer";

function makePhishing(over: Partial<PagePhishingResult> = {}): PagePhishingResult {
  return {
    score: 75,
    signals: ["credential_form", "offdomain_form_exfil"],
    credentialHarvest: true,
    antiBotWallFamily: "turnstile",
    // Lane 3 shadow output — computed, persisted, never acted on.
    aiSignals: ["covert_exfil_sink", "todo_comment"],
    scoreDelta: 20,
    evidence: {
      covert_exfil_sink: "https://api.telegram.org/bot7654321:AAF/sendMessage",
      todo_comment: "<!-- TODO: replace with real logo -->",
    },
    pageGenerator: "Lovable",
    exfilSink: "api.telegram.org",
    exfilSinkId: "7654321:AAF",
    ...over,
  };
}

describe("buildPageEvidenceDetails", () => {
  it("carries fired signals, score, wall family and shadow signals", () => {
    expect(buildPageEvidenceDetails(makePhishing())).toEqual({
      page_signals: ["credential_form", "offdomain_form_exfil"],
      page_score: 75,
      page_anti_bot_wall: "turnstile",
      page_ai_signals: ["covert_exfil_sink", "todo_comment"],
      page_score_delta: 20,
    });
  });

  it("returns an empty object when page analysis did not run or failed", () => {
    // `phishing` is null for a non-web domain, an exhausted inline
    // budget, an SSRF block, a non-HTML/oversize body, or a thrown
    // fetch. Spreading {} must leave the rest of `details` untouched.
    const details = {
      lookalike_domain: "acm3.com",
      original_domain: "acme.com",
      ...buildPageEvidenceDetails(null),
    };
    expect(buildPageEvidenceDetails(null)).toEqual({});
    expect(details).toEqual({
      lookalike_domain: "acm3.com",
      original_domain: "acme.com",
    });
  });

  it("omits page_evidence, exfil sink and sink id — attacker-controlled literals", () => {
    // Alert details reach customer surfaces and email digests. Every
    // field carried above has a closed vocabulary; these three do not.
    const details = buildPageEvidenceDetails(makePhishing());
    const serialized = JSON.stringify(details);
    expect(details).not.toHaveProperty("page_evidence");
    expect(details).not.toHaveProperty("page_exfil_sink");
    expect(details).not.toHaveProperty("page_exfil_sink_id");
    expect(details).not.toHaveProperty("page_generator");
    expect(serialized).not.toContain("api.telegram.org");
    expect(serialized).not.toContain("TODO");
    expect(serialized).not.toContain("7654321");
  });

  it("keeps the shadow delta separate from the score — promotes nothing", () => {
    const details = buildPageEvidenceDetails(makePhishing({ score: 30, scoreDelta: 45 }));
    expect(details.page_score).toBe(30);
    expect(details.page_score_delta).toBe(45);
    // The would-be combined value must never appear as the score.
    expect(details.page_score).not.toBe(75);
  });

  it("handles a clean, fetched page — empty arrays, null wall, zero delta", () => {
    expect(buildPageEvidenceDetails(makePhishing({
      score: 0,
      signals: [],
      credentialHarvest: false,
      antiBotWallFamily: null,
      aiSignals: [],
      scoreDelta: 0,
      evidence: {},
      pageGenerator: null,
      exfilSink: null,
      exfilSinkId: null,
    }))).toEqual({
      page_signals: [],
      page_score: 0,
      page_anti_bot_wall: null,
      page_ai_signals: [],
      page_score_delta: 0,
    });
  });

  it("is distinguishable from 'never analyzed' — {} vs a zeroed object", () => {
    // A clean scan and a skipped scan must not look alike to the
    // consumer (spec §3.5 empty-state rule, applied at alert scope).
    const clean = buildPageEvidenceDetails(makePhishing({
      score: 0, signals: [], aiSignals: [], scoreDelta: 0, antiBotWallFamily: null,
    }));
    expect(Object.keys(clean)).toHaveLength(5);
    expect(Object.keys(buildPageEvidenceDetails(null))).toHaveLength(0);
  });
});
