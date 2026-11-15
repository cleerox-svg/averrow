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
/** Cap on the DoH probe confirming the registrable domain is NXDOMAIN. */
export const SPF_RDAP_DNS_PROBE_MS = 2_000;
/** Max extra DoH probes per scan while picking the candidate. */
export const SPF_RDAP_MAX_DNS_PROBES = 3;
/** KV cache lifetimes per registrable domain. */
export const SPF_RDAP_CACHE_TTL_SECONDS = 24 * 3600;
export const SPF_RDAP_UNKNOWN_TTL_SECONDS = 600;

/**
 * Registrable domain of an include target when we are SURE of it, else null
 * (then nothing is queried). Sure = two labels, or three labels under an
 * explicitly listed multi-label suffix (co.uk). Tenant hosts
 * (foo.myshopify.com) and heuristic ccTLD guesses are refused: an RDAP 404
 * for a name that is not a registry-level name would read as "unregistered".
 */
export function confidentRegistrable(host: string): string | null {
  const name = host.trim().toLowerCase().replace(/\.$/, '');
  const reg = registrableDomain(name);
  if (!reg) return null;
  const labels = reg.split('.');
  for (let i = 1; i < labels.length; i++) {
    if (TENANT_HOST_SUFFIXES.has(labels.slice(i).join('.'))) return null;
  }
  if (labels.length === 2) return reg;
  if (labels.length === 3 && MULTI_LABEL_SUFFIXES.has(labels.slice(1).join('.'))) return reg;
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
 * of the registrable domain (≤ SPF_RDAP_MAX_DNS_PROBES per scan). A probe
 * that errors or answers anything but NXDOMAIN skips the candidate.
 */
export async function pickDanglingCandidate(
  nxdomainAt: readonly string[],
  lookup: SpfTxtLookup,
): Promise<DanglingCandidate | null> {
  const seen = new Set<string>();
  let probes = 0;
  for (const target of nxdomainAt) {
    const reg = confidentRegistrable(target);
    if (reg === null || seen.has(reg)) continue;
    seen.add(reg);
    if (reg === target) return { registrable: reg, target };
    if (probes >= SPF_RDAP_MAX_DNS_PROBES) break;
    probes++;
    try {
      const a = await lookup(reg, SPF_RDAP_DNS_PROBE_MS);
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
    const key = `spf:rdap:v1:${registrable}`;
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
