// Lookalike-domain permutations + live registration check for the free
// scan (/api/brand-scan/public) and the prospect report.
//
// Generation is the same permutation set the brand scan has always used
// (moved here from handlers/brandScan.ts so the free scan and the staff
// scan share it). The free scan does NOT check all ~100 permutations: it
// checks a ranked sample (see selectLikelyLookalikes) against public DNS
// with bounded concurrency and a total time budget, then caches the
// result per domain in KV for 24h so repeat scans of the same domain are
// one KV read.
//
// Public outputs get counts only (checked / registered). The registered
// names are stored on the brand_scans row for the prospect report.

import type { Env } from "../types";
import { normalizePublicHostname } from "./public-hostname";

// ─── Permutation generation ─────────────────────────────────────

/** Permutation families, in generation order. */
export type LookalikeKind =
  | "transposition" | "missing_char" | "doubled_char" | "homoglyph"
  | "tld_swap" | "hyphen" | "prefix" | "suffix";

export interface LookalikeCandidate { domain: string; kind: LookalikeKind }

const HOMOGLYPHS: Record<string, string[]> = {
  a: ["@", "4", "à", "á", "â", "ã", "ä"],
  e: ["3", "è", "é", "ê", "ë"],
  i: ["1", "l", "!", "ì", "í"],
  o: ["0", "ò", "ó", "ô", "õ", "ö"],
  l: ["1", "i", "|"],
  s: ["5", "$"],
  t: ["7", "+"],
  g: ["9", "q"],
  n: ["m"],
  m: ["n", "rn"],
};

const ALT_TLDS = ["com", "net", "org", "info", "xyz", "io", "co", "biz", "site", "online", "app"];
const PREFIXES = ["secure-", "login-", "my", "account-", "www-", "mail-", "update-"];
const SUFFIXES = ["-secure", "-login", "-verify", "-support", "-online"];

/** Every permutation with its family, in generation order (may repeat). */
export function generateLookalikeCandidates(domain: string): LookalikeCandidate[] {
  const parts = domain.split(".");
  if (parts.length < 2) return [];
  const name = parts[0]!;
  const tld = parts.slice(1).join(".");
  const out: LookalikeCandidate[] = [];
  const push = (label: string, kind: LookalikeKind, suffix = tld) => out.push({ domain: `${label}.${suffix}`, kind });

  for (let i = 0; i < name.length - 1; i++) {
    const swapped = name.slice(0, i) + name[i + 1] + name[i] + name.slice(i + 2);
    if (swapped !== name) push(swapped, "transposition");
  }
  for (let i = 0; i < name.length; i++) {
    const missing = name.slice(0, i) + name.slice(i + 1);
    if (missing.length >= 2) push(missing, "missing_char");
  }
  for (let i = 0; i < name.length; i++) {
    push(name.slice(0, i + 1) + name[i] + name.slice(i + 1), "doubled_char");
  }
  for (const [char, subs] of Object.entries(HOMOGLYPHS)) {
    const idx = name.indexOf(char);
    if (idx >= 0) {
      for (const sub of subs.slice(0, 2)) push(name.slice(0, idx) + sub + name.slice(idx + 1), "homoglyph");
    }
  }
  for (const alt of ALT_TLDS) {
    if (alt !== tld) push(name, "tld_swap", alt);
  }
  for (let i = 1; i < name.length; i++) push(`${name.slice(0, i)}-${name.slice(i)}`, "hyphen");
  for (const p of PREFIXES) push(`${p}${name}`, "prefix");
  for (const s of SUFFIXES) push(`${name}${s}`, "suffix");
  return out;
}

/** The staff brand scan's permutation list (unchanged behaviour: deduped, first 100). */
export function generateLookalikes(domain: string): string[] {
  return [...new Set(generateLookalikeCandidates(domain).map((c) => c.domain))].slice(0, 100);
}

// ─── Ranked sample for the free scan ────────────────────────────
//
// Why a sample: checking ~100 names per anonymous scan is slow and
// mostly wasted — most permutations are never registered. The sample
// keeps the families that are registered most often in practice, in
// this order, each with a cap so one family can't crowd out the rest:
//   1. Same name on another common TLD (.com/.net/.org/.co/.io …) —
//      the cheapest, most frequently registered lookalike.     cap 10
//   2. Single-keystroke typos: missing, doubled or swapped
//      letters.                                                 cap 18
//   3. Brand + keyword (secure-, login-, my…, -support, -verify) —
//      the phishing-kit naming pattern.                         cap 8
//   4. ASCII lookalike characters (0 for o, 1 for l, rn for m). cap 6
//   5. Hyphen insertion.                                        cap 4
// Then any space left is filled from what remains, in the same order.
// Permutations that are not valid ASCII hostnames (accented letters,
// '@', '$', '|', '+', '!') are dropped first: they can't be registered
// as typed. This method is internal — public responses carry counts only.

export const LOOKALIKE_SAMPLE_SIZE = 40;

const TIERS: Array<{ kinds: LookalikeKind[]; cap: number }> = [
  { kinds: ["tld_swap"], cap: 10 },
  { kinds: ["missing_char", "doubled_char", "transposition"], cap: 18 },
  { kinds: ["prefix", "suffix"], cap: 8 },
  { kinds: ["homoglyph"], cap: 6 },
  { kinds: ["hyphen"], cap: 4 },
];

export function selectLikelyLookalikes(domain: string, limit = LOOKALIKE_SAMPLE_SIZE): string[] {
  const seen = new Set<string>([domain]);
  const valid: LookalikeCandidate[] = [];
  for (const c of generateLookalikeCandidates(domain)) {
    if (seen.has(c.domain)) continue;
    if (normalizePublicHostname(c.domain) !== c.domain) continue;
    seen.add(c.domain);
    valid.push(c);
  }
  const picked: string[] = [];
  const pickedSet = new Set<string>();
  const take = (c: LookalikeCandidate) => { picked.push(c.domain); pickedSet.add(c.domain); };
  for (const tier of TIERS) {
    let n = 0;
    for (const c of valid) {
      if (picked.length >= limit || n >= tier.cap) break;
      if (tier.kinds.includes(c.kind) && !pickedSet.has(c.domain)) { take(c); n++; }
    }
  }
  for (const tier of TIERS) {
    for (const c of valid) {
      if (picked.length >= limit) break;
      if (tier.kinds.includes(c.kind) && !pickedSet.has(c.domain)) take(c);
    }
  }
  return picked;
}

// ─── Registration check (public DNS) ────────────────────────────

const DOH_URL = "https://cloudflare-dns.com/dns-query";
export const LOOKALIKE_CONCURRENCY = 8;
export const LOOKALIKE_LOOKUP_TIMEOUT_MS = 2_500;
export const LOOKALIKE_TOTAL_BUDGET_MS = 6_000;

type Verdict = "registered" | "unregistered" | "unknown";

/**
 * NS lookup over DNS-over-HTTPS. NOERROR with an answer = the name is
 * delegated (registered); NXDOMAIN = not registered. Anything else
 * (SERVFAIL, timeout, HTTP error) is "unknown" and is not counted as
 * checked, so the public `checked` number only covers definite answers.
 */
async function lookupRegistration(domain: string, timeoutMs: number): Promise<Verdict> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Verdict>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve("unknown"); }, timeoutMs);
  });
  const query = (async (): Promise<Verdict> => {
    try {
      const res = await fetch(`${DOH_URL}?name=${encodeURIComponent(domain)}&type=NS`, {
        headers: { Accept: "application/dns-json" },
        signal: controller.signal,
      });
      if (!res.ok) return "unknown";
      const data = await res.json() as { Status?: number; Answer?: unknown[] };
      if (data.Status === 3) return "unregistered";
      if (data.Status === 0) return Array.isArray(data.Answer) && data.Answer.length > 0 ? "registered" : "unregistered";
      return "unknown";
    } catch {
      return "unknown";
    }
  })();
  try {
    return await Promise.race([query, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface RegistrationCheckOptions {
  concurrency?: number;
  lookupTimeoutMs?: number;
  budgetMs?: number;
}

export interface RegistrationCheckResult {
  /** Names that got a definite answer. */
  checked: number;
  registered: string[];
  /** Every name got a definite answer within the budget. */
  complete: boolean;
}

/** Check names with at most `concurrency` lookups in flight; no lookup starts after the budget. */
export async function checkRegistrations(
  domains: string[],
  opts: RegistrationCheckOptions = {},
): Promise<RegistrationCheckResult> {
  const concurrency = Math.max(1, opts.concurrency ?? LOOKALIKE_CONCURRENCY);
  const lookupTimeoutMs = opts.lookupTimeoutMs ?? LOOKALIKE_LOOKUP_TIMEOUT_MS;
  const deadline = Date.now() + (opts.budgetMs ?? LOOKALIKE_TOTAL_BUDGET_MS);
  const verdicts: Verdict[] = new Array<Verdict>(domains.length).fill("unknown");
  let next = 0;

  const worker = async () => {
    while (next < domains.length) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      const i = next++;
      verdicts[i] = await lookupRegistration(domains[i]!, Math.min(lookupTimeoutMs, remaining));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, domains.length) }, worker));

  const registered = domains.filter((_, i) => verdicts[i] === "registered");
  const checked = verdicts.filter((v) => v !== "unknown").length;
  return { checked, registered, complete: checked === domains.length };
}

// ─── Cached per-domain result ───────────────────────────────────

export const LOOKALIKE_CACHE_TTL_SECONDS = 24 * 60 * 60;
export const lookalikeCacheKey = (domain: string) => `scan:lookalikes:${domain}`;

interface CachedLookalikes { v: 1; checked: number; registered: string[] }

function parseCached(raw: string | null): CachedLookalikes | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<CachedLookalikes>;
    if (o.v !== 1 || typeof o.checked !== "number" || !Array.isArray(o.registered)) return null;
    if (!o.registered.every((d) => typeof d === "string")) return null;
    return { v: 1, checked: o.checked, registered: o.registered };
  } catch {
    return null;
  }
}

export interface ScanLookalikes { checked: number; registered: string[]; cached: boolean }

/**
 * Registered lookalikes for `domain`: KV hit (24h) or a live check of the
 * ranked sample. Only a complete check is cached — a budget-cut partial
 * result is returned but re-checked next time. KV failures fall through
 * to the live check.
 */
export async function getScanLookalikes(
  env: Pick<Env, "CACHE">,
  domain: string,
  opts: RegistrationCheckOptions = {},
): Promise<ScanLookalikes> {
  const key = lookalikeCacheKey(domain);
  try {
    const hit = parseCached(await env.CACHE.get(key));
    if (hit) return { checked: hit.checked, registered: hit.registered, cached: true };
  } catch { /* KV transient — check live */ }

  const result = await checkRegistrations(selectLikelyLookalikes(domain), opts);
  if (result.complete) {
    try {
      const entry: CachedLookalikes = { v: 1, checked: result.checked, registered: result.registered };
      await env.CACHE.put(key, JSON.stringify(entry), { expirationTtl: LOOKALIKE_CACHE_TTL_SECONDS });
    } catch { /* non-fatal */ }
  }
  return { checked: result.checked, registered: result.registered, cached: false };
}
