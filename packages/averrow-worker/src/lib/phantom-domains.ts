/**
 * Phantom-domain validation + dedup — pure, side-effect-free helpers
 * for the `phantom_enumerator` agent (W2.2 / spec §3).
 *
 * A "phantom" is a domain an LLM is likely to *hallucinate* as belonging
 * to a brand. Enumeration writes these as PREDICTIONS only — this module
 * never touches D1, never creates alerts, never inserts threats. It just
 * turns the model's raw JSON array into the clean, de-duplicated set of
 * registrable candidates that survive the spec-§3 pipeline.
 *
 * Both exported functions are pure so they can be unit-tested in
 * isolation (test-engineer, alongside the alert-triage deciders) without
 * standing up an agent context or a DB.
 *
 * Normalization reuses the canonical `sanitizeDomain` (lib/sanitize.ts)
 * for lowercasing / scheme+path stripping / the base per-label regex and
 * the 253-char cap, then layers the stricter §3.1 rules on top
 * (≥2 labels, per-label ≤63, ≥2-alpha TLD, IP-literal rejection).
 */

import { sanitizeDomain } from "./sanitize";

/** Raw element as it arrives from the model's JSON array. Every field is
 *  untrusted / possibly missing — only `domain` is load-bearing. */
export interface RawPhantomCandidate {
  domain?: unknown;
  kind?: unknown;
  confidence?: unknown;
}

/** A validated candidate ready to persist at status='predicted'. */
export interface PhantomCandidate {
  /** Normalized, lowercased, registrable domain — the load-bearing field. */
  domain: string;
  /** Enumeration class — narrative colour only, never gates anything. */
  kind?: string;
  /** Model self-rated plausibility 0–1 — stored for future ranking only. */
  confidence?: number;
}

/**
 * Validate + normalize a single candidate domain per spec §3.1.
 *
 * Returns the normalized registrable domain, or null when the input is
 * not a syntactically valid registrable hostname. Reuses `sanitizeDomain`
 * for the base normalization (lowercase, strip scheme/path, base label
 * regex, ≤253 chars) then enforces:
 *   - at least two labels (drops single-label hosts like `localhost`)
 *   - each label 1–63 chars, `[a-z0-9-]`, not starting/ending with `-`
 *   - a TLD of ≥2 alpha characters (drops IP literals + numeric TLDs)
 *
 * Pure — no I/O.
 */
export function normalizePhantomDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Reject obvious non-registrable shapes up front (paths, userinfo,
  // whitespace) rather than letting sanitizeDomain silently reshape them.
  if (/[\s@]/.test(trimmed) || trimmed.includes("/")) return null;

  const base = sanitizeDomain(trimmed);
  if (!base) return null;

  const labels = base.split(".");
  if (labels.length < 2) return null;
  for (const label of labels) {
    if (label.length < 1 || label.length > 63) return null;
    if (!/^[a-z0-9-]+$/.test(label)) return null;
    if (label.startsWith("-") || label.endsWith("-")) return null;
  }
  // TLD must be ≥2 alpha chars — rejects IPv4 literals (numeric last
  // label) and bogus numeric TLDs the model might invent.
  const tld = labels[labels.length - 1] ?? "";
  if (!/^[a-z]{2,}$/.test(tld)) return null;

  return base;
}

/**
 * Run the full spec-§3 validation + dedup pipeline over the model's raw
 * array for a single brand. Pure over its four inputs so it can be
 * exhaustively unit-tested.
 *
 * Applied in order to each candidate:
 *   1. Syntactic validation / normalization (§3.1) — invalid → drop.
 *   2. Drop the brand's own canonical domain (§3.2).
 *   3. Drop domains already tracked in lookalike_domains (§3.3).
 *   4. Drop domains already predicted in phantom_domains for any brand,
 *      and de-dup within the model's own array (§3.4).
 *
 * Survivors are truncated to `cap` (default 50, spec §2). The `existing*`
 * sets must contain already-normalized/lowercased domains (the agent
 * normalizes with `normalizePhantomDomain` before querying D1).
 */
export function filterPhantomCandidates(
  rawCandidates: RawPhantomCandidate[],
  canonicalDomain: string,
  existingLookalikes: Set<string>,
  existingPhantoms: Set<string>,
  cap = 50,
): PhantomCandidate[] {
  const canonical =
    normalizePhantomDomain(canonicalDomain) ?? canonicalDomain.trim().toLowerCase();
  const seen = new Set<string>();
  const out: PhantomCandidate[] = [];

  for (const raw of rawCandidates) {
    if (out.length >= cap) break;
    if (!raw || typeof raw !== "object") continue;

    const domain = normalizePhantomDomain(raw.domain);
    if (!domain) continue; // §3.1
    if (domain === canonical) continue; // §3.2
    if (existingLookalikes.has(domain)) continue; // §3.3
    if (existingPhantoms.has(domain)) continue; // §3.4
    if (seen.has(domain)) continue; // §3.4 within-array dedup
    seen.add(domain);

    const kind = typeof raw.kind === "string" && raw.kind.length > 0
      ? raw.kind.slice(0, 40)
      : undefined;
    const confidence =
      typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
        ? Math.max(0, Math.min(1, raw.confidence))
        : undefined;

    out.push({ domain, kind, confidence });
  }

  return out;
}
