import { describe, it, expect } from "vitest";
import {
  normalizePageOutcome,
  PAGE_OUTCOMES,
  type PageOutcome,
} from "../src/lib/page-fetch";

// Lane 3 Phase 2, spec §11.3 + §11.4. `page_last_outcome` (migration
// 0266) is written on BOTH branches of the page-analysis UPDATE so the
// diagnostics breakdown describes the LAST pass rather than the last
// successful one, and so `oversize_declared` stops being folded in with
// `non_html_content_type`.
//
// The value is NORMALIZED rather than the raw `rejectedReason`, because
// three upstream reason strings interpolate — and one of them embeds an
// IP address. These tests pin that normalization, since the column feeds
// a `GROUP BY` whose cardinality is otherwise unbounded.

describe("normalizePageOutcome — bounded vocabulary", () => {
  it("passes through every closed literal unchanged", () => {
    // Each of these is produced verbatim by page-fetch.ts; a rename
    // upstream without a matching entry here should fail loudly rather
    // than silently collapse into `other`.
    const literals: PageOutcome[] = [
      "non_html_content_type",
      "oversize_declared",
      "oversize",
      "unresolvable",
      "unreachable",
      "deadline_exceeded",
      "fetch_error",
      "too_many_redirects",
      "redirect_without_location",
      "bad_redirect_location",
      "unparseable_host",
    ];
    for (const l of literals) {
      expect(normalizePageOutcome(l), l).toBe(l);
    }
  });

  it("keeps oversize_declared separate from oversize and non-HTML", () => {
    // The whole point of §11.4: a declared-oversize skip never spent the
    // bytes, a measured oversize did, and neither is a content-type
    // rejection. Collapsing them is what hid the possible bias against
    // fat AI-builder pages.
    const three = new Set([
      normalizePageOutcome("oversize_declared"),
      normalizePageOutcome("oversize"),
      normalizePageOutcome("non_html_content_type"),
    ]);
    expect(three.size).toBe(3);
  });

  it("collapses the interpolating `static:` form to a stable label", () => {
    expect(normalizePageOutcome("static: loopback literal")).toBe("static_blocked");
    expect(normalizePageOutcome("static: link-local")).toBe("static_blocked");
    // Different reasons, ONE bucket — that is the cardinality guarantee.
    expect(normalizePageOutcome("static: a")).toBe(normalizePageOutcome("static: b"));
  });

  it("collapses the resolved-IP form WITHOUT persisting the IP", () => {
    const out = normalizePageOutcome("resolved 169.254.169.254 blocked: link-local");
    expect(out).toBe("ip_blocked");
    // The specific IP must not survive into the column: it is
    // attacker-influenced, adds nothing analytically (the SSRF logs have
    // it), and would make this a per-IP GROUP BY.
    expect(out).not.toMatch(/169\.254/);
    expect(out).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it("collapses the disallowed-scheme form, protocol not retained", () => {
    expect(normalizePageOutcome("disallowed_scheme: file:")).toBe("disallowed_scheme");
    expect(normalizePageOutcome("disallowed_scheme: gopher:")).toBe("disallowed_scheme");
  });

  it("maps an unrecognized reason to `other` rather than leaking it", () => {
    // A new upstream reason string should land in a known bucket, not
    // become its own GROUP BY key.
    expect(normalizePageOutcome("some_new_upstream_reason")).toBe("other");
    expect(normalizePageOutcome("unexpected: with a colon")).toBe("other");
  });

  it("maps a missing reason to `other` instead of throwing", () => {
    // A reject with no reason is an upstream bug worth seeing in the
    // breakdown, not grounds for failing an otherwise-fine pass.
    expect(normalizePageOutcome(undefined)).toBe("other");
    expect(normalizePageOutcome("")).toBe("other");
  });

  it("only ever returns a member of PAGE_OUTCOMES", () => {
    // Fuzz the shapes the fetcher can actually produce, plus junk.
    const inputs = [
      undefined, "", "scored", "oversize", "oversize_declared",
      "static: x", "resolved 10.0.0.1 blocked: private", "disallowed_scheme: ws:",
      "garbage", "  padded  ", "OVERSIZE", "non_html_content_type",
      "resolved", "static:", "disallowed_scheme",
    ];
    const allowed = new Set<string>(PAGE_OUTCOMES);
    for (const i of inputs) {
      expect(allowed.has(normalizePageOutcome(i)), `input=${String(i)}`).toBe(true);
    }
  });

  it("does not claim `scored` for any rejection", () => {
    // `scored` is written as a SQL literal by the success branch only.
    // If normalization could ever return it, a failed pass would read as
    // a successful one — reintroducing the §11.3 staleness by another
    // route.
    const rejections = [
      undefined, "", "oversize", "oversize_declared", "non_html_content_type",
      "unreachable", "fetch_error", "static: loopback",
      "resolved 127.0.0.1 blocked: loopback", "disallowed_scheme: file:",
      "anything_at_all",
    ];
    for (const r of rejections) {
      expect(normalizePageOutcome(r), String(r)).not.toBe("scored");
    }
  });

  it("PAGE_OUTCOMES has no duplicates and includes scored + other", () => {
    expect(new Set(PAGE_OUTCOMES).size).toBe(PAGE_OUTCOMES.length);
    expect(PAGE_OUTCOMES).toContain("scored");
    expect(PAGE_OUTCOMES).toContain("other");
  });
});
