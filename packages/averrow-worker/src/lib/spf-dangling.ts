/**
 * Dangling SPF include confirmation (SubdoMailing mechanism 2).
 *
 * An `include:` / `redirect=` target that no longer exists is only
 * dangerous when its REGISTRABLE domain is unregistered: anyone can then
 * register it and publish `v=spf1 +all`, becoming an authorised sender for
 * the brand. The walk (lib/spf-walk.ts) records targets whose TXT answer was
 * NXDOMAIN (`nxdomainAt`); this module narrows them to ONE candidate and
 * asks RDAP.
 *
 * Bounds (the public scan endpoint takes attacker-chosen domains, so this
 * must not become an RDAP amplifier):
 *   - at most ONE RDAP verdict per scan, and at most MAX_DNS_PROBES extra
 *     DoH probes to confirm the registrable domain itself is NXDOMAIN;
 *   - RDAP runs only when the caller passes a checker (brand scans with a
 *     Worker env; the public free scan and public email-security check pass
 *     none and never query RDAP);
 *   - the checker is hard-timed (SPF_RDAP_TIMEOUT_MS) and KV-cached per
 *     registrable domain.
 * Honesty rule: a failed / rate-limited / timed-out lookup is `unknown`,
 * never `unregistered`; `unknown` never changes the score.
 */

import { rdapDomainRegistration, type DomainRegistration } from './whois';
import { MULTI_LABEL_SUFFIXES, TENANT_HOST_SUFFIXES, registrableDomain } from './registrable-domain';
import type { SpfTxtLookup } from './spf-walk';
import type { Env } from '../types';

export type { DomainRegistration };

/** Verdict function threaded into checkSpf (like `previousSpf`). */
export type SpfRdapCheck = (registrable: string, timeoutMs: number) => Promise<DomainRegistration>;

/** Hard cap on the single RDAP lookup (bootstrap + request). */
export const SPF_RDAP_TIMEOUT_MS = 3_000;
/** Below this much budget left after the DNS probes, RDAP is not started
 *  (the include is reported unverified). */
export const SPF_RDAP_MIN_REMAINING_MS = 500;
/** Cap on the DoH probe confirming the registrable domain is NXDOMAIN. */
export const SPF_RDAP_DNS_PROBE_MS = 2_000;
/** Max extra DoH probes per scan while picking the candidate. */
export const SPF_RDAP_MAX_DNS_PROBES = 3;
/** KV cache lifetimes per registrable domain. */
export const SPF_RDAP_CACHE_TTL_SECONDS = 24 * 3600;
export const SPF_RDAP_UNKNOWN_TTL_SECONDS = 600;

/**
 * Multi-label suffixes under which ANYONE can register a name (open
 * registration). Only these count as a confident 3-label registrable
 * domain. Restricted second levels (gov / police / nhs / mod / ac / edu /
 * govt / go / lg / mil / sch … under any ccTLD) are deliberately absent:
 * nobody can "just register" a name there, and their registries' RDAP
 * coverage is not something to act on. Unlisted = not confident.
 */
export const OPEN_MULTI_LABEL_SUFFIXES: ReadonlySet<string> = new Set([
  // UK
  "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk",
  // Australia / NZ
  "com.au", "net.au", "org.au", "id.au", "asn.au",
  "co.nz", "net.nz", "org.nz", "geek.nz", "gen.nz", "kiwi.nz",
  // Japan / Korea
  "co.jp", "ne.jp", "or.jp", "gr.jp", "co.kr", "ne.kr", "or.kr",
  // China / HK / TW / SG / MY
  "com.cn", "net.cn", "org.cn", "com.hk", "net.hk", "org.hk", "com.tw", "net.tw", "org.tw", "idv.tw",
  "com.sg", "net.sg", "org.sg", "com.my", "net.my", "org.my",
  // India
  "co.in", "net.in", "org.in", "firm.in", "gen.in", "ind.in",
  // Americas
  "com.br", "net.br", "org.br", "com.mx", "net.mx", "org.mx", "com.ar", "net.ar", "org.ar",
  "com.co", "net.co", "org.co", "nom.co", "com.pe", "com.ve", "com.uy", "com.ec",
  // Africa / Middle East
  "co.za", "org.za", "net.za", "web.za", "com.ng", "com.eg", "co.ke", "or.ke", "co.tz", "co.ug",
  "co.il", "org.il", "net.il", "com.sa", "com.tr", "net.tr", "org.tr",
  "com.pk", "com.bd", "com.ph", "com.vn", "co.th", "in.th", "co.id", "or.id",
  // Europe
  "co.at", "or.at", "com.pl", "net.pl", "org.pl", "com.ua", "co.ua", "com.gr", "com.cy", "com.mt", "co.hu",
  "com.es", "nom.es", "org.es", "com.pt", "org.pt", "co.no", "com.ru", "net.ru", "org.ru", "msk.ru", "spb.ru",
  "asso.fr", "nom.fr",
]);

/**
 * Registrable domain of an include target when we are SURE of it, else null
 * (then nothing is queried). Sure = two labels that are not themselves a
 * listed multi-label suffix, or three labels under an OPEN multi-label
 * suffix (co.uk — never gov.uk / ac.uk / police.uk, and never an unlisted
 * one). A registrable label containing `_` is refused (not a hostname a
 * registry sells). Tenant hosts (foo.myshopify.com) and heuristic ccTLD
 * guesses are refused: an RDAP 404 for a name that is not a registry-level
 * name would read as "unregistered".
 */
export function confidentRegistrable(host: string): string | null {
  const name = host.trim().toLowerCase().replace(/\.$/, '');
  const reg = registrableDomain(name);
  if (!reg) return null;
  const labels = reg.split('.');
  if (labels.some((l) => l.includes('_'))) return null;
  for (let i = 1; i < labels.length; i++) {
    if (TENANT_HOST_SUFFIXES.has(labels.slice(i).join('.'))) return null;
  }
  if (labels.length === 2) {
    if (MULTI_LABEL_SUFFIXES.has(reg) || OPEN_MULTI_LABEL_SUFFIXES.has(reg)) return null;
    return reg;
  }
  if (labels.length === 3 && OPEN_MULTI_LABEL_SUFFIXES.has(labels.slice(1).join('.'))) return reg;
  return null;
}

export interface DanglingCandidate {
  registrable: string;
  /** Include target the candidate came from (for tests / logs). */
  target: string;
}

/**
 * First NXDOMAIN include target whose registrable domain is itself
 * NXDOMAIN. A target that IS its registrable domain needs no extra query
 * (its own TXT answer was NXDOMAIN); a subdomain target costs one DoH probe
 * of the registrable domain (≤ SPF_RDAP_MAX_DNS_PROBES per scan), each
 * capped by `opts.deadline` when given (no probe once it has passed). A
 * probe that errors or answers anything but NXDOMAIN skips the candidate.
 */
export async function pickDanglingCandidate(
  nxdomainAt: readonly string[],
  lookup: SpfTxtLookup,
  opts: { deadline?: number } = {},
): Promise<DanglingCandidate | null> {
  const seen = new Set<string>();
  let probes = 0;
  for (const target of nxdomainAt) {
    const reg = confidentRegistrable(target);
    if (reg === null || seen.has(reg)) continue;
    seen.add(reg);
    if (reg === target) return { registrable: reg, target };
    if (probes >= SPF_RDAP_MAX_DNS_PROBES) break;
    const probeMs = opts.deadline === undefined
      ? SPF_RDAP_DNS_PROBE_MS
      : Math.min(SPF_RDAP_DNS_PROBE_MS, opts.deadline - Date.now());
    if (probeMs < 1) break; // out of budget: no proof either way
    probes++;
    try {
      const a = await lookup(reg, probeMs);
      if (a.status === 'nxdomain') return { registrable: reg, target };
    } catch {
      // probe failed: not proof of anything — skip this candidate
    }
  }
  return null;
}

/**
 * RDAP verdict function for brand scans: KV-cached per registrable domain
 * (`registered` / `unregistered` 24 h, `unknown` 10 min so a failing
 * registry is not hammered), over the shared rdapDomainRegistration.
 */
export function spfRdapChecker(env: Env): SpfRdapCheck {
  return async (registrable, timeoutMs) => {
    // v2: verdicts under the stricter rdapDomainRegistration (bootstrap-only,
    // https, no redirects, RDAP-shaped 404); v1 entries are ignored.
    const key = `spf:rdap:v2:${registrable}`;
    try {
      const hit = await env.CACHE.get(key);
      if (hit === 'registered' || hit === 'unregistered' || hit === 'unknown') return hit;
    } catch {
      // KV miss / error: fall through to a live lookup
    }
    const verdict = await rdapDomainRegistration(env, registrable, Math.min(timeoutMs, SPF_RDAP_TIMEOUT_MS));
    try {
      await env.CACHE.put(key, verdict, {
        expirationTtl: verdict === 'unknown' ? SPF_RDAP_UNKNOWN_TTL_SECONDS : SPF_RDAP_CACHE_TTL_SECONDS,
      });
    } catch {
      // cache write failure is non-fatal
    }
    return verdict;
  };
}
