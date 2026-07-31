// Averrow — AI-phishing phase-1 deterministic measurement core (W1.4).
//
// PURE measurement functions that turn a `spam_trap_captures` row into the
// descriptive lexical + infrastructure statistics of a
// `phishing_pattern_signals` row, plus the campaign-grain rollup into
// `campaign_pattern_stats`. Implements docs W1.0 phase-1 spec exactly.
//
// Doctrine (CLAUDE.md §1 / research doc §3.2): SQL does correlation, code
// does the SimHash-over-shingles that IS correlation, and AI does nothing
// here. This module is:
//   * PURE — no `env`, no D1, no `callAnthropic`, no `fetch`, no network,
//     no clock. Timestamps are passed in. The only async is a LOCAL
//     `crypto.subtle.digest('SHA-256', …)` for `mail_server_fingerprint`
//     (§6.2) — local computation, not I/O egress.
//   * DETERMINISTIC — same inputs → byte-identical outputs. Every constant
//     is fixed (§12) and every sampling rule is a stable sort, so the W1.5
//     writer's `INSERT … ON CONFLICT DO UPDATE` re-run is a no-op.
//
// ── THE HARD PROHIBITION (spec §0.2 rule 1) ──────────────────────────
// `ai_generated_probability` MUST remain NULL for every row this module
// produces. No statistic here — fluency_score, vocabulary_complexity,
// sentence_structure_variance, mean_pairwise_hamming, near_dup_pair_rate,
// or any blend/rescaling — may be converted into it, not by a linear map,
// a sigmoid, a threshold, or "just for the dashboard". A per-message
// perplexity/fluency-shaped score is functionally a non-native-English
// detector (Liang et al. 2023: 61.22% FPR on TOEFL essays). The
// prohibition is enforced structurally, at the TYPE level: every signals
// row types the column as the literal `null` (see `PerCaptureSignals` and
// `EvidenceOnly`), so any attempt to assign a number fails `tsc`. The
// campaign-stats table carries no such column at all.
//
// The W1.5 agent owns the D1 read/write layer + endpoints. This file is
// the pure core it calls. `phishing-signals.ts` (the shared
// AI_GENERATION_PROBABILITY_THRESHOLD constant) is intentionally left a
// SEPARATE module and is NOT re-exported here: that threshold is read only
// by the campaign-level judge of a later wave, and re-exporting it into an
// evidence-only module that structurally forbids emitting
// `ai_generated_probability` would be self-contradictory.

import { registrableDomain } from './domain-utils';

// ─── §12 Calibration constants (single exported block, all provisional) ─
//
// Threshold recalibration on a small labeled slice — NOT retraining — is
// the maintenance model (research doc §3.2). Keeping every tunable here is
// what makes recalibration a one-file change.
export const PHISHING_SIGNAL_CALIBRATION = {
  // Templating.
  SHINGLE_W: 4,
  TEMPLATE_HAMMING_MAX: 3, // sweep {2..6} on a labeled slice before settling
  MIN_TOKENS_FOR_SHINGLES: 12,
  MAX_PEER_COMPARISONS: 500,
  // Per-capture text stats.
  MIN_TOKENS_FOR_STATS: 40,
  MIN_SENTENCES_FOR_VAR: 3,
  MIN_SENTENCES_FOR_ARI: 2,
  MATTR_WINDOW: 25,
  // Corpus quality gate (§2.4).
  UNPARSEABLE_MIN_TOKENS: 10,
  UNPARSEABLE_LONG_TOKEN_RATE: 0.3,
  LONG_TOKEN_LEN: 20,
  // ARI / CV clamps (§4.3 / §4.4).
  ARI_CLAMP_MIN: 1,
  ARI_CLAMP_MAX: 16,
  CV_CLAMP_MAX: 3.0,
  // Mail-server fingerprint (§6.2).
  MAIL_FP_MIN_NAMES: 3,
  MAIL_FP_MAX_NAMES: 40,
  MAIL_FP_MAILER_CAP: 64,
  // Campaign grouping + rollup.
  CAMPAIGN_WINDOW_HOURS: 24,
  MIN_CAMPAIGN_MEMBERS: 5,
  PAIRWISE_MAX_MEMBERS: 60,
  REGIME_KIT_REUSE_RATE: 0.6,
  REGIME_MAIL_MERGE_RATE: 0.15,
  REGIME_HIGH_VAR_HAMMING: 20,
} as const;

// ─── Structural prohibition guard (spec §0.2 rule 1 / §0.3) ───────────

/**
 * The ONLY type `ai_generated_probability` may hold in anything this module
 * emits. Typing the column `null` (not `number | null`) makes it a compile
 * error to assign a computed number — the prohibition is enforced by the
 * compiler, not by convention or by a test alone.
 */
export type AiGeneratedProbability = null;

/** The single sanctioned value for the prohibited column. */
export const AI_GENERATED_PROBABILITY: AiGeneratedProbability = null;

/**
 * Forbids `ai_generated_probability` from carrying anything but `null` (or
 * being absent) on any row shape `T`. Applying it to a type that tries to
 * set a number is a `tsc` error.
 */
export type EvidenceOnly<T> = T & { ai_generated_probability?: null };

/**
 * Belt-and-braces runtime guard for the W1.5 writer: throws if a row about
 * to be persisted carries a non-null `ai_generated_probability`. The type
 * guard above already makes this unreachable from well-typed code; this
 * catches an `unknown`-typed row assembled from JSON.
 */
export function assertEvidenceOnly(row: { ai_generated_probability?: unknown }): void {
  const v = row.ai_generated_probability;
  if (v !== null && v !== undefined) {
    throw new Error(
      'phishing-pattern-signals: ai_generated_probability must remain NULL (spec §0.2 rule 1)',
    );
  }
}

// ─── §2.1 A4 Homoglyph fold — single exported table ───────────────────
//
// Bounded lookalike table (Cyrillic/Greek → Latin), NOT a general
// confusables DB. Applied AFTER lowercase, so sources are lowercase forms.
// Must be identical everywhere the template is (re)computed, or two
// renderings of one kit produce different SimHashes and the kit-reuse
// signal is destroyed by the attacker for free.
export const HOMOGLYPH_MAP: Readonly<Record<string, string>> = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ѕ: 's',
  ј: 'j', ԁ: 'd', ѵ: 'v', ԛ: 'q', ԝ: 'w', ᴏ: 'o', ɑ: 'a',
  α: 'a', ο: 'o', ρ: 'p', ε: 'e', ν: 'v', ι: 'i', κ: 'k', τ: 't', υ: 'u',
  χ: 'x', ϲ: 'c', ѐ: 'e', ё: 'e',
};

const HOMOGLYPH_RE = new RegExp(`[${Object.keys(HOMOGLYPH_MAP).join('')}]`, 'g');

/** Zero-width + bidi controls stripped entirely (§2.1 A4). */
export const ZERO_WIDTH_RE = /[​-‏‪-‮⁠-⁤﻿]/g;

// Slot delimiters (U+27E6 / U+27E7). Kept as literal constants so the
// tokenizer's allowed-char class and the slot-token detector never drift.
const SLOT_OPEN = '⟦';
const SLOT_CLOSE = '⟧';
const SLOT_TOKEN_RE = /^⟦[a-z]+⟧$/;

// ─── Public input / output contracts ──────────────────────────────────

/**
 * Everything the pure core reads for one capture. The W1.5 I/O layer
 * assembles this from a `spam_trap_captures` row plus the joined `threats`
 * row (for `threatCampaignId`) and `brands` row (for `brandName`). Fields
 * that are pure passthroughs onto the signals row and require no
 * computation (`sender_asn`, `sender_asn_org`, `ssl_cert_issuer`,
 * `domain_age_days`) are the writer's concern (§6.3/§6.5) and are not read
 * here.
 */
export interface CaptureInput {
  captureId: number;
  subject: string | null;
  bodyPreview: string | null;
  rawHeaders: string | null;
  urlsFound: string | null; // JSON array text
  sendingIp: string | null;
  fromAddress: string | null;
  fromDomain: string | null;
  heloHostname: string | null;
  xMailer: string | null;
  trapAddress: string | null;
  spoofedBrandId: string | null;
  spoofedDomain: string | null;
  brandMatchMethod: string | null;
  brandName: string | null; // joined from brands.name
  threatId: string | null;
  threatCampaignId: string | null; // joined threats.campaign_id (rule 1)
  capturedAt: string | null; // 'YYYY-MM-DD HH:MM:SS' UTC
}

/**
 * The computed columns of one `phishing_pattern_signals` row. The four
 * literal-`null` fields state the phase-1 contract explicitly; the
 * threat-join passthroughs (`sender_asn`, etc.) are added by the W1.5
 * writer and are deliberately absent here.
 */
export interface PerCaptureSignals {
  capture_id: number;
  fluency_score: number | null;
  template_detected: 0 | 1;
  template_hash: string | null;
  vocabulary_complexity: number | null;
  sentence_structure_variance: number | null;
  url_obfuscation_type: string | null;
  redirect_chain_depth: null; // §6.4 — requires egress
  landing_page_hash: null; // §6.4 — requires egress
  sender_ip: string | null;
  mail_server_fingerprint: string | null;
  brand_targeted: string | null;
  impersonation_technique: string | null;
  visual_similarity_score: null; // §6.4 — requires rendering
  ai_generated_probability: AiGeneratedProbability; // §0.2 rule 1 — always null
  classification: 'measured_v1' | 'insufficient_text_v1' | 'unparseable_v1';
  campaign_key: string | null;
  campaign_key_kind: CampaignKeyKind | null;
}

// ─── §2 Slot context + normalization pipeline ─────────────────────────

interface SlotContext {
  brandActive: boolean; // spoofed_brand_id IS NOT NULL
  brandNeedles: string[]; // brand name + spoofed SLD label (>=4), lowercased
  nameNeedles: string[]; // identity parts (>=3), lowercased
}

function sldLabel(host: string | null): string | null {
  if (!host) return null;
  const rd = registrableDomain(host);
  if (!rd) return null;
  const first = rd.split('.')[0];
  return first && first.length > 0 ? first : null;
}

function domainOfAddress(addr: string | null): string | null {
  if (!addr) return null;
  const at = addr.lastIndexOf('@');
  if (at < 0) return null;
  const dom = addr.slice(at + 1).trim().toLowerCase();
  return dom.length > 0 ? dom : null;
}

function localPartOfAddress(addr: string | null): string | null {
  if (!addr) return null;
  const at = addr.indexOf('@');
  const local = (at < 0 ? addr : addr.slice(0, at)).trim().toLowerCase();
  return local.length > 0 ? local : null;
}

/** Build the slot context (§2.1 steps 8–9) from the capture identifiers. */
export function buildSlotContext(input: CaptureInput): SlotContext {
  const brandActive = input.spoofedBrandId != null;
  const brandNeedles: string[] = [];
  if (brandActive) {
    if (input.brandName) {
      const n = input.brandName.trim().toLowerCase();
      if (n.length >= 4) brandNeedles.push(n);
    }
    const bSld = sldLabel(input.spoofedDomain);
    if (bSld && bSld.length >= 4) brandNeedles.push(bSld);
  }

  const nameParts = new Set<string>();
  const addPart = (raw: string | null): void => {
    if (!raw) return;
    for (const part of raw.split(/[._-]/)) {
      const p = part.trim().toLowerCase();
      if (p.length >= 3) nameParts.add(p);
    }
  };
  addPart(localPartOfAddress(input.trapAddress));
  addPart(localPartOfAddress(input.fromAddress));
  addPart(sldLabel(domainOfAddress(input.trapAddress)));
  addPart(sldLabel(input.fromDomain));

  return { brandActive, brandNeedles, nameNeedles: [...nameParts] };
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
  '&#39;': "'", '&nbsp;': ' ', '&zwnj;': '', '&zwj;': '',
};

function decodeEntities(s: string): string {
  let out = s;
  for (const [ent, rep] of Object.entries(NAMED_ENTITIES)) {
    out = out.split(ent).join(rep);
  }
  out = out.replace(/&#(\d{1,6});/g, (_m, d: string) => codePoint(parseInt(d, 10)));
  out = out.replace(/&#x([0-9a-f]{1,5});/gi, (_m, h: string) => codePoint(parseInt(h, 16)));
  return out;
}

function codePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-word slot replacement that does NOT corrupt existing slot tokens:
 * the boundary treats a-z/0-9/'/slot-delimiters as "word" chars, so a
 * needle equal to a slot name (e.g. an identity part "name") can never
 * match inside `⟦name⟧`, and "acme" never matches inside "acmecorp".
 */
function slotWholeWord(text: string, needle: string, slot: string): string {
  const n = needle.trim();
  if (n.length === 0) return text;
  const re = new RegExp(
    `(?<![a-z0-9'${SLOT_OPEN}])${escapeRe(n)}(?![a-z0-9'${SLOT_CLOSE}])`,
    'g',
  );
  return text.replace(re, slot);
}

const URL_HTTP_RE = /https?:\/\/[^\s<>"')\]]+/g;
const URL_WWW_RE = /\bwww\.[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s<>"')\]]*)?/g;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g;
const MONEY_PREFIX_RE = /(?:[$€£¥]|\b(?:usd|eur|gbp|cad|aud)\b)\s?\d[\d,]*(?:\.\d{2})?/g;
const MONEY_SUFFIX_RE = /\d[\d,]*(?:\.\d{2})?\s?(?:usd|eur|gbp|cad|aud)\b/g;
const DATE_ISO_RE = /\d{4}-\d{2}-\d{2}/g;
const DATE_NUM_RE = /\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/g;
const DATE_MONTH_RE =
  /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}/g;
const TIME_RE = /\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:am|pm)?\b/g;
const ID_ALNUM_RE = /\b(?=[a-z0-9-]{8,})(?=[a-z0-9-]*\d)[a-z0-9-]{8,}\b/g;
const ID_LONGNUM_RE = /\b\d{6,}\b/g;

/**
 * §2.1 Stage A — NFKC → strip markup → lowercase → homoglyph fold →
 * ordered slotting. Punctuation preserved. The slotting order is
 * load-bearing (URLs contain digits and `@`; emails contain dots; IDs
 * contain digits) — do not reorder.
 */
export function stageASlot(raw: string, ctx: SlotContext): string {
  // A1 — Unicode normalize.
  let s = raw.normalize('NFKC');

  // A2 — strip markup.
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<[^>]{0,300}>/g, ' ');
  s = decodeEntities(s);

  // A3 — lowercase.
  s = s.toLowerCase();

  // A4 — homoglyph fold + zero-width strip.
  s = s.replace(HOMOGLYPH_RE, (ch) => HOMOGLYPH_MAP[ch] ?? ch);
  s = s.replace(ZERO_WIDTH_RE, '');

  // A5 — slotting (order 1..10).
  s = s.replace(URL_HTTP_RE, `${SLOT_OPEN}url${SLOT_CLOSE}`);
  s = s.replace(URL_WWW_RE, `${SLOT_OPEN}url${SLOT_CLOSE}`);
  s = s.replace(EMAIL_RE, `${SLOT_OPEN}email${SLOT_CLOSE}`);
  s = s.replace(MONEY_PREFIX_RE, `${SLOT_OPEN}money${SLOT_CLOSE}`);
  s = s.replace(MONEY_SUFFIX_RE, `${SLOT_OPEN}money${SLOT_CLOSE}`);
  s = s.replace(DATE_ISO_RE, `${SLOT_OPEN}date${SLOT_CLOSE}`);
  s = s.replace(DATE_NUM_RE, `${SLOT_OPEN}date${SLOT_CLOSE}`);
  s = s.replace(DATE_MONTH_RE, `${SLOT_OPEN}date${SLOT_CLOSE}`);
  s = s.replace(TIME_RE, `${SLOT_OPEN}time${SLOT_CLOSE}`);
  s = s.replace(ID_ALNUM_RE, `${SLOT_OPEN}id${SLOT_CLOSE}`);
  s = s.replace(ID_LONGNUM_RE, `${SLOT_OPEN}id${SLOT_CLOSE}`);
  if (ctx.brandActive) {
    for (const needle of ctx.brandNeedles) {
      s = slotWholeWord(s, needle, `${SLOT_OPEN}brand${SLOT_CLOSE}`);
    }
  }
  for (const needle of ctx.nameNeedles) {
    s = slotWholeWord(s, needle, `${SLOT_OPEN}name${SLOT_CLOSE}`);
  }
  s = s.replace(/\d+/g, `${SLOT_OPEN}num${SLOT_CLOSE}`);

  return s;
}

const TOKEN_STRIP_RE = new RegExp(`[^a-z0-9'${SLOT_OPEN}${SLOT_CLOSE}]`, 'g');

/**
 * §2.3 Stage C — tokenization. `dropFinal` applies the bodyTruncated
 * partial-word drop and is used only for the whole-corpus stream, never
 * per-segment.
 */
export function tokenize(text: string, dropFinal: boolean): string[] {
  const cleaned = text.replace(TOKEN_STRIP_RE, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return [];
  const tokens: string[] = [];
  for (const rawTok of cleaned.split(' ')) {
    const t = rawTok.replace(/^'+|'+$/g, '');
    if (t.length > 0) tokens.push(t);
  }
  if (dropFinal && tokens.length > 0) tokens.pop();
  return tokens;
}

function isSlotToken(t: string): boolean {
  return SLOT_TOKEN_RE.test(t);
}

export interface NormalizedCorpus {
  slottedText: string;
  allTokens: string[];
  contentTokens: string[];
  sentences: string[][]; // token arrays, >=2 tokens each
  usableSentences: number;
  bodyTruncated: boolean;
  longTokenRate: number;
  unparseable: boolean;
}

/** §2 full pipeline: corpus assembly → Stage A → Stage B → Stage C. */
export function normalizeCorpus(input: CaptureInput, ctx: SlotContext): NormalizedCorpus {
  const body = input.bodyPreview ?? '';
  const bodyTruncated = body.length === 500;
  const raw = `${input.subject ?? ''}\n${body}`;

  const slottedText = stageASlot(raw, ctx);

  // Stage C — whole-corpus streams.
  const allTokens = tokenize(slottedText, bodyTruncated);
  const contentTokens = allTokens.filter((t) => !isSlotToken(t));

  // Stage B — sentence segmentation.
  const segments: string[][] = [];
  for (const line of slottedText.split(/\n+/)) {
    for (const seg of line.split(/(?<=[.!?…])\s+/)) {
      const trimmed = seg.trim();
      if (trimmed.length === 0) continue;
      const toks = tokenize(trimmed, false);
      if (toks.length >= 2) segments.push(toks);
    }
  }
  // §2.2 step 5 — drop the final segment on a mid-sentence 500-char cut.
  if (bodyTruncated && segments.length > 0 && !/[.!?…]$/.test(slottedText.trimEnd())) {
    segments.pop();
  }

  // §2.4 corpus quality gate.
  const cal = PHISHING_SIGNAL_CALIBRATION;
  let longCount = 0;
  for (const t of allTokens) if (t.length >= cal.LONG_TOKEN_LEN) longCount++;
  const longTokenRate = allTokens.length > 0 ? longCount / allTokens.length : 0;
  const unparseable =
    allTokens.length >= cal.UNPARSEABLE_MIN_TOKENS && longTokenRate >= cal.UNPARSEABLE_LONG_TOKEN_RATE;

  return {
    slottedText,
    allTokens,
    contentTokens,
    sentences: segments,
    usableSentences: segments.length,
    bodyTruncated,
    longTokenRate,
    unparseable,
  };
}

// ─── §3 Shingling, FNV-1a, SimHash, template_hash, Hamming ────────────

const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x00000100000001b3n;
const MASK64 = (1n << 64n) - 1n;

/** §3.2 FNV-1a, 64-bit, over UTF-8 bytes. Returns a masked BigInt. */
export function fnv1a64(s: string): bigint {
  const bytes = new TextEncoder().encode(s);
  let h = FNV64_OFFSET;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * FNV64_PRIME) & MASK64;
  }
  return h;
}

/** §3.1 word 4-grams over `allTokens`, deduplicated (presence-weighted). */
export function shingles(allTokens: string[], width = PHISHING_SIGNAL_CALIBRATION.SHINGLE_W): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i + width <= allTokens.length; i++) {
    set.add(allTokens.slice(i, i + width).join(' '));
  }
  return set;
}

/** §3.3 SimHash-64. Tie rule: a zero column contributes bit 0. */
export function simhash64(shingleSet: Iterable<string>): bigint {
  const v: number[] = new Array<number>(64).fill(0);
  for (const sh of shingleSet) {
    const h = fnv1a64(sh);
    for (let b = 0; b < 64; b++) {
      const bit = (h >> BigInt(b)) & 1n;
      v[b] = (v[b] ?? 0) + (bit === 1n ? 1 : -1);
    }
  }
  let out = 0n;
  for (let b = 0; b < 64; b++) {
    if ((v[b] ?? 0) > 0) out |= 1n << BigInt(b);
  }
  return out;
}

/** §3.5 Hamming distance over 64 bits (Brian Kernighan popcount on XOR). */
export function hamming64(a: bigint, b: bigint): number {
  let x = (a ^ b) & MASK64;
  let n = 0;
  while (x !== 0n) {
    x &= x - 1n;
    n++;
  }
  return n;
}

/** §3.4 `template_hash` = `t1:<16 lowercase hex>`, or null below the floor. */
export function computeTemplateHash(
  allTokens: string[],
  minTokens = PHISHING_SIGNAL_CALIBRATION.MIN_TOKENS_FOR_SHINGLES,
): string | null {
  if (allTokens.length < minTokens) return null;
  const set = shingles(allTokens);
  if (set.size === 0) return null;
  const sim = simhash64(set);
  return `t1:${sim.toString(16).padStart(16, '0')}`;
}

const TEMPLATE_HASH_RE = /^t1:[0-9a-f]{16}$/;

/** Parse a `t1:<hex>` template_hash back to a BigInt; null on any other shape. */
export function parseTemplateHash(hash: string | null): bigint | null {
  if (!hash || !TEMPLATE_HASH_RE.test(hash)) return null;
  return BigInt(`0x${hash.slice(3)}`) & MASK64;
}

/** §3.5 "same template" ⇔ Hamming ≤ TEMPLATE_HAMMING_MAX (inclusive). */
export function sameTemplate(
  a: string | null,
  b: string | null,
  max = PHISHING_SIGNAL_CALIBRATION.TEMPLATE_HAMMING_MAX,
): boolean {
  const ba = parseTemplateHash(a);
  const bb = parseTemplateHash(b);
  if (ba === null || bb === null) return false;
  return hamming64(ba, bb) <= max;
}

/**
 * §3.6 Insert-time `template_detected` seed. 1 iff at least one OTHER peer's
 * hash is within the threshold. NULL-safe: a null self-hash → 0; null peers
 * are skipped. The caller bounds `peerHashes` to MAX_PEER_COMPARISONS. The
 * authoritative value is re-stamped by the campaign rollup (§8.6).
 */
export function computeTemplateDetected(
  selfHash: string | null,
  peerHashes: ReadonlyArray<string | null>,
  max = PHISHING_SIGNAL_CALIBRATION.TEMPLATE_HAMMING_MAX,
): 0 | 1 {
  const self = parseTemplateHash(selfHash);
  if (self === null) return 0;
  for (const peer of peerHashes) {
    const p = parseTemplateHash(peer);
    if (p === null) continue;
    if (hamming64(self, p) <= max) return 1;
  }
  return 0;
}

// ─── §4 Per-capture text statistics ───────────────────────────────────

/** Round to 4 decimals; NaN / ±Infinity → null (spec §4.5 — never 0). */
function round4(x: number): number | null {
  if (!Number.isFinite(x)) return null;
  return Math.round(x * 1e4) / 1e4;
}

/** §4.2 MATTR-25 over `contentTokens`. NULL below the 40-token floor. */
export function vocabularyComplexity(
  contentTokens: string[],
  window = PHISHING_SIGNAL_CALIBRATION.MATTR_WINDOW,
  minTokens = PHISHING_SIGNAL_CALIBRATION.MIN_TOKENS_FOR_STATS,
): number | null {
  if (contentTokens.length < minTokens) return null;
  const windows = contentTokens.length - window + 1;
  if (windows <= 0) return null;
  let sum = 0;
  for (let i = 0; i < windows; i++) {
    const seen = new Set<string>();
    for (let j = i; j < i + window; j++) {
      const tok = contentTokens[j];
      if (tok !== undefined) seen.add(tok);
    }
    sum += seen.size / window;
  }
  return round4(sum / windows);
}

/** §4.3 CV of sentence token-length. NULL below the 3-sentence floor. */
export function sentenceStructureVariance(
  sentences: string[][],
  minSentences = PHISHING_SIGNAL_CALIBRATION.MIN_SENTENCES_FOR_VAR,
  clampMax = PHISHING_SIGNAL_CALIBRATION.CV_CLAMP_MAX,
): number | null {
  const k = sentences.length;
  if (k < minSentences) return null;
  const lengths = sentences.map((s) => s.length);
  const mean = lengths.reduce((a, b) => a + b, 0) / k;
  if (mean <= 0) return null;
  let sq = 0;
  for (const L of lengths) sq += (L - mean) * (L - mean);
  const sd = Math.sqrt(sq / k); // population sd
  const cv = sd / mean;
  return round4(Math.min(cv, clampMax));
}

function tokenChars(t: string): number {
  if (isSlotToken(t)) return 5; // slot counts as fixed 1 word / 5 chars
  let n = 0;
  for (const ch of t) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) n++;
  }
  return n;
}

/**
 * §4.4 `fluency_score` — Automated Readability Index, normalized to [0,1]
 * where 1.0 = simplest/most-readable surface. NULL below the floors.
 *
 * DESCRIPTIVE SURFACE-READABILITY STATISTIC ONLY. A high value does NOT
 * indicate machine authorship. A low value does NOT indicate human
 * authorship. A high value must NEVER be read as "non-native speaker".
 * This value must not gate any triage, dismissal, alerting, or
 * customer-facing verdict, and must never be transformed into
 * `ai_generated_probability`. See docs/AI_PHISHING_DETECTION_RESEARCH_2026-07 §3.1.
 * The column name (`fluency_score`, migration 0023) is legacy and
 * misleading: this is NOT perplexity and NOT a language-model score.
 */
export function fluencyScore(
  allTokens: string[],
  usableSentences: number,
  opts?: { minTokens?: number; minSentences?: number; clampMin?: number; clampMax?: number },
): number | null {
  const cal = PHISHING_SIGNAL_CALIBRATION;
  const minTokens = opts?.minTokens ?? cal.MIN_TOKENS_FOR_STATS;
  const minSentences = opts?.minSentences ?? cal.MIN_SENTENCES_FOR_ARI;
  const clampMin = opts?.clampMin ?? cal.ARI_CLAMP_MIN;
  const clampMax = opts?.clampMax ?? cal.ARI_CLAMP_MAX;
  if (allTokens.length < minTokens || usableSentences < minSentences) return null;

  let chars = 0;
  for (const t of allTokens) chars += tokenChars(t);
  const words = allTokens.length;
  const sents = usableSentences;
  if (words <= 0 || sents <= 0) return null;

  const ari = 4.71 * (chars / words) + 0.5 * (words / sents) - 21.43;
  const ariC = Math.min(Math.max(ari, clampMin), clampMax);
  return round4((clampMax - ariC) / (clampMax - clampMin));
}

// ─── §6.2 mail_server_fingerprint (deterministic, local SHA-256) ──────

const MAIL_FP_DROP_EXACT: ReadonlySet<string> = new Set([
  'received', 'date', 'message-id', 'subject', 'to', 'from', 'cc', 'bcc',
  'reply-to', 'return-path', 'authentication-results', 'dkim-signature',
  'content-length',
]);

const MAIL_FP_DROP_RE = [
  /^arc-/,
  /^x-google-/,
  /^x-received/,
  /^(x-)?(spam|virus|scan|barracuda|forefront|microsoft-antispam|proofpoint|mimecast)/,
];

function mailFieldDropped(name: string): boolean {
  if (MAIL_FP_DROP_EXACT.has(name)) return true;
  return MAIL_FP_DROP_RE.some((re) => re.test(name));
}

/** Ordered lowercase header field names after unfolding (§6.2 step 1). */
function orderedHeaderNames(rawHeaders: string): string[] {
  const unfolded = rawHeaders.replace(/\r?\n(\s+)/g, ' ');
  const names: string[] = [];
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (name.length > 0) names.push(name);
  }
  return names;
}

function normalizeMailer(xMailer: string | null, cap: number): string {
  if (!xMailer) return '';
  return xMailer.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, cap);
}

/** HELO skeleton: digit-runs → '#' within each label, registrable labels intact. */
function heloSkeleton(helo: string | null): string {
  if (!helo) return '';
  const h = helo.trim().toLowerCase();
  if (h.length === 0) return '';
  const labels = h.split('.');
  const rd = registrableDomain(h);
  const keep = rd ? rd.split('.').length : 0;
  const cut = Math.max(0, labels.length - keep);
  return labels
    .map((label, i) => (i < cut ? label.replace(/\d+/g, '#') : label))
    .join('.');
}

async function sha256hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * §6.2 `mail_server_fingerprint` = `m1:<16 hex>` from the sending-stack
 * shape (surviving header order + normalized x-mailer + HELO skeleton).
 * NULL when raw_headers is empty or fewer than MAIL_FP_MIN_NAMES names
 * survive the drop-list. Deterministic; the only async in the module.
 */
export async function mailServerFingerprint(
  rawHeaders: string | null,
  xMailer: string | null,
  heloHostname: string | null,
): Promise<string | null> {
  const cal = PHISHING_SIGNAL_CALIBRATION;
  if (!rawHeaders || rawHeaders.trim().length === 0) return null;

  const kept: string[] = [];
  let prev = '';
  for (const name of orderedHeaderNames(rawHeaders)) {
    if (mailFieldDropped(name)) continue;
    if (name === prev) continue; // collapse consecutive duplicates
    kept.push(name);
    prev = name;
    if (kept.length >= cal.MAIL_FP_MAX_NAMES) break;
  }
  if (kept.length < cal.MAIL_FP_MIN_NAMES) return null;

  const mailer = normalizeMailer(xMailer, cal.MAIL_FP_MAILER_CAP);
  const helo = heloSkeleton(heloHostname);
  const composed = `mua=${mailer}|helo=${helo}|hdr=${kept.join(',')}`;
  const hex = await sha256hex(composed);
  return `m1:${hex.slice(0, 16)}`;
}

// ─── §5.1 url_obfuscation_type ─────────────────────────────────────────

const SHORTENER_DOMAINS: ReadonlySet<string> = new Set([
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly',
  'cutt.ly', 'rb.gy', 'rebrand.ly', 'shorturl.at', 's.id', 'lnkd.in',
  'tiny.cc', 't.ly', 'shorturl.com', 'snip.ly', 'trib.al',
]);

const OPEN_REDIRECT_PARAMS: ReadonlySet<string> = new Set([
  'url', 'redirect', 'redirect_uri', 'redirect_url', 'next', 'target',
  'dest', 'destination', 'continue', 'return', 'returnurl', 'r', 'u',
  'link', 'goto', 'out',
]);

const OBFUSCATION_BY_PRECEDENCE: readonly string[] = [
  'ip_literal', 'punycode_host', 'userinfo_at', 'open_redirect',
  'encoded_path', 'shortener', 'brand_in_subdomain', 'deep_subdomain',
  'nonstandard_port',
];

interface ParsedUrl {
  host: string;
  hasUserinfo: boolean;
  port: string;
  pathQuery: string;
  bracketedV6: boolean;
}

function parseUrlString(u: string): ParsedUrl | null {
  const trimmed = u.trim();
  if (trimmed.length === 0) return null;
  let rest = trimmed;
  const scheme = rest.match(/^[a-z][a-z0-9+.-]*:\/\//i);
  if (scheme) rest = rest.slice(scheme[0].length);
  const authEnd = rest.search(/[/?#]/);
  const authority = authEnd < 0 ? rest : rest.slice(0, authEnd);
  const pathQuery = authEnd < 0 ? '' : rest.slice(authEnd);
  if (authority.length === 0) return null;

  const at = authority.lastIndexOf('@');
  const hasUserinfo = at >= 0;
  const hostport = hasUserinfo ? authority.slice(at + 1) : authority;

  let host = '';
  let port = '';
  let bracketedV6 = false;
  if (hostport.startsWith('[')) {
    const close = hostport.indexOf(']');
    if (close > 0) {
      host = hostport.slice(1, close).toLowerCase();
      bracketedV6 = true;
      const after = hostport.slice(close + 1);
      if (after.startsWith(':')) port = after.slice(1);
    } else {
      host = hostport.toLowerCase();
    }
  } else {
    const colon = hostport.lastIndexOf(':');
    if (colon >= 0 && /^\d+$/.test(hostport.slice(colon + 1))) {
      host = hostport.slice(0, colon).toLowerCase();
      port = hostport.slice(colon + 1);
    } else {
      host = hostport.toLowerCase();
    }
  }
  if (host.length === 0) return null;
  return { host, hasUserinfo, port, pathQuery, bracketedV6 };
}

function isIpLiteralHost(p: ParsedUrl): boolean {
  if (p.bracketedV6) return true;
  const h = p.host;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  if (/^0x[0-9a-f]+$/.test(h)) return true;
  if (/^\d{5,}$/.test(h)) return true;
  return false;
}

function queryPairs(pathQuery: string): Array<{ name: string; value: string }> {
  const q = pathQuery.indexOf('?');
  if (q < 0) return [];
  let query = pathQuery.slice(q + 1);
  const hash = query.indexOf('#');
  if (hash >= 0) query = query.slice(0, hash);
  const pairs: Array<{ name: string; value: string }> = [];
  for (const part of query.split('&')) {
    if (part.length === 0) continue;
    const eq = part.indexOf('=');
    const name = (eq < 0 ? part : part.slice(0, eq)).toLowerCase();
    const value = eq < 0 ? '' : part.slice(eq + 1);
    pairs.push({ name, value });
  }
  return pairs;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

interface UrlObfuscationContext {
  brandNeedles: string[]; // >=4 char needles for brand_in_subdomain
  spoofedDomain: string | null;
}

/** Lowest-precedence (1 wins) obfuscation class for a single URL, or null. */
function classifyOneUrl(u: string, ctx: UrlObfuscationContext): number | null {
  const p = parseUrlString(u);
  if (!p) return null;
  const labels = p.host.split('.').filter((l) => l.length > 0);

  if (isIpLiteralHost(p)) return 1;
  if (labels.some((l) => l.startsWith('xn--'))) return 2;
  if (p.hasUserinfo) return 3;

  for (const { name, value } of queryPairs(p.pathQuery)) {
    if (!OPEN_REDIRECT_PARAMS.has(name)) continue;
    const decoded = safeDecode(value).toLowerCase();
    const rawLower = value.toLowerCase();
    if (decoded.includes('http') || decoded.includes('%3a%2f%2f') || rawLower.includes('%3a%2f%2f')) {
      return 4;
    }
  }

  const pct = p.pathQuery.match(/%[0-9a-f]{2}/gi);
  if (/%25/i.test(p.pathQuery) || (pct !== null && pct.length >= 3)) return 5;

  const rd = registrableDomain(p.host);
  if (rd && SHORTENER_DOMAINS.has(rd)) return 6;

  if (ctx.brandNeedles.length > 0) {
    const inLabel = labels.some((label) => ctx.brandNeedles.some((n) => label.includes(n)));
    if (inLabel) {
      const rdSpoof = registrableDomain(ctx.spoofedDomain ?? '');
      if (rd !== rdSpoof) return 7;
    }
  }

  if (rd) {
    const registrableLabels = rd.split('.').length;
    if (labels.length - registrableLabels >= 4) return 8;
  }

  if (p.port !== '' && p.port !== '80' && p.port !== '443') return 9;

  return null; // present but unmatched → caller maps to 'none'
}

/**
 * §5.1 `url_obfuscation_type`. Highest-precedence class across all URLs.
 * NULL when urls_found is NULL, not a JSON array, parse-failed, or empty.
 * 'none' when ≥1 URL is present but nothing matched.
 *
 * Phase-1 limitation (single-valued TEXT): co-occurring techniques are
 * lost. A later migration adds a JSON-array column rather than overloading
 * this one with a delimiter.
 */
export function urlObfuscationType(
  urlsFound: string | null,
  input: Pick<CaptureInput, 'brandName' | 'spoofedDomain' | 'spoofedBrandId'>,
): string | null {
  if (!urlsFound) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(urlsFound);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const urls = parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (urls.length === 0) return null;

  const brandNeedles: string[] = [];
  if (input.spoofedBrandId != null && input.brandName) {
    const n = input.brandName.trim().toLowerCase();
    if (n.length >= 4) brandNeedles.push(n);
  }
  const bSld = sldLabel(input.spoofedDomain);
  if (bSld && bSld.length >= 4) brandNeedles.push(bSld);

  const ctx: UrlObfuscationContext = { brandNeedles, spoofedDomain: input.spoofedDomain };

  let best: number | null = null;
  for (const u of urls) {
    const prec = classifyOneUrl(u, ctx);
    if (prec !== null && (best === null || prec < best)) best = prec;
    if (best === 1) break; // highest precedence, cannot improve
  }
  if (best === null) return 'none';
  return OBFUSCATION_BY_PRECEDENCE[best - 1] ?? 'none';
}

// ─── §5.3 impersonation_technique ──────────────────────────────────────

const FREEMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'msn.com', 'yahoo.com', 'ymail.com', 'aol.com', 'icloud.com', 'me.com',
  'proton.me', 'protonmail.com', 'gmx.com', 'gmx.net', 'mail.com',
  'mail.ru', 'yandex.ru', 'zoho.com', 'tutanota.com',
]);

/**
 * §5.3 `impersonation_technique` — ordered, first match wins. NULL when no
 * brand matched. Describes the technique SHAPE, not a verdict: an
 * `exact_domain_spoof` is only a spoof once the auth results (on the
 * capture row, not here) rule out a legitimate forward.
 */
export function impersonationTechnique(
  input: Pick<CaptureInput, 'spoofedBrandId' | 'fromDomain' | 'spoofedDomain' | 'brandMatchMethod'>,
): string | null {
  if (input.spoofedBrandId == null) return null;
  const rdFrom = registrableDomain(input.fromDomain ?? '');
  const rdSpoof = registrableDomain(input.spoofedDomain ?? '');
  const method = input.brandMatchMethod;

  if (rdFrom && rdSpoof && rdFrom === rdSpoof) return 'exact_domain_spoof';
  if (rdFrom && FREEMAIL_DOMAINS.has(rdFrom)) return 'freemail_display_name';
  if (method === 'from_header') return 'lookalike_domain';
  if (method === 'reply_to') return 'reply_to_spoof';
  if (method === 'url') return 'url_lure';
  if (method === 'subject') return 'subject_lure';
  return 'unclassified';
}

// ─── §7 Campaign grouping key ──────────────────────────────────────────

export type CampaignKeyKind = 'campaign' | 'brand_domain' | 'sending_ip' | 'from_domain';

export interface CampaignKeyResult {
  campaign_key: string | null;
  campaign_key_kind: CampaignKeyKind | null;
}

/** UTC-day tumbling bucket 'YYYY-MM-DD' from a 'YYYY-MM-DD HH:MM:SS' stamp. */
export function windowBucket(capturedAt: string | null): string | null {
  if (!capturedAt || capturedAt.length < 10) return null;
  const bucket = capturedAt.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(bucket) ? bucket : null;
}

/**
 * §7.2 campaign key in precedence order c: → b: → i: → d: → NULL. The
 * per-capture row is written regardless; a NULL key just means the capture
 * joins no rollup. Rules 2/4 fall through when registrableDomain is NULL
 * (IP literal / single-label host).
 */
export function deriveCampaignKey(input: CaptureInput): CampaignKeyResult {
  const bucket = windowBucket(input.capturedAt);
  if (!bucket) return { campaign_key: null, campaign_key_kind: null };

  if (input.threatId != null && input.threatCampaignId != null) {
    return { campaign_key: `c:${input.threatCampaignId}|${bucket}`, campaign_key_kind: 'campaign' };
  }

  const rdFrom = registrableDomain(input.fromDomain ?? '');
  if (input.spoofedBrandId != null && input.fromDomain != null && rdFrom) {
    return {
      campaign_key: `b:${input.spoofedBrandId}|${rdFrom}|${bucket}`,
      campaign_key_kind: 'brand_domain',
    };
  }

  if (input.sendingIp != null) {
    return { campaign_key: `i:${input.sendingIp}|${bucket}`, campaign_key_kind: 'sending_ip' };
  }

  if (input.fromDomain != null && rdFrom) {
    return { campaign_key: `d:${rdFrom}|${bucket}`, campaign_key_kind: 'from_domain' };
  }

  return { campaign_key: null, campaign_key_kind: null };
}

/**
 * §8.3 FNV-1a hex of the Stage-A-slotted SUBJECT alone (whitespace
 * collapsed). The rollup counts these distinct to separate "one subject,
 * many bodies" (mail-merge tell) from "many subjects". Null when the
 * subject is empty after slotting. Carried onto the rollup member row by
 * the W1.5 writer — it is not a persisted `phishing_pattern_signals`
 * column.
 */
export function slottedSubjectHash(subject: string | null, ctx: SlotContext): string | null {
  if (!subject) return null;
  const slotted = stageASlot(subject, ctx).replace(/\s+/g, ' ').trim();
  if (slotted.length === 0) return null;
  return fnv1a64(slotted).toString(16).padStart(16, '0');
}

// ─── §8 Campaign rollup aggregation ────────────────────────────────────

export type PolymorphismRegime =
  | 'insufficient'
  | 'kit_reuse'
  | 'mail_merge'
  | 'high_variance'
  | 'mixed';

/** One member's signals as read back for the rollup (a persisted signals
 *  row plus the writer-derived `subject_slot_hash`). */
export interface CampaignMemberSignal {
  capture_id: number;
  captured_at: string | null; // 'YYYY-MM-DD HH:MM:SS'
  template_hash: string | null;
  vocabulary_complexity: number | null;
  sentence_structure_variance: number | null;
  fluency_score: number | null;
  sending_ip: string | null;
  from_domain: string | null;
  sender_asn: string | null;
  mail_server_fingerprint: string | null;
  subject_slot_hash: string | null;
}

export interface CampaignPatternStats {
  campaign_key: string;
  campaign_key_kind: string;
  window_bucket: string;
  window_start: string | null;
  window_end: string | null;
  time_window_seconds: number | null;

  member_count: number;
  hashed_member_count: number;
  stats_member_count: number;

  distinct_template_hashes: number | null;
  distinct_template_ratio: number | null;
  largest_template_share: number | null;
  mean_pairwise_hamming: number | null;
  sd_pairwise_hamming: number | null;
  near_dup_pair_rate: number | null;
  pairwise_sample_size: number | null;

  distinct_sending_ips: number;
  distinct_from_domains: number;
  distinct_asns: number;
  distinct_mail_fingerprints: number;
  distinct_subject_hashes: number;

  mean_vocabulary_complexity: number | null;
  mean_sentence_structure_variance: number | null;
  mean_fluency_score: number | null;

  polymorphism_regime: PolymorphismRegime;
}

export interface CampaignRollupResult {
  stats: CampaignPatternStats;
  /** §8.6 / §3.6 authoritative re-stamp: capture_id → template_detected. */
  templateDetectedByCapture: Map<number, 0 | 1>;
}

function distinctNonNull(values: ReadonlyArray<string | null>): number {
  const set = new Set<string>();
  for (const v of values) if (v != null && v.length > 0) set.add(v);
  return set.size;
}

function meanNonNull(values: ReadonlyArray<number | null>): number | null {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (nums.length === 0) return null;
  return round4(nums.reduce((a, b) => a + b, 0) / nums.length);
}

function parseUtcSeconds(s: string | null): number | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  const ms = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +se!);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * §8.6 / §3.6 authoritative `template_detected`: 1 iff another hashed
 * member shares a template within the threshold. Exact-hash duplicates are
 * resolved in O(h); only exact-hash singletons need pairwise Hamming, so
 * the cost is O(k²) over the (small) distinct-hash set, not O(h²).
 */
function restampTemplateDetected(
  members: CampaignMemberSignal[],
  max: number,
): Map<number, 0 | 1> {
  const result = new Map<number, 0 | 1>();
  // Default every member to 0 (null-hash members stay 0 permanently).
  for (const m of members) result.set(m.capture_id, 0);

  const byExact = new Map<string, CampaignMemberSignal[]>();
  for (const m of members) {
    const bh = parseTemplateHash(m.template_hash);
    if (bh === null) continue;
    const list = byExact.get(m.template_hash!) ?? [];
    list.push(m);
    byExact.set(m.template_hash!, list);
  }

  const singletons: Array<{ id: number; hash: bigint }> = [];
  for (const [hashStr, group] of byExact) {
    if (group.length >= 2) {
      for (const m of group) result.set(m.capture_id, 1); // exact duplicate
    } else {
      const only = group[0]!;
      singletons.push({ id: only.capture_id, hash: parseTemplateHash(hashStr)! });
    }
  }

  for (let i = 0; i < singletons.length; i++) {
    const a = singletons[i]!;
    if (result.get(a.id) === 1) continue;
    for (let j = 0; j < singletons.length; j++) {
      if (i === j) continue;
      const b = singletons[j]!;
      if (hamming64(a.hash, b.hash) <= max) {
        result.set(a.id, 1);
        break;
      }
    }
  }
  return result;
}

/**
 * §8 Campaign-grain rollup. Pure: same members → byte-identical stats.
 * Returns null for groups below MIN_CAMPAIGN_MEMBERS (§8.2 — no row at
 * all). The pairwise sample is the deterministic PAIRWISE_MAX_MEMBERS
 * lowest `capture_id` members, so a re-run of the same bucket reproduces
 * every statistic exactly.
 *
 * The `polymorphism_regime` describes LEXICAL STRUCTURE ONLY. It is not a
 * verdict and NOT an AI-generation estimate: `high_variance` measures the
 * lexical leg of the §3.2 triad with the SEMANTIC leg unmeasured, so it is
 * a queue for investigation, never an attribute. No customer surface may
 * render it as "AI-generated" in phase 1.
 */
export function aggregateCampaign(
  campaignKey: string,
  campaignKind: CampaignKeyKind,
  bucket: string,
  members: CampaignMemberSignal[],
  cal = PHISHING_SIGNAL_CALIBRATION,
): CampaignRollupResult | null {
  const memberCount = members.length;
  if (memberCount < cal.MIN_CAMPAIGN_MEMBERS) return null;

  const templateDetectedByCapture = restampTemplateDetected(members, cal.TEMPLATE_HAMMING_MAX);

  const hashed = members.filter((m) => parseTemplateHash(m.template_hash) !== null);
  const hashedMemberCount = hashed.length;
  const statsMemberCount = members.filter((m) => m.vocabulary_complexity != null).length;

  // Window span.
  const times = members
    .map((m) => m.captured_at)
    .filter((t): t is string => t != null)
    .sort();
  const windowStart = times.length > 0 ? times[0]! : null;
  const windowEnd = times.length > 0 ? times[times.length - 1]! : null;
  const startSec = parseUtcSeconds(windowStart);
  const endSec = parseUtcSeconds(windowEnd);
  const timeWindowSeconds = startSec !== null && endSec !== null ? Math.max(0, endSec - startSec) : null;

  // Distinct-hash structure over ALL hashed members.
  const hashCounts = new Map<string, number>();
  for (const m of hashed) hashCounts.set(m.template_hash!, (hashCounts.get(m.template_hash!) ?? 0) + 1);
  const distinctTemplateHashes = hashedMemberCount > 0 ? hashCounts.size : null;
  const distinctTemplateRatio =
    hashedMemberCount > 0 ? round4(hashCounts.size / hashedMemberCount) : null;
  let largestGroup = 0;
  for (const c of hashCounts.values()) if (c > largestGroup) largestGroup = c;
  const largestTemplateShare =
    hashedMemberCount > 0 ? round4(largestGroup / hashedMemberCount) : null;

  // Pairwise Hamming over the deterministic lowest-capture_id sample.
  let meanPairwiseHamming: number | null = null;
  let sdPairwiseHamming: number | null = null;
  let nearDupPairRate: number | null = null;
  let pairwiseSampleSize: number | null = null;

  if (hashedMemberCount >= 2) {
    const sample = [...hashed]
      .sort((a, b) => a.capture_id - b.capture_id)
      .slice(0, cal.PAIRWISE_MAX_MEMBERS);
    pairwiseSampleSize = sample.length;
    const bigs = sample.map((m) => parseTemplateHash(m.template_hash)!);
    const dists: number[] = [];
    for (let i = 0; i < bigs.length; i++) {
      for (let j = i + 1; j < bigs.length; j++) {
        dists.push(hamming64(bigs[i]!, bigs[j]!));
      }
    }
    if (dists.length >= 1) {
      const mean = dists.reduce((a, b) => a + b, 0) / dists.length;
      let sq = 0;
      for (const d of dists) sq += (d - mean) * (d - mean);
      const near = dists.filter((d) => d <= cal.TEMPLATE_HAMMING_MAX).length;
      meanPairwiseHamming = round4(mean);
      sdPairwiseHamming = round4(Math.sqrt(sq / dists.length));
      nearDupPairRate = round4(near / dists.length);
    }
  }

  const regime = classifyRegime(hashedMemberCount, nearDupPairRate, meanPairwiseHamming, cal);

  const stats: CampaignPatternStats = {
    campaign_key: campaignKey,
    campaign_key_kind: campaignKind,
    window_bucket: bucket,
    window_start: windowStart,
    window_end: windowEnd,
    time_window_seconds: timeWindowSeconds,

    member_count: memberCount,
    hashed_member_count: hashedMemberCount,
    stats_member_count: statsMemberCount,

    distinct_template_hashes: distinctTemplateHashes,
    distinct_template_ratio: distinctTemplateRatio,
    largest_template_share: largestTemplateShare,
    mean_pairwise_hamming: meanPairwiseHamming,
    sd_pairwise_hamming: sdPairwiseHamming,
    near_dup_pair_rate: nearDupPairRate,
    pairwise_sample_size: pairwiseSampleSize,

    distinct_sending_ips: distinctNonNull(members.map((m) => m.sending_ip)),
    distinct_from_domains: distinctNonNull(members.map((m) => m.from_domain)),
    distinct_asns: distinctNonNull(members.map((m) => m.sender_asn)),
    distinct_mail_fingerprints: distinctNonNull(members.map((m) => m.mail_server_fingerprint)),
    distinct_subject_hashes: distinctNonNull(members.map((m) => m.subject_slot_hash)),

    mean_vocabulary_complexity: meanNonNull(members.map((m) => m.vocabulary_complexity)),
    mean_sentence_structure_variance: meanNonNull(members.map((m) => m.sentence_structure_variance)),
    mean_fluency_score: meanNonNull(members.map((m) => m.fluency_score)),

    polymorphism_regime: regime,
  };

  return { stats, templateDetectedByCapture };
}

/** §8.5 regime label, evaluated in order; first match wins. */
export function classifyRegime(
  hashedMemberCount: number,
  nearDupPairRate: number | null,
  meanPairwiseHamming: number | null,
  cal = PHISHING_SIGNAL_CALIBRATION,
): PolymorphismRegime {
  if (hashedMemberCount < 2 || nearDupPairRate === null) return 'insufficient';
  if (nearDupPairRate >= cal.REGIME_KIT_REUSE_RATE) return 'kit_reuse';
  if (nearDupPairRate >= cal.REGIME_MAIL_MERGE_RATE) return 'mail_merge';
  if (
    nearDupPairRate < cal.REGIME_MAIL_MERGE_RATE &&
    meanPairwiseHamming !== null &&
    meanPairwiseHamming >= cal.REGIME_HIGH_VAR_HAMMING
  ) {
    return 'high_variance';
  }
  return 'mixed';
}

// ─── Top-level per-capture measurement ─────────────────────────────────

/**
 * The pure per-capture measurement pass (§2–§7). Produces the computed
 * columns of one `phishing_pattern_signals` row. `template_detected` is the
 * insert-time SEED 0 — the W1.5 writer refines it via
 * `computeTemplateDetected` against ≤MAX_PEER_COMPARISONS peers, and the
 * campaign rollup re-stamps the authoritative value. `ai_generated_probability`
 * is structurally `null` (spec §0.2 rule 1).
 *
 * Async only for the local SHA-256 in `mail_server_fingerprint`.
 */
export async function measureCapture(input: CaptureInput): Promise<PerCaptureSignals> {
  const ctx = buildSlotContext(input);
  const corpus = normalizeCorpus(input, ctx);
  const cal = PHISHING_SIGNAL_CALIBRATION;

  const mailFp = await mailServerFingerprint(input.rawHeaders, input.xMailer, input.heloHostname);
  const urlObf = urlObfuscationType(input.urlsFound, input);
  const impersonation = impersonationTechnique(input);
  const { campaign_key, campaign_key_kind } = deriveCampaignKey(input);

  const base: PerCaptureSignals = {
    capture_id: input.captureId,
    fluency_score: null,
    template_detected: 0,
    template_hash: null,
    vocabulary_complexity: null,
    sentence_structure_variance: null,
    url_obfuscation_type: urlObf,
    redirect_chain_depth: null,
    landing_page_hash: null,
    sender_ip: input.sendingIp,
    mail_server_fingerprint: mailFp,
    brand_targeted: input.spoofedBrandId,
    impersonation_technique: impersonation,
    visual_similarity_score: null,
    ai_generated_probability: null,
    classification: 'measured_v1',
    campaign_key,
    campaign_key_kind,
  };

  if (corpus.unparseable) {
    return { ...base, classification: 'unparseable_v1' };
  }

  const templateHash = computeTemplateHash(corpus.allTokens);
  const vocab = vocabularyComplexity(corpus.contentTokens);
  const variance = sentenceStructureVariance(corpus.sentences);
  const fluency = fluencyScore(corpus.allTokens, corpus.usableSentences);

  // §3.1 / §4.5: below the shingle floor (or on a NaN that slipped a floor)
  // the row is 'insufficient_text_v1'. A message with >=12 tokens has an
  // established template_hash and is 'measured_v1' even when the >=40 stat
  // floors leave the three stats NULL.
  const belowShingleFloor = corpus.allTokens.length < cal.MIN_TOKENS_FOR_SHINGLES;
  const classification: PerCaptureSignals['classification'] = belowShingleFloor
    ? 'insufficient_text_v1'
    : 'measured_v1';

  return {
    ...base,
    fluency_score: fluency,
    template_hash: templateHash,
    vocabulary_complexity: vocab,
    sentence_structure_variance: variance,
    classification,
  };
}
