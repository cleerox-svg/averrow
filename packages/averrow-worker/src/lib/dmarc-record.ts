/**
 * DMARC record tag parser — RFC 9989 (DMARCbis, May 2026), which obsoletes
 * RFC 7489.
 *
 * One tag-list parser shared by every place that reads a published
 * `_dmarc` TXT record (posture engine `email-security.ts`, Flight Control's
 * own-domain check via `lib/doh.ts`, the brand-scan handler). The earlier
 * per-site regexes (`/p=(\w+)/`) also matched inside `sp=` / `np=`, so a
 * record such as `v=DMARC1; np=none; p=reject` read as `none`.
 *
 * Tags of interest:
 *   p    — policy for the domain itself (required).
 *   sp   — policy for existing subdomains (falls back to p).
 *   np   — RFC 9989: policy for NON-EXISTENT subdomains (falls back to sp,
 *          then p).
 *   t    — RFC 9989: testing mode (`y` | `n`, default `n`). Replaces the
 *          `pct` use case: `t=y` asks receivers not to apply the policy in
 *          full.
 *   psd  — RFC 9989: Public Suffix Domain flag (`y` | `n` | `u`). Only
 *          meaningful for PSD operators; parsed and stored, not scored.
 *   pct  — DEPRECATED by RFC 9989. Still parsed (legacy receivers honour
 *          it and the `email_security_scans.dmarc_pct` column exists);
 *          scoring treats `pct < 100` exactly like `t=y`.
 *
 * Pure functions, no I/O — unit-tested in test/dmarc-record.test.ts.
 */

export type DmarcPolicyValue = 'none' | 'quarantine' | 'reject';

export interface ParsedDmarcRecord {
  /** Lowercased tag name → trimmed raw value, first occurrence wins. */
  tags: Map<string, string>;
  /** `p=` (lowercased) when it is a valid policy value, else null. */
  p: DmarcPolicyValue | null;
  /**
   * Policy to STORE / score for the domain. Never free text from the TXT
   * record (brandScan.ts runs on unauthenticated public input):
   *   valid p      → that value
   *   invalid p    → 'none' (RFC 7489 §6.6.3 / RFC 9989: an invalid p with
   *                  a usable record is treated as p=none — no enforcement)
   *   p absent     → 'none' (the long-standing stored default)
   */
  policyForStorage: DmarcPolicyValue;
  /** True when a `p=` tag is present but not none / quarantine / reject. */
  pInvalid: boolean;
  sp: DmarcPolicyValue | null;
  np: DmarcPolicyValue | null;
  /** `t=` — 'y' | 'n'; null when absent or invalid. */
  t: 'y' | 'n' | null;
  /** `psd=` — 'y' | 'n' | 'u'; null when absent or invalid. */
  psd: 'y' | 'n' | 'u' | null;
  /** `pct=` as an integer 0..100; null when absent or not a number. */
  pct: number | null;
  rua: string | null;
  ruf: string | null;
}

function asPolicy(v: string | undefined): DmarcPolicyValue | null {
  if (!v) return null;
  const s = v.toLowerCase();
  return s === 'none' || s === 'quarantine' || s === 'reject' ? s : null;
}

/**
 * Parse a DMARC TXT record into its tags. Returns null when the record
 * does not start with `v=DMARC1` (RFC 9989 requires `v` to be the first
 * tag). Tag names and policy values are case-insensitive; whitespace
 * around `;` and `=` is tolerated.
 */
export function parseDmarcRecord(record: string | null | undefined): ParsedDmarcRecord | null {
  if (!record) return null;
  const parts = record.split(';');
  const tags = new Map<string, string>();
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    if (!name || tags.has(name)) continue;
    tags.set(name, value);
  }
  // `v` must be the first tag and equal DMARC1.
  const firstEq = parts[0]?.indexOf('=') ?? -1;
  const firstName = firstEq > 0 ? parts[0]!.slice(0, firstEq).trim().toLowerCase() : '';
  if (firstName !== 'v' || (tags.get('v') ?? '').toUpperCase() !== 'DMARC1') return null;

  const pRawValue = tags.get('p');
  const tRaw = tags.get('t')?.toLowerCase();
  const psdRaw = tags.get('psd')?.toLowerCase();
  const pctRaw = tags.get('pct');
  const pctNum = pctRaw !== undefined && /^\d{1,3}$/.test(pctRaw) ? parseInt(pctRaw, 10) : NaN;

  return {
    tags,
    p: asPolicy(pRawValue),
    policyForStorage: asPolicy(pRawValue) ?? 'none',
    pInvalid: pRawValue !== undefined && asPolicy(pRawValue) === null,
    sp: asPolicy(tags.get('sp')),
    np: asPolicy(tags.get('np')),
    t: tRaw === 'y' || tRaw === 'n' ? tRaw : null,
    psd: psdRaw === 'y' || psdRaw === 'n' || psdRaw === 'u' ? psdRaw : null,
    pct: Number.isFinite(pctNum) && pctNum >= 0 && pctNum <= 100 ? pctNum : null,
    rua: tags.get('rua') || null,
    ruf: tags.get('ruf') || null,
  };
}

/** Minimal shape the policy helpers below need (DmarcResult satisfies it). */
export interface DmarcPolicyInputs {
  policy: string | null;
  pct: number | null;
  sp?: string | null;
  np?: string | null;
  t?: string | null;
}

/**
 * "Testing / not fully enforced": `t=y` (RFC 9989) or a legacy `pct` below
 * 100 (RFC 7489 sampling). Both mean receivers are asked not to apply the
 * published policy to all failing mail, so the two are treated the same.
 * A record without `pct` has pct = null or 100 → not testing.
 */
export function isDmarcTestingMode(d: DmarcPolicyInputs): boolean {
  if ((d.t ?? '').toLowerCase() === 'y') return true;
  return d.pct !== null && d.pct < 100;
}

/**
 * Effective policy for non-existent subdomains per RFC 9989:
 * `np`, else `sp`, else `p`. Null when none of them is a valid policy.
 */
export function effectiveNonExistentSubdomainPolicy(d: DmarcPolicyInputs): DmarcPolicyValue | null {
  return asPolicy(d.np ?? undefined) ?? asPolicy(d.sp ?? undefined) ?? asPolicy(d.policy ?? undefined);
}

/**
 * True when the apex is at enforcement (quarantine / reject) but
 * non-existent subdomains resolve to `none` — explicitly via `np=none`,
 * or via the `sp=none` fallback. Spoofers can then send from
 * `anything.brand.example` without being blocked.
 */
export function hasNonExistentSubdomainGap(d: DmarcPolicyInputs): boolean {
  const p = asPolicy(d.policy ?? undefined);
  if (p !== 'quarantine' && p !== 'reject') return false;
  return effectiveNonExistentSubdomainPolicy(d) === 'none';
}
