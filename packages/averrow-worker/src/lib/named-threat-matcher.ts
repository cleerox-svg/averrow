// Averrow — Named-threat matcher
//
// Matches an incoming signal (an abuse-mailbox lure, or an enriched
// threat) against the named_threats catalog (migration 0204) so the
// platform can say "this is Kali365" instead of just "phishing, high
// confidence".
//
// Split into two layers:
//   loadNamedThreatCatalog(env)  — one D1 read, returns parsed entries.
//                                  Call ONCE per batch, not per message.
//   matchNamedThreat(catalog, c) — pure scoring function; no I/O.
//
// Matching is deliberately conservative to avoid mis-naming. A candidate
// is only NAMED when a STRONG signal fires:
//   - an IOC (domain / url / ip) exact match, OR
//   - a regex signature match, OR
//   - the candidate's detected technique matches the entry's technique
//     AND at least two keyword signatures also hit.
// A single keyword hit is never enough on its own (kit names and generic
// words like "outlook" are too common in benign mail).

import type { Env } from "../types";
import { safeCompilePattern, MAX_REGEX_SOURCE_LEN } from "./safe-regex";
import { logger } from "./logger";

export interface NamedThreatEntry {
  id: string;
  name: string;
  aliases: string[];
  category: string;
  technique: string | null;
  severity: string | null;
  keyword_signatures: string[];
  regex_signatures: RegExp[];
  ioc_domains: string[];
  ioc_urls: string[];
  ioc_ips: string[];
}

export interface MatchCandidate {
  subject?: string | null;
  body?: string | null;
  urls?: ReadonlyArray<{ url: string; domain?: string | null }>;
  domains?: ReadonlyArray<string | null>;
  ips?: ReadonlyArray<string | null>;
  /** Technique already detected for this candidate (e.g. from the
   *  device-code detector). Boosts the matching entry. */
  technique?: string | null;
}

export interface NamedThreatMatch {
  id: string;
  name: string;
  category: string;
  technique: string | null;
  severity: string | null;
  score: number;
  /** Why it matched — for audit / operator UI. */
  reasons: string[];
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function compileRegexes(sources: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const src of sources) {
    // Defense-in-depth (O5): bound the source length + complexity before
    // compiling a catalog-provided pattern. safeCompilePattern returns null
    // (never throws) on an over-long / over-complex / malformed source; we
    // skip it rather than break the whole catalog.
    const re = safeCompilePattern(src, "i");
    if (re) {
      out.push(re);
    } else {
      logger.warn("named_threat_regex_rejected", {
        source_len: src.length,
        max_len: MAX_REGEX_SOURCE_LEN,
      });
    }
  }
  return out;
}

interface NamedThreatRow {
  id: string;
  name: string;
  aliases: string | null;
  category: string;
  technique: string | null;
  severity: string | null;
  keyword_signatures: string | null;
  regex_signatures: string | null;
  ioc_domains: string | null;
  ioc_urls: string | null;
  ioc_ips: string | null;
}

/**
 * Load the enabled named-threat catalog from D1 and parse the JSON
 * signature columns into ready-to-match shapes. One indexed read over a
 * small table — call once per batch and reuse the result.
 */
export async function loadNamedThreatCatalog(env: Env): Promise<NamedThreatEntry[]> {
  const rows = await env.DB.prepare(
    `SELECT id, name, aliases, category, technique, severity,
            keyword_signatures, regex_signatures, ioc_domains, ioc_urls, ioc_ips
     FROM named_threats
     WHERE enabled = 1`,
  ).all<NamedThreatRow>();

  return rows.results.map((r) => ({
    id: r.id,
    name: r.name,
    aliases: parseJsonArray(r.aliases),
    category: r.category,
    technique: r.technique,
    severity: r.severity,
    keyword_signatures: parseJsonArray(r.keyword_signatures).map((s) => s.toLowerCase()),
    regex_signatures: compileRegexes(parseJsonArray(r.regex_signatures)),
    ioc_domains: parseJsonArray(r.ioc_domains).map((s) => s.toLowerCase()),
    ioc_urls: parseJsonArray(r.ioc_urls).map((s) => s.toLowerCase()),
    ioc_ips: parseJsonArray(r.ioc_ips),
  }));
}

/**
 * Score one candidate against the whole catalog and return the single
 * best NAMED match (or null if nothing clears the confidence bar). Pure.
 */
export function matchNamedThreat(
  catalog: ReadonlyArray<NamedThreatEntry>,
  candidate: MatchCandidate,
): NamedThreatMatch | null {
  const haystack = [
    candidate.subject ?? "",
    candidate.body ?? "",
    ...(candidate.urls?.map((u) => u.url) ?? []),
  ]
    .join("\n")
    .toLowerCase();

  const candDomains = new Set(
    [
      ...(candidate.domains ?? []),
      ...(candidate.urls?.map((u) => u.domain ?? null) ?? []),
    ]
      .filter((d): d is string => !!d)
      .map((d) => d.toLowerCase()),
  );
  const candUrls = new Set((candidate.urls?.map((u) => u.url.toLowerCase()) ?? []));
  const candIps = new Set((candidate.ips ?? []).filter((x): x is string => !!x));

  let best: NamedThreatMatch | null = null;
  let bestRaw = 0;

  for (const entry of catalog) {
    const reasons: string[] = [];
    let score = 0;
    let strongSignal = false;

    // IOC matches — strongest evidence.
    for (const d of entry.ioc_domains) {
      if (candDomains.has(d)) {
        score += 100;
        strongSignal = true;
        reasons.push(`ioc_domain:${d}`);
      }
    }
    for (const u of entry.ioc_urls) {
      if (candUrls.has(u)) {
        score += 100;
        strongSignal = true;
        reasons.push(`ioc_url`);
      }
    }
    for (const ip of entry.ioc_ips) {
      if (candIps.has(ip)) {
        score += 100;
        strongSignal = true;
        reasons.push(`ioc_ip:${ip}`);
      }
    }

    // Regex (behavioral) signatures — strong.
    for (const re of entry.regex_signatures) {
      if (re.test(haystack)) {
        score += 60;
        strongSignal = true;
        reasons.push(`regex`);
      }
    }

    // Technique corroboration.
    const techniqueMatch =
      !!candidate.technique && !!entry.technique && candidate.technique === entry.technique;
    if (techniqueMatch) {
      score += 25;
      reasons.push(`technique:${entry.technique}`);
    }

    // Keyword signatures — weak individually.
    let keywordHits = 0;
    for (const kw of entry.keyword_signatures) {
      if (kw && haystack.includes(kw)) {
        keywordHits += 1;
        reasons.push(`keyword:${kw}`);
      }
    }
    score += keywordHits * 12;

    // Confidence bar: name it only on a strong signal, OR a technique
    // match corroborated by >=2 keywords. Keyword-only never names.
    const qualifies = strongSignal || (techniqueMatch && keywordHits >= 2);
    if (!qualifies) continue;

    // Rank by RAW accumulated evidence so two strong matches don't both
    // saturate the 0-1 cap and tie arbitrarily. The reported `score` is
    // the normalized (capped) value.
    if (!best || score > bestRaw) {
      bestRaw = score;
      best = {
        id: entry.id,
        name: entry.name,
        category: entry.category,
        technique: entry.technique,
        severity: entry.severity,
        score: Math.min(1, score / 100),
        reasons,
      };
    }
  }

  return best;
}

/**
 * Bump match_count / last_matched_at for a named threat. Fire-and-forget
 * from the caller (wrap in try/catch); failures are non-fatal telemetry.
 */
export async function recordNamedThreatMatch(env: Env, namedThreatId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE named_threats
     SET match_count = match_count + 1,
         last_matched_at = datetime('now'),
         updated_at = datetime('now')
     WHERE id = ?`,
  ).bind(namedThreatId).run();
}
