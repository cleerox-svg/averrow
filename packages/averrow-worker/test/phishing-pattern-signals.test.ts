/**
 * W1.7 — pure-core coverage for the AI-phishing phase-1 deterministic
 * measurement pipeline (`lib/phishing-pattern-signals.ts`, W1.4), per
 * `docs/AI_PHISHING_DETECTION_RESEARCH_2026-07.md` §3.2 + the W1.0 phase-1
 * measurement spec.
 *
 * This module is PURE (no D1, no env, no network) so every case here is a
 * direct function-in/value-out assertion — no mocking required. Exact
 * numeric fixtures below were derived by running the real functions under
 * test against hand-built inputs (not hand-computed), so they encode actual
 * behavior rather than an independently-guessed expectation.
 *
 * The one hard invariant this whole module exists to enforce — spec §0.2
 * rule 1 — gets its own top-level describe block at the end: every fixture
 * in this file, including the highest- and lowest-variance ones, must carry
 * a literal-null `ai_generated_probability`.
 */

import { describe, it, expect } from "vitest";
import {
  // Normalization
  stageASlot,
  tokenize,
  buildSlotContext,
  normalizeCorpus,
  HOMOGLYPH_MAP,
  // Templating
  fnv1a64,
  shingles,
  simhash64,
  hamming64,
  computeTemplateHash,
  parseTemplateHash,
  sameTemplate,
  computeTemplateDetected,
  // Per-capture stats
  vocabularyComplexity,
  sentenceStructureVariance,
  fluencyScore,
  // URL / brand columns
  urlObfuscationType,
  impersonationTechnique,
  // Campaign key
  windowBucket,
  deriveCampaignKey,
  // Rollup
  aggregateCampaign,
  classifyRegime,
  // Guard
  assertEvidenceOnly,
  measureCapture,
  PHISHING_SIGNAL_CALIBRATION,
  type CaptureInput,
  type CampaignMemberSignal,
} from "../src/lib/phishing-pattern-signals";

// ─── Shared fixtures ───────────────────────────────────────────────────

const emptyCtx = { brandActive: false, brandNeedles: [] as string[], nameNeedles: [] as string[] };

function baseCapture(overrides: Partial<CaptureInput> = {}): CaptureInput {
  return {
    captureId: 1,
    subject: null,
    bodyPreview: null,
    rawHeaders: null,
    urlsFound: null,
    sendingIp: null,
    fromAddress: null,
    fromDomain: null,
    heloHostname: null,
    xMailer: null,
    trapAddress: null,
    spoofedBrandId: null,
    spoofedDomain: null,
    brandMatchMethod: null,
    brandName: null,
    threatId: null,
    threatCampaignId: null,
    capturedAt: "2026-07-31 10:00:00",
    ...overrides,
  };
}

function member(
  id: number,
  hash: string | null,
  overrides: Partial<CampaignMemberSignal> = {},
): CampaignMemberSignal {
  return {
    capture_id: id,
    captured_at: `2026-07-31 0${id}:00:00`,
    template_hash: hash,
    vocabulary_complexity: 0.5,
    sentence_structure_variance: 0.3,
    fluency_score: 0.6,
    sending_ip: `1.2.3.${id}`,
    from_domain: "evil.example",
    sender_asn: "AS123",
    mail_server_fingerprint: "m1:abc",
    subject_slot_hash: `subj${id}`,
    ...overrides,
  };
}

const hashOf = (n: bigint) => `t1:${n.toString(16).padStart(16, "0")}`;

// ═══════════════════════════════════════════════════════════════════════
// 1. Normalization
// ═══════════════════════════════════════════════════════════════════════

describe("stageASlot — homoglyph fold (§2.1 A4)", () => {
  it("folds every mapped Cyrillic/Greek homoglyph so an obfuscated kit hashes identically to its Latin original", () => {
    // Build the reverse map (Latin -> its first homoglyph) and substitute
    // alternating occurrences of each mappable Latin letter in a realistic
    // phishing sentence. If the fold is correct, Stage A output — and
    // therefore the resulting template_hash — must be byte-identical.
    const reverseMap: Record<string, string> = {};
    for (const [homoglyph, latin] of Object.entries(HOMOGLYPH_MAP)) {
      if (!(latin in reverseMap)) reverseMap[latin] = homoglyph;
    }
    const original =
      "please verify your account by clicking the secure link below to avoid suspension of your account access immediately today";
    let obfuscated = "";
    let toggle = false;
    for (const ch of original) {
      if (reverseMap[ch] && toggle) {
        obfuscated += reverseMap[ch];
        toggle = false;
      } else {
        obfuscated += ch;
        if (reverseMap[ch]) toggle = true;
      }
    }
    // Sanity: the obfuscation actually changed the raw string.
    expect(obfuscated).not.toBe(original);

    const slottedOriginal = stageASlot(original, emptyCtx);
    const slottedObfuscated = stageASlot(obfuscated, emptyCtx);
    expect(slottedObfuscated).toBe(slottedOriginal);

    // And the templating layer built on top must agree too — this is the
    // load-bearing guarantee: kit-reuse detection survives homoglyph swap.
    const hashOriginal = computeTemplateHash(tokenize(slottedOriginal, false));
    const hashObfuscated = computeTemplateHash(tokenize(slottedObfuscated, false));
    expect(hashObfuscated).toBe(hashOriginal);
    expect(hashOriginal).not.toBeNull();
  });

  it("strips zero-width and bidi control characters entirely", () => {
    const withZeroWidth = "hello​world"; // U+200B zero-width space
    expect(stageASlot(withZeroWidth, emptyCtx)).toBe("helloworld");
  });
});

describe("stageASlot — ordered slotting rules (§2.1 A5)", () => {
  it("slots an http(s) URL to ⟦url⟧", () => {
    expect(stageASlot("Visit https://example.com/path?a=1 now", emptyCtx)).toBe(
      "visit ⟦url⟧ now",
    );
  });

  it("slots a www.-prefixed bare URL to ⟦url⟧", () => {
    expect(stageASlot("Visit www.example.com/path now", emptyCtx)).toBe("visit ⟦url⟧ now");
  });

  it("slots an email address to ⟦email⟧", () => {
    expect(stageASlot("Contact us at support@example.com today", emptyCtx)).toBe(
      "contact us at ⟦email⟧ today",
    );
  });

  it("slots a currency-prefixed amount to ⟦money⟧", () => {
    expect(stageASlot("Pay $1,234.56 now", emptyCtx)).toBe("pay ⟦money⟧ now");
  });

  it("slots a currency-suffixed amount to ⟦money⟧", () => {
    expect(stageASlot("Pay 1234.56 usd now", emptyCtx)).toBe("pay ⟦money⟧ now");
  });

  it("slots an ISO date to ⟦date⟧", () => {
    expect(stageASlot("Due on 2026-07-31 please", emptyCtx)).toBe("due on ⟦date⟧ please");
  });

  it("slots a numeric date to ⟦date⟧", () => {
    expect(stageASlot("Due on 07/31/2026 please", emptyCtx)).toBe("due on ⟦date⟧ please");
  });

  it("slots a month-name date to ⟦date⟧", () => {
    expect(stageASlot("Due on Jul 31, 2026 please", emptyCtx)).toBe("due on ⟦date⟧ please");
  });

  it("slots a clock time to ⟦time⟧", () => {
    expect(stageASlot("Meet at 3:45pm today", emptyCtx)).toBe("meet at ⟦time⟧ today");
  });

  it("slots an alphanumeric identifier (>=8 chars, contains a digit) to ⟦id⟧", () => {
    expect(stageASlot("Your reference is ab12cd34ef today", emptyCtx)).toBe(
      "your reference is ⟦id⟧ today",
    );
  });

  it("slots a long numeric run (>=6 digits) to ⟦id⟧", () => {
    expect(stageASlot("Your code is 123456789 today", emptyCtx)).toBe(
      "your code is ⟦id⟧ today",
    );
  });

  it("slots a residual short digit run to ⟦num⟧ (after id/date/time have claimed their patterns)", () => {
    expect(stageASlot("You have 42 new messages", emptyCtx)).toBe(
      "you have ⟦num⟧ new messages",
    );
  });

  it("slots a matched brand needle to ⟦brand⟧ (only when brandActive)", () => {
    const brandCtx = { brandActive: true, brandNeedles: ["acme"], nameNeedles: [] as string[] };
    expect(stageASlot("This is not acme official mail", brandCtx)).toBe(
      "this is not ⟦brand⟧ official mail",
    );
  });

  it("slots a matched identity needle to ⟦name⟧", () => {
    const nameCtx = { brandActive: false, brandNeedles: [] as string[], nameNeedles: ["john"] };
    expect(stageASlot("Hello john please confirm", nameCtx)).toBe(
      "hello ⟦name⟧ please confirm",
    );
  });

  it("order is load-bearing: URL slotting runs before brand slotting, so a brand needle inside a URL is not double-slotted", () => {
    const brandCtx = { brandActive: true, brandNeedles: ["acme"], nameNeedles: [] as string[] };
    expect(
      stageASlot("Visit https://acme-secure.example.com/login now", brandCtx),
    ).toBe("visit ⟦url⟧ now");
  });

  it("order is load-bearing: email slotting runs before the id/digit rules, so an email local-part with digits stays ⟦email⟧", () => {
    expect(stageASlot("reach me at user12345678@example.com now", emptyCtx)).toBe(
      "reach me at ⟦email⟧ now",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Templating: FNV-1a, SimHash, Hamming, template_hash
// ═══════════════════════════════════════════════════════════════════════

describe("fnv1a64 — determinism", () => {
  it("is deterministic for identical input", () => {
    expect(fnv1a64("hello world")).toBe(fnv1a64("hello world"));
  });

  it("differs for different input", () => {
    expect(fnv1a64("hello world")).not.toBe(fnv1a64("hello worlds"));
  });
});

describe("simhash64 — stability", () => {
  it("produces the same hash for the same shingle set across calls", () => {
    const toks = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];
    expect(simhash64(shingles(toks))).toBe(simhash64(shingles(toks)));
  });
});

describe("hamming64 + sameTemplate — the ≤3 boundary (§3.5)", () => {
  it("hamming64(a, a) is 0", () => {
    expect(hamming64(0n, 0n)).toBe(0);
  });

  it("computes exact popcount-of-XOR distance", () => {
    expect(hamming64(0n, 0b111n)).toBe(3);
    expect(hamming64(0n, 0b1111n)).toBe(4);
  });

  it("sameTemplate is true at distance 0 (identical hash)", () => {
    const h = hashOf(0n);
    expect(sameTemplate(h, h)).toBe(true);
  });

  it("sameTemplate is true at exactly distance 3 (inclusive boundary)", () => {
    expect(sameTemplate(hashOf(0n), hashOf(0b111n))).toBe(true);
  });

  it("sameTemplate is false at distance 4 (one past the boundary)", () => {
    expect(sameTemplate(hashOf(0n), hashOf(0b1111n))).toBe(false);
  });

  it("sameTemplate is false (not true by omission) when either hash is null", () => {
    expect(sameTemplate(null, hashOf(0n))).toBe(false);
    expect(sameTemplate(hashOf(0n), null)).toBe(false);
    expect(sameTemplate(null, null)).toBe(false);
  });

  it("parseTemplateHash rejects malformed shapes (wrong prefix, short hex, garbage)", () => {
    expect(parseTemplateHash("t2:0000000000000000")).toBeNull();
    expect(parseTemplateHash("t1:123")).toBeNull();
    expect(parseTemplateHash("not-a-hash")).toBeNull();
    expect(parseTemplateHash(null)).toBeNull();
  });
});

describe("computeTemplateHash — the 12-token shingle floor (§3.1)", () => {
  it("returns null below MIN_TOKENS_FOR_SHINGLES (12)", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `tok${i}`);
    expect(eleven.length).toBe(11);
    expect(computeTemplateHash(eleven)).toBeNull();
  });

  it("produces a t1:<16hex> hash at exactly the 12-token floor", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `tok${i}`);
    const hash = computeTemplateHash(twelve);
    expect(hash).toMatch(/^t1:[0-9a-f]{16}$/);
  });

  it("is deterministic — measuring the same tokens twice yields the same hash (re-run idempotency)", () => {
    const toks = "please verify your account by clicking the secure link below to avoid suspension"
      .split(" ");
    expect(computeTemplateHash(toks)).toBe(computeTemplateHash(toks));
  });
});

describe("computeTemplateDetected — insert-time seed (§3.6 requirement 1)", () => {
  it("is 0 for the first member of a family (no peers exist yet) — the well-known 'seed-0' case", () => {
    const selfHash = computeTemplateHash(Array.from({ length: 12 }, (_, i) => `w${i}`));
    expect(computeTemplateDetected(selfHash, [])).toBe(0);
  });

  it("is 1 once a matching peer exists", () => {
    const selfHash = computeTemplateHash(Array.from({ length: 12 }, (_, i) => `w${i}`));
    expect(computeTemplateDetected(selfHash, [selfHash])).toBe(1);
  });

  it("is 0 (never NULL) when the self hash is null (below the shingle floor)", () => {
    expect(computeTemplateDetected(null, [hashOf(0n)])).toBe(0);
  });

  it("skips null peers without throwing and without counting them as a match", () => {
    const selfHash = hashOf(0n);
    expect(computeTemplateDetected(selfHash, [null, null])).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Per-capture text statistics — floors and sane values
// ═══════════════════════════════════════════════════════════════════════

describe("per-capture stat floors — NULL, never 0 (§4.1/§4.5)", () => {
  it("vocabularyComplexity is null below the 40-content-token floor", () => {
    expect(vocabularyComplexity(Array.from({ length: 39 }, (_, i) => `w${i}`))).toBeNull();
  });

  it("vocabularyComplexity is a number, not null, at exactly the 40-token floor", () => {
    const v = vocabularyComplexity(Array.from({ length: 40 }, (_, i) => `w${i}`));
    expect(v).not.toBeNull();
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThanOrEqual(1);
  });

  it("sentenceStructureVariance is null below the 3-sentence floor", () => {
    expect(sentenceStructureVariance([["a", "b"], ["c", "d"]])).toBeNull();
  });

  it("sentenceStructureVariance is a number at exactly the 3-sentence floor", () => {
    const v = sentenceStructureVariance([
      ["a", "b"],
      ["c", "d", "e"],
      ["f", "g"],
    ]);
    expect(v).not.toBeNull();
    expect(v).toBeGreaterThanOrEqual(0);
  });

  it("fluencyScore is null below the 40-token floor even with enough sentences", () => {
    expect(fluencyScore(Array.from({ length: 10 }, (_, i) => `w${i}`), 5)).toBeNull();
  });

  it("fluencyScore is null below the 2-sentence floor even with enough tokens", () => {
    expect(fluencyScore(Array.from({ length: 40 }, (_, i) => `w${i}`), 1)).toBeNull();
  });

  it("never returns 0 for a floor failure (0 is a real 'single repeated word' measurement, not a sentinel)", () => {
    // A below-floor call must be strictly null, not the number 0 — this is
    // the exact bug the spec calls out: "writing 0 instead of NULL...
    // poisons every campaign-grain mean".
    const belowFloor = vocabularyComplexity(["only", "three", "tokens"]);
    expect(belowFloor).toBeNull();
    expect(belowFloor).not.toBe(0);
  });
});

describe("per-capture stats — sane values on a realistic message body", () => {
  // A ~90-word, 6-sentence, non-truncated phishing body. Exact values below
  // were captured from a real run of these functions (not hand-derived),
  // pinning the current behavior as a byte-for-byte regression guard.
  const body =
    "Dear customer, we detected unusual activity on your account. " +
    "Please verify your identity immediately by clicking the secure link below. " +
    "If you do not confirm your details within twenty four hours your account access will be limited. " +
    "This is an automated security notice sent to protect your information from unauthorized access. " +
    "Thank you for your prompt attention to this important matter regarding your account status.";
  const input = baseCapture({ subject: "Your account will be suspended", bodyPreview: body });
  const ctx = buildSlotContext(input);
  const corpus = normalizeCorpus(input, ctx);

  it("produces a normal (non-truncated, non-unparseable) corpus with the expected token/sentence shape", () => {
    expect(corpus.bodyTruncated).toBe(false);
    expect(corpus.unparseable).toBe(false);
    expect(corpus.allTokens.length).toBe(70);
    expect(corpus.contentTokens.length).toBe(70);
    expect(corpus.usableSentences).toBe(6);
  });

  it("MATTR-25 vocabulary_complexity is a sane value in (0, 1]", () => {
    const v = vocabularyComplexity(corpus.contentTokens);
    expect(v).toBe(0.9209);
  });

  it("CV sentence_structure_variance is a sane non-negative value", () => {
    const v = sentenceStructureVariance(corpus.sentences);
    expect(v).toBe(0.3344);
  });

  it("ARI-normalized fluency_score is in [0, 1]", () => {
    const f = fluencyScore(corpus.allTokens, corpus.usableSentences);
    expect(f).toBe(0.4198);
    expect(f).toBeGreaterThanOrEqual(0);
    expect(f).toBeLessThanOrEqual(1);
  });

  it("establishes a template_hash once past the 12-token shingle floor", () => {
    expect(computeTemplateHash(corpus.allTokens)).toBe("t1:cb0043de97663ffa");
  });
});

describe("§2.4 corpus quality gate — unparseable_v1", () => {
  it("marks a corpus unparseable when >=30% of >=10 tokens are >=20 chars (base64/QP residue proxy)", () => {
    // Tokens deliberately contain no digits so the ⟦id⟧ slot rule (which
    // requires a digit) can't absorb them before the quality gate runs.
    const garbage = Array.from({ length: 12 }, (_, i) =>
      "qwertyuiopasdfghjklzxcvbnmqwertyuiop".slice(0, 22 + (i % 3)),
    ).join(" ");
    const input = baseCapture({ bodyPreview: garbage });
    const ctx = buildSlotContext(input);
    const corpus = normalizeCorpus(input, ctx);
    expect(corpus.unparseable).toBe(true);
    expect(corpus.longTokenRate).toBeGreaterThanOrEqual(0.3);
  });

  it("measureCapture writes all four text columns NULL, template_detected=0, and classification='unparseable_v1'", async () => {
    const garbage = Array.from({ length: 12 }, (_, i) =>
      "qwertyuiopasdfghjklzxcvbnmqwertyuiop".slice(0, 22 + (i % 3)),
    ).join(" ");
    const input = baseCapture({ bodyPreview: garbage });
    const signals = await measureCapture(input);
    expect(signals.classification).toBe("unparseable_v1");
    expect(signals.fluency_score).toBeNull();
    expect(signals.vocabulary_complexity).toBeNull();
    expect(signals.sentence_structure_variance).toBeNull();
    expect(signals.template_hash).toBeNull();
    expect(signals.template_detected).toBe(0);
  });

  it("measureCapture writes classification='insufficient_text_v1' (not unparseable) below the 12-token shingle floor on ordinary short text", async () => {
    const input = baseCapture({ bodyPreview: "hello there my friend today" });
    const signals = await measureCapture(input);
    expect(signals.classification).toBe("insufficient_text_v1");
    expect(signals.template_hash).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Campaign grouping key (§7)
// ═══════════════════════════════════════════════════════════════════════

describe("windowBucket — 24h UTC-day tumbling bucket (§7.1)", () => {
  it("buckets a timestamp to its UTC calendar day", () => {
    expect(windowBucket("2026-07-31 23:59:59")).toBe("2026-07-31");
  });

  it("a timestamp one second later (past midnight) buckets to the NEXT day — the documented straddling edge case", () => {
    expect(windowBucket("2026-08-01 00:00:00")).toBe("2026-08-01");
  });

  it("returns null for a null or malformed timestamp", () => {
    expect(windowBucket(null)).toBeNull();
    expect(windowBucket("bad")).toBeNull();
  });
});

describe("deriveCampaignKey — precedence order c: > b: > i: > d: > NULL (§7.2)", () => {
  it("rule 1 (campaign): threat_id + threat's campaign_id both present", () => {
    const input = baseCapture({ threatId: "t1", threatCampaignId: "camp-1" });
    expect(deriveCampaignKey(input)).toEqual({
      campaign_key: "c:camp-1|2026-07-31",
      campaign_key_kind: "campaign",
    });
  });

  it("rule 2 (brand_domain): spoofed_brand_id + registrable from_domain, when rule 1 doesn't apply", () => {
    const input = baseCapture({ spoofedBrandId: "brand-1", fromDomain: "evil.example" });
    expect(deriveCampaignKey(input)).toEqual({
      campaign_key: "b:brand-1|evil.example|2026-07-31",
      campaign_key_kind: "brand_domain",
    });
  });

  it("rule 3 (sending_ip): sending_ip present, no brand/domain match", () => {
    const input = baseCapture({ sendingIp: "203.0.113.5" });
    expect(deriveCampaignKey(input)).toEqual({
      campaign_key: "i:203.0.113.5|2026-07-31",
      campaign_key_kind: "sending_ip",
    });
  });

  it("rule 4 (from_domain): from_domain present, no ip/brand match", () => {
    const input = baseCapture({ fromDomain: "example.com" });
    expect(deriveCampaignKey(input)).toEqual({
      campaign_key: "d:example.com|2026-07-31",
      campaign_key_kind: "from_domain",
    });
  });

  it("rule 5 (NULL): none of the identifiers present", () => {
    const input = baseCapture({});
    expect(deriveCampaignKey(input)).toEqual({ campaign_key: null, campaign_key_kind: null });
  });

  it("threat_id without a campaign_id on the joined threat falls through rule 1 to rule 2", () => {
    const input = baseCapture({
      threatId: "t1",
      threatCampaignId: null,
      spoofedBrandId: "brand-1",
      fromDomain: "evil.example",
    });
    expect(deriveCampaignKey(input).campaign_key_kind).toBe("brand_domain");
  });

  it("a brand match with an IP-literal from_domain (registrableDomain -> null) falls through rule 2 to rule 3", () => {
    const input = baseCapture({
      spoofedBrandId: "brand-1",
      fromDomain: "10.0.0.1",
      sendingIp: "9.9.9.9",
    });
    expect(deriveCampaignKey(input)).toEqual({
      campaign_key: "i:9.9.9.9|2026-07-31",
      campaign_key_kind: "sending_ip",
    });
  });

  it("a null captured_at yields NULL regardless of any identifier present", () => {
    const input = baseCapture({ capturedAt: null, sendingIp: "1.2.3.4" });
    expect(deriveCampaignKey(input)).toEqual({ campaign_key: null, campaign_key_kind: null });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. Campaign rollup (§8) — MIN_CAMPAIGN_MEMBERS, regimes, restamp, idempotency
// ═══════════════════════════════════════════════════════════════════════

describe("aggregateCampaign — MIN_CAMPAIGN_MEMBERS=5 skip (§8.2)", () => {
  it("returns null (no row at all) for a group of 4 members — one below the floor", () => {
    const H = hashOf(0n);
    const four = [1, 2, 3, 4].map((i) => member(i, H));
    expect(four.length).toBe(4);
    expect(aggregateCampaign("i:test|2026-07-31", "sending_ip", "2026-07-31", four)).toBeNull();
  });

  it("returns a row at exactly the 5-member floor", () => {
    const H = hashOf(0n);
    const five = [1, 2, 3, 4, 5].map((i) => member(i, H));
    const result = aggregateCampaign("i:test|2026-07-31", "sending_ip", "2026-07-31", five);
    expect(result).not.toBeNull();
    expect(result!.stats.member_count).toBe(5);
  });
});

describe("aggregateCampaign — §8.5 polymorphism regimes separate correctly on fixtures", () => {
  it("kit_reuse: all members share one template (near_dup_pair_rate=1.0 >= 0.60)", () => {
    const H = hashOf(0n);
    const members = [1, 2, 3, 4, 5].map((i) => member(i, H));
    const result = aggregateCampaign("k:test|2026-07-31", "sending_ip", "2026-07-31", members);
    expect(result).not.toBeNull();
    expect(result!.stats.near_dup_pair_rate).toBe(1);
    expect(result!.stats.mean_pairwise_hamming).toBe(0);
    expect(result!.stats.distinct_template_hashes).toBe(1);
    expect(result!.stats.largest_template_share).toBe(1);
    expect(result!.stats.polymorphism_regime).toBe("kit_reuse");
  });

  it("mail_merge: a fixed-skeleton group plus a distinct variable-slot group (near_dup_pair_rate=0.4, in [0.15, 0.60))", () => {
    const H1 = hashOf(0n);
    const H2 = hashOf(0x00000000000003ffn); // distance 10 from H1 — not a near-dup
    const members = [
      member(1, H1),
      member(2, H1),
      member(3, H1),
      member(4, H2),
      member(5, H2),
    ];
    const result = aggregateCampaign("b:test|2026-07-31", "brand_domain", "2026-07-31", members);
    expect(result).not.toBeNull();
    expect(result!.stats.near_dup_pair_rate).toBe(0.4);
    expect(result!.stats.distinct_template_hashes).toBe(2);
    expect(result!.stats.largest_template_share).toBe(0.6);
    expect(result!.stats.polymorphism_regime).toBe("mail_merge");
  });

  it("high_variance: 5 mutually-distant templates (near_dup_pair_rate=0, mean_pairwise_hamming=38.4 >= 20)", () => {
    const hashes = [
      0x0000000000000000n,
      0xffffffffffffffffn,
      0xffffffff00000000n,
      0x00000000ffffffffn,
      0xff00ff00ff00ff00n,
    ];
    const members = hashes.map((h, i) => member(i + 1, hashOf(h)));
    const result = aggregateCampaign("i:test|2026-07-31", "sending_ip", "2026-07-31", members);
    expect(result).not.toBeNull();
    expect(result!.stats.near_dup_pair_rate).toBe(0);
    expect(result!.stats.mean_pairwise_hamming).toBe(38.4);
    expect(result!.stats.distinct_template_hashes).toBe(5);
    expect(result!.stats.polymorphism_regime).toBe("high_variance");
  });

  it("insufficient: fewer than 2 hashed members (member_count still >= 5)", () => {
    const members = [
      member(1, hashOf(0n)),
      member(2, null),
      member(3, null),
      member(4, null),
      member(5, null),
    ];
    const result = aggregateCampaign("d:test|2026-07-31", "from_domain", "2026-07-31", members);
    expect(result).not.toBeNull();
    expect(result!.stats.hashed_member_count).toBe(1);
    expect(result!.stats.near_dup_pair_rate).toBeNull();
    expect(result!.stats.mean_pairwise_hamming).toBeNull();
    expect(result!.stats.polymorphism_regime).toBe("insufficient");
  });

  it("mixed: low near-dup rate but mean distance well below the high_variance floor", () => {
    // classifyRegime unit-level: rate below mail_merge's 0.15 floor, mean
    // below the high_variance 20-bit floor -> falls through to 'mixed'.
    expect(classifyRegime(10, 0.1, 10)).toBe("mixed");
  });
});

describe("aggregateCampaign — template_detected re-stamp fixes seed-0 members (§3.6 req 1 / §8.6)", () => {
  it("a member whose insert-time seed was 0 (no peers existed yet) is re-stamped to 1 once its family is complete", () => {
    // Simulate the insert-time seed for the very first-processed member of
    // a kit-reuse family: no peers exist yet, so the per-capture seed is 0.
    const selfHash = hashOf(0n);
    const insertTimeSeed = computeTemplateDetected(selfHash, []);
    expect(insertTimeSeed).toBe(0);

    // The rollup later sees all 5 members of the same template family.
    const members = [1, 2, 3, 4, 5].map((i) => member(i, selfHash));
    const result = aggregateCampaign("k:test|2026-07-31", "sending_ip", "2026-07-31", members);
    expect(result).not.toBeNull();
    // The authoritative re-stamp overrides the stale 0 seed for member 1.
    expect(result!.templateDetectedByCapture.get(1)).toBe(1);
    for (const m of members) {
      expect(result!.templateDetectedByCapture.get(m.capture_id)).toBe(1);
    }
  });

  it("a member with a null template_hash stays 0 forever — never a peer, never detected", () => {
    const H = hashOf(0n);
    const members = [
      member(1, H),
      member(2, H),
      member(3, H),
      member(4, H),
      member(5, null),
    ];
    const result = aggregateCampaign("k:test|2026-07-31", "sending_ip", "2026-07-31", members);
    expect(result!.templateDetectedByCapture.get(5)).toBe(0);
    expect(result!.templateDetectedByCapture.get(1)).toBe(1);
  });
});

describe("aggregateCampaign — deterministic re-run produces identical stats (pure-level idempotency)", () => {
  it("re-aggregating the same members in a different order yields byte-identical stats", () => {
    const H1 = hashOf(0n);
    const H2 = hashOf(0x00000000000003ffn);
    const members = [
      member(1, H1),
      member(2, H1),
      member(3, H1),
      member(4, H2),
      member(5, H2),
    ];
    const shuffled = [members[4]!, members[1]!, members[0]!, members[3]!, members[2]!];

    const a = aggregateCampaign("b:test|2026-07-31", "brand_domain", "2026-07-31", members);
    const b = aggregateCampaign("b:test|2026-07-31", "brand_domain", "2026-07-31", shuffled);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(b!.stats).toEqual(a!.stats);
  });

  it("the PAIRWISE_MAX_MEMBERS sample is the deterministic lowest-capture_id set, so adding higher-id members beyond the cap doesn't change the sampled pairwise stats", () => {
    const H = hashOf(0n);
    const cal = { ...PHISHING_SIGNAL_CALIBRATION, PAIRWISE_MAX_MEMBERS: 3 };
    // Both fixtures satisfy MIN_CAMPAIGN_MEMBERS=5 on their own; `withMore`
    // adds two extra higher-id, differently-hashed members on top.
    const base = [1, 2, 3, 4, 5].map((i) => member(i, H));
    const withMore = [
      ...base,
      member(6, hashOf(0xffffffffffffffffn)),
      member(7, hashOf(0xffffffffffffffffn)),
    ];

    const a = aggregateCampaign("i:test|2026-07-31", "sending_ip", "2026-07-31", base, cal);
    const b = aggregateCampaign("i:test|2026-07-31", "sending_ip", "2026-07-31", withMore, cal);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // The pairwise sample stays capped at 3 (lowest ids 1,2,3) in both cases,
    // so the pairwise statistics themselves are identical even though `b`
    // has 7 total members vs `a`'s 5.
    expect(a!.stats.pairwise_sample_size).toBe(3);
    expect(b!.stats.pairwise_sample_size).toBe(3);
    expect(b!.stats.mean_pairwise_hamming).toBe(a!.stats.mean_pairwise_hamming);
    expect(b!.stats.near_dup_pair_rate).toBe(a!.stats.near_dup_pair_rate);
    // But member_count and distinct_template_hashes DO reflect the full set —
    // only the pairwise sample is capped, not the whole-group aggregates.
    expect(a!.stats.member_count).toBe(5);
    expect(b!.stats.member_count).toBe(7);
    expect(b!.stats.distinct_template_hashes).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. The hard prohibition — assertEvidenceOnly / literal-null guard (§0.2/§0.3)
// ═══════════════════════════════════════════════════════════════════════

describe("assertEvidenceOnly — rejects any non-null ai_generated_probability", () => {
  it("throws when ai_generated_probability is a number", () => {
    expect(() => assertEvidenceOnly({ ai_generated_probability: 0.9 })).toThrow(
      /ai_generated_probability must remain NULL/,
    );
  });

  it("throws when ai_generated_probability is 0 (falsy but not null)", () => {
    expect(() => assertEvidenceOnly({ ai_generated_probability: 0 })).toThrow();
  });

  it("does not throw when ai_generated_probability is null", () => {
    expect(() => assertEvidenceOnly({ ai_generated_probability: null })).not.toThrow();
  });

  it("does not throw when ai_generated_probability is absent (undefined)", () => {
    expect(() => assertEvidenceOnly({})).not.toThrow();
  });
});

describe("measureCapture — ai_generated_probability is null on every fixture, always (§0.2 rule 1)", () => {
  it("is null on the highest-variance fixture (rich, non-truncated, multi-sentence body)", async () => {
    const body =
      "Dear customer, we detected unusual activity on your account. " +
      "Please verify your identity immediately by clicking the secure link below. " +
      "If you do not confirm your details within twenty four hours your account access will be limited. " +
      "This is an automated security notice sent to protect your information from unauthorized access. " +
      "Thank you for your prompt attention to this important matter regarding your account status.";
    const signals = await measureCapture(
      baseCapture({ subject: "Your account will be suspended", bodyPreview: body }),
    );
    expect(signals.ai_generated_probability).toBeNull();
    expect(() => assertEvidenceOnly(signals)).not.toThrow();
  });

  it("is null on the lowest-variance fixture (empty capture, every field null)", async () => {
    const signals = await measureCapture(baseCapture({}));
    expect(signals.ai_generated_probability).toBeNull();
    expect(() => assertEvidenceOnly(signals)).not.toThrow();
  });

  it("is null on an unparseable-corpus fixture", async () => {
    const garbage = Array.from({ length: 12 }, (_, i) =>
      "qwertyuiopasdfghjklzxcvbnmqwertyuiop".slice(0, 22 + (i % 3)),
    ).join(" ");
    const signals = await measureCapture(baseCapture({ bodyPreview: garbage }));
    expect(signals.ai_generated_probability).toBeNull();
  });

  it("is null on a brand-impersonation fixture with URLs and money slots present", async () => {
    const signals = await measureCapture(
      baseCapture({
        bodyPreview:
          "Your acme account requires verification. Visit https://acme-secure.example.com/login " +
          "and confirm your $250.00 refund before Jul 31, 2026 at 3:45pm to avoid suspension.",
        spoofedBrandId: "brand-1",
        spoofedDomain: "acme.com",
        brandName: "Acme",
        brandMatchMethod: "url",
        urlsFound: JSON.stringify(["https://acme-secure.example.com/login"]),
      }),
    );
    expect(signals.ai_generated_probability).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Bonus: URL obfuscation + impersonation technique (§5) — quick sanity,
// since these feed the same evidence-only row and are cheap to pin.
// ═══════════════════════════════════════════════════════════════════════

describe("urlObfuscationType — ordered taxonomy sanity (§5.1)", () => {
  it("returns null when urls_found is null", () => {
    expect(urlObfuscationType(null, { brandName: null, spoofedDomain: null, spoofedBrandId: null })).toBeNull();
  });

  it("returns null on unparseable JSON", () => {
    expect(
      urlObfuscationType("not json", { brandName: null, spoofedDomain: null, spoofedBrandId: null }),
    ).toBeNull();
  });

  it("returns 'none' when URLs are present but none match a known technique", () => {
    expect(
      urlObfuscationType(JSON.stringify(["https://example.com/normal/path"]), {
        brandName: null,
        spoofedDomain: null,
        spoofedBrandId: null,
      }),
    ).toBe("none");
  });

  it("detects an IP-literal host at the top precedence", () => {
    expect(
      urlObfuscationType(JSON.stringify(["http://203.0.113.5/login"]), {
        brandName: null,
        spoofedDomain: null,
        spoofedBrandId: null,
      }),
    ).toBe("ip_literal");
  });

  it("detects a shortener domain", () => {
    expect(
      urlObfuscationType(JSON.stringify(["https://bit.ly/abc123"]), {
        brandName: null,
        spoofedDomain: null,
        spoofedBrandId: null,
      }),
    ).toBe("shortener");
  });
});

describe("impersonationTechnique — ordered taxonomy (§5.3)", () => {
  it("returns null when no brand matched", () => {
    expect(
      impersonationTechnique({
        spoofedBrandId: null,
        fromDomain: "example.com",
        spoofedDomain: "acme.com",
        brandMatchMethod: null,
      }),
    ).toBeNull();
  });

  it("classifies exact_domain_spoof when the From domain equals the spoofed domain", () => {
    expect(
      impersonationTechnique({
        spoofedBrandId: "brand-1",
        fromDomain: "acme.com",
        spoofedDomain: "acme.com",
        brandMatchMethod: "url",
      }),
    ).toBe("exact_domain_spoof");
  });

  it("classifies freemail_display_name for a freemail From domain", () => {
    expect(
      impersonationTechnique({
        spoofedBrandId: "brand-1",
        fromDomain: "gmail.com",
        spoofedDomain: "acme.com",
        brandMatchMethod: "subject",
      }),
    ).toBe("freemail_display_name");
  });

  it("classifies unclassified when a brand matched but the match method is unrecognized", () => {
    expect(
      impersonationTechnique({
        spoofedBrandId: "brand-1",
        fromDomain: "totally-unrelated.example",
        spoofedDomain: "acme.com",
        brandMatchMethod: "some_future_method",
      }),
    ).toBe("unclassified");
  });
});
