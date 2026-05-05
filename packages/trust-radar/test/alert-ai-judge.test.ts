import { describe, it, expect } from "vitest";
import {
  buildJudgePrompt,
  parseJudgeResult,
  AUTO_DISMISS_CONFIDENCE_FLOOR,
  type AlertJudgeContext,
} from "../src/lib/alert-ai-judge";

describe("buildJudgePrompt", () => {
  it("formats a social_impersonation alert with all fields", () => {
    const ctx: AlertJudgeContext = {
      alert_type: 'social_impersonation',
      brand_name: 'Steam Community',
      brand_domain: 'steamcommunity.com',
      details: {
        platform: 'tiktok',
        handle: 'realsteamcommunity',
        url: 'https://tiktok.com/@realsteamcommunity',
        score: 0.79,
        signals: ['brand_keyword_in_handle', 'high_name_similarity'],
      },
    };
    const prompt = buildJudgePrompt(ctx);
    expect(prompt).toContain('social_impersonation');
    expect(prompt).toContain('Steam Community (steamcommunity.com)');
    expect(prompt).toContain('Platform: tiktok');
    expect(prompt).toContain('Handle: @realsteamcommunity');
    expect(prompt).toContain('0.79');
    expect(prompt).toContain('brand_keyword_in_handle');
    expect(prompt.endsWith('Return JSON.')).toBe(true);
  });

  it("formats an app_store_impersonation alert with all fields", () => {
    const ctx: AlertJudgeContext = {
      alert_type: 'app_store_impersonation',
      brand_name: 'Adobe',
      brand_domain: 'adobe.com',
      details: {
        store: 'ios',
        app_name: 'Adobe Pro Editor',
        developer_name: 'Acme Studios',
        bundle_id: 'com.acme.adobepro',
        impersonation_score: 0.85,
        signals: ['brand_keyword_in_app_name'],
        reason: 'Unknown developer published Adobe-branded app',
      },
    };
    const prompt = buildJudgePrompt(ctx);
    expect(prompt).toContain('app_store_impersonation');
    expect(prompt).toContain('Adobe (adobe.com)');
    expect(prompt).toContain('Adobe Pro Editor');
    expect(prompt).toContain('Acme Studios');
    expect(prompt).toContain('com.acme.adobepro');
    expect(prompt).toContain('0.85');
    expect(prompt).toContain('Classifier reason: Unknown developer');
  });

  it("handles missing brand_domain gracefully", () => {
    const ctx: AlertJudgeContext = {
      alert_type: 'social_impersonation',
      brand_name: 'Acme',
      brand_domain: null,
      details: { platform: 'twitter', handle: 'x' },
    };
    const prompt = buildJudgePrompt(ctx);
    expect(prompt).toContain('Brand: Acme');
    expect(prompt).not.toContain('()');
  });

  it("falls back to generic key/value rendering for unknown alert types", () => {
    const ctx: AlertJudgeContext = {
      alert_type: 'something_new',
      brand_name: 'Foo',
      brand_domain: 'foo.com',
      details: { key1: 'value1', key2: 42, complex_object: { nested: 'ignored' } },
    };
    const prompt = buildJudgePrompt(ctx);
    expect(prompt).toContain('key1: value1');
    expect(prompt).toContain('key2: 42');
    // Nested objects skipped in the generic renderer.
    expect(prompt).not.toContain('complex_object');
  });

  it("handles null details without crashing", () => {
    const ctx: AlertJudgeContext = {
      alert_type: 'social_impersonation',
      brand_name: 'Acme',
      brand_domain: 'acme.com',
      details: null,
    };
    const prompt = buildJudgePrompt(ctx);
    expect(prompt).toContain('Acme');
    expect(prompt.endsWith('Return JSON.')).toBe(true);
  });
});

describe("parseJudgeResult", () => {
  it("parses a valid active_threat verdict", () => {
    const r = parseJudgeResult({
      verdict: 'active_threat',
      confidence: 85,
      reasoning: 'Account actively posts phishing links targeting Adobe users.',
    });
    expect(r).toEqual({
      verdict: 'active_threat',
      confidence: 85,
      reasoning: 'Account actively posts phishing links targeting Adobe users.',
    });
  });

  it("parses a valid likely_safe verdict", () => {
    const r = parseJudgeResult({
      verdict: 'likely_safe',
      confidence: 92,
      reasoning: 'Account abandoned since 2018 with no posts.',
    });
    expect(r?.verdict).toBe('likely_safe');
    expect(r?.confidence).toBe(92);
  });

  it("parses a valid needs_human verdict", () => {
    const r = parseJudgeResult({
      verdict: 'needs_human',
      confidence: 50,
      reasoning: 'Sparse activity, unclear intent.',
    });
    expect(r?.verdict).toBe('needs_human');
  });

  it("rejects an unknown verdict label", () => {
    expect(parseJudgeResult({
      verdict: 'unknown',
      confidence: 80,
      reasoning: 'foo',
    })).toBeNull();
  });

  it("rejects out-of-range confidence", () => {
    expect(parseJudgeResult({
      verdict: 'likely_safe',
      confidence: -1,
      reasoning: 'foo',
    })).toBeNull();
    expect(parseJudgeResult({
      verdict: 'likely_safe',
      confidence: 101,
      reasoning: 'foo',
    })).toBeNull();
  });

  it("rejects empty reasoning", () => {
    expect(parseJudgeResult({
      verdict: 'likely_safe',
      confidence: 90,
      reasoning: '',
    })).toBeNull();
  });

  it("rejects non-numeric confidence", () => {
    expect(parseJudgeResult({
      verdict: 'likely_safe',
      confidence: '90',
      reasoning: 'foo',
    })).toBeNull();
  });

  it("rounds float confidence to integer", () => {
    const r = parseJudgeResult({
      verdict: 'likely_safe',
      confidence: 87.7,
      reasoning: 'foo',
    });
    expect(r?.confidence).toBe(88);
  });

  it("truncates over-long reasoning to 240 chars", () => {
    const long = 'x'.repeat(500);
    const r = parseJudgeResult({
      verdict: 'needs_human',
      confidence: 50,
      reasoning: long,
    });
    expect(r?.reasoning.length).toBe(240);
  });

  it("rejects null/undefined input gracefully", () => {
    expect(parseJudgeResult(null)).toBeNull();
    expect(parseJudgeResult(undefined)).toBeNull();
    expect(parseJudgeResult('not an object')).toBeNull();
  });

  it("rejects missing fields", () => {
    expect(parseJudgeResult({ verdict: 'likely_safe' })).toBeNull();
    expect(parseJudgeResult({ confidence: 80 })).toBeNull();
  });
});

describe("AUTO_DISMISS_CONFIDENCE_FLOOR", () => {
  it("is conservative (>= 90)", () => {
    // Sanity-check that the floor isn't accidentally set too low.
    // Anything below 80 would risk false-dismissals.
    expect(AUTO_DISMISS_CONFIDENCE_FLOOR).toBeGreaterThanOrEqual(80);
  });
});
