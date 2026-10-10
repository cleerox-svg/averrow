/**
 * Lookalike Domain Generator (dnstwist-style)
 *
 * Generates domain permutations to detect typosquatting,
 * homoglyph attacks, TLD swaps, hyphenation tricks,
 * and keyword-based impersonation domains.
 */

export interface DomainPermutation {
  // For 'idn_homoglyph' this is the punycode (xn--…) ToASCII form, so
  // DoH / checkDomain can resolve it. `display` carries the human-readable
  // unicode form for that case.
  domain: string;
  type: 'typosquat' | 'homoglyph' | 'idn_homoglyph' | 'tld_swap' | 'hyphenation' | 'keyword';
  /** Human-readable unicode label.tld for idn_homoglyph variants (e.g. `аpple.com`). */
  display?: string;
}

// ─── Homoglyph map ──────────────────────────────────────────────

const HOMOGLYPHS: Record<string, string[]> = {
  a: ['@', '4', 'à', 'á', 'â', 'ã', 'ä', 'å', 'ɑ'],
  b: ['d', 'lb', 'ib'],
  c: ['e', 'ç', 'ć'],
  d: ['b', 'cl', 'dl'],
  e: ['3', 'è', 'é', 'ê', 'ë'],
  f: ['ph'],
  g: ['9', 'q'],
  h: ['lh'],
  i: ['1', 'l', '!', 'ì', 'í', 'î', 'ï'],
  j: ['i'],
  k: ['lk', 'ik'],
  l: ['1', 'i', '|'],
  m: ['n', 'nn', 'rn', 'rr'],
  n: ['m', 'r'],
  o: ['0', 'ò', 'ó', 'ô', 'õ', 'ö', 'ø'],
  p: ['q'],
  q: ['p', 'g'],
  r: ['n'],
  s: ['5', '$', 'z', 'ś', 'š'],
  t: ['7', '+'],
  u: ['v', 'ù', 'ú', 'û', 'ü'],
  v: ['u', 'w'],
  w: ['vv', 'uu'],
  x: ['ks'],
  y: ['ÿ', 'ý'],
  z: ['s', '2'],
};

// ─── IDN / punycode homoglyph confusables (S2.4 / C5-D7) ────────
//
// Latin base char → high-confidence, near-identical Unicode visual
// confusables, used to proactively hunt IDN homoglyph lookalikes
// (e.g. `аpple.com` with a Cyrillic а). This is a NEW, additive map,
// deliberately kept SEPARATE from the ASCII `HOMOGLYPHS` block above
// (which stays ASCII-gated and byte-for-byte unchanged). A future PR
// (`lib/homoglyphs.ts`) may consolidate the two — accept the small
// duplication for now.
//
// Curated for PRECISION, not recall. Only whole-script confusables that
// are visually near-indistinguishable from the Latin base in a common
// sans-serif font are included — predominantly Cyrillic (which shares a
// large identical-glyph set with Latin), plus the two strongest Greek
// lookalikes. The broad accented-Latin set (à/ä/ç…) is intentionally
// EXCLUDED: the diacritic is visible, so it is a weaker impersonation
// signal and a higher false-positive risk. Each entry is a genuine
// UTS-39 confusable:
//
//   a → а U+0430 CYRILLIC SMALL A   (identical)
//       α U+03B1 GREEK SMALL ALPHA  (strong; slightly softer tail — the
//                                    one lower-precision entry, see report)
//   c → с U+0441 CYRILLIC SMALL ES   (identical)
//   e → е U+0435 CYRILLIC SMALL IE   (identical)
//   i → і U+0456 CYRILLIC SMALL BYELORUSSIAN-UKRAINIAN I (identical, dotted)
//   j → ј U+0458 CYRILLIC SMALL JE   (identical)
//   o → о U+043E CYRILLIC SMALL O    (identical)
//       ο U+03BF GREEK SMALL OMICRON (identical)
//   p → р U+0440 CYRILLIC SMALL ER   (identical)
//   s → ѕ U+0455 CYRILLIC SMALL DZE  (identical; a truer homoglyph than
//                                     sentinel's ś/ş/ș comma-below set)
//   x → х U+0445 CYRILLIC SMALL HA   (identical)
//   y → у U+0443 CYRILLIC SMALL U    (identical lowercase form)
export const CONFUSABLES: Record<string, string[]> = {
  a: ['а', 'α'],
  c: ['с'],
  e: ['е'],
  i: ['і'],
  j: ['ј'],
  o: ['о', 'ο'],
  p: ['р'],
  s: ['ѕ'],
  x: ['х'],
  y: ['у'],
};

// Bounding — prevents IDN candidate blow-up (detection-quality core).
export const IDN_PER_CHAR_CAP = 2; // max confusables tried per base char
export const IDN_GLOBAL_QUOTA = 8; // max idn variants generated per domain

/**
 * ToASCII (IDNA/UTS-46) via the V8 `URL` API — no npm dependency. Returns
 * the punycode `xn--…` hostname, or null if the runtime rejects the label
 * (IDNA-disallowed codepoints throw or yield an empty hostname).
 */
export function encodeIdnHost(unicodeName: string, tld: string): string | null {
  try {
    const host = new URL(`http://${unicodeName}.${tld}`).hostname;
    return host ? host : null;
  } catch {
    return null;
  }
}

// ─── TLD alternatives ───────────────────────────────────────────

const ALT_TLDS = ['com', 'net', 'org', 'co', 'io', 'app', 'xyz', 'info', 'biz', 'site', 'online', 'us', 'ca'];

// ─── Keyword modifiers ──────────────────────────────────────────

const PREFIXES = ['secure-', 'login-', 'my', 'account-', 'www-', 'mail-', 'update-', 'verify-'];
const SUFFIXES = ['-login', '-secure', '-verify', '-support', '-online', '-auth', '-portal'];

// Identity-provider lures (Scattered Spider / 0ktapus: acme-okta.com,
// acme-sso.com, acme-servicedesk.com — docs/IDP_IMPERSONATION_PLAN_2026-10.md
// T5). Generated as 'keyword' permutations but RESERVED inside the 30-cap
// below: keyword sorts after typosquat/homoglyph/tld_swap, so without a
// reservation the cap drops every keyword permutation for any name longer
// than ~3 characters and these would never be seeded.
export const IDP_LURE_PREFIXES: readonly string[] = ['okta-', 'sso-'];
export const IDP_LURE_SUFFIXES: readonly string[] = ['-sso', '-okta', '-helpdesk', '-servicedesk', '-vpn'];

// ─── Generator ──────────────────────────────────────────────────

export function generatePermutations(domain: string): DomainPermutation[] {
  const parts = domain.split('.');
  if (parts.length < 2) return [];

  const name = parts[0]!;
  const tld = parts.slice(1).join('.');
  const seen = new Set<string>();
  const results: DomainPermutation[] = [];

  function add(d: string, type: DomainPermutation['type'], display?: string): boolean {
    const lower = d.toLowerCase();
    // Skip the original domain and duplicates
    if (lower === domain || seen.has(lower)) return false;
    // Basic validity: must have at least 2 chars in name, only ascii-safe for DNS
    const namePart = lower.split('.')[0] ?? '';
    if (namePart.length < 2) return false;
    seen.add(lower);
    results.push(display ? { domain: lower, type, display } : { domain: lower, type });
    return true;
  }

  // 1. Character omission: remove each character
  for (let i = 0; i < name.length; i++) {
    const omitted = name.slice(0, i) + name.slice(i + 1);
    add(`${omitted}.${tld}`, 'typosquat');
  }

  // 2. Adjacent character swap (transposition)
  for (let i = 0; i < name.length - 1; i++) {
    const swapped = name.slice(0, i) + name[i + 1] + name[i] + name.slice(i + 2);
    add(`${swapped}.${tld}`, 'typosquat');
  }

  // 3. Character doubling (repetition)
  for (let i = 0; i < name.length; i++) {
    const doubled = name.slice(0, i + 1) + name[i] + name.slice(i + 1);
    add(`${doubled}.${tld}`, 'typosquat');
  }

  // 4. Character replacement (adjacent keyboard keys)
  const keyboard: Record<string, string[]> = {
    q: ['w', 'a'], w: ['q', 'e', 's'], e: ['w', 'r', 'd'], r: ['e', 't', 'f'],
    t: ['r', 'y', 'g'], y: ['t', 'u', 'h'], u: ['y', 'i', 'j'], i: ['u', 'o', 'k'],
    o: ['i', 'p', 'l'], p: ['o'],
    a: ['q', 's', 'z'], s: ['a', 'w', 'd', 'x'], d: ['s', 'e', 'f', 'c'],
    f: ['d', 'r', 'g', 'v'], g: ['f', 't', 'h', 'b'], h: ['g', 'y', 'j', 'n'],
    j: ['h', 'u', 'k', 'm'], k: ['j', 'i', 'l'], l: ['k', 'o'],
    z: ['a', 'x'], x: ['z', 's', 'c'], c: ['x', 'd', 'v'],
    v: ['c', 'f', 'b'], b: ['v', 'g', 'n'], n: ['b', 'h', 'm'], m: ['n', 'j'],
  };
  for (let i = 0; i < name.length; i++) {
    const ch = name[i]!.toLowerCase();
    const neighbors = keyboard[ch];
    if (neighbors) {
      for (const n of neighbors.slice(0, 2)) {
        const replaced = name.slice(0, i) + n + name.slice(i + 1);
        add(`${replaced}.${tld}`, 'typosquat');
      }
    }
  }

  // 5. Homoglyph substitution (first occurrence only, limit 2 per char)
  for (const [char, subs] of Object.entries(HOMOGLYPHS)) {
    const idx = name.indexOf(char);
    if (idx >= 0) {
      for (const sub of subs.slice(0, 2)) {
        // Only use ASCII-safe substitutions for valid domains
        if (/^[a-z0-9-]+$/.test(sub)) {
          const variant = name.slice(0, idx) + sub + name.slice(idx + 1);
          add(`${variant}.${tld}`, 'homoglyph');
        }
      }
    }
  }

  // 5b. IDN / punycode homoglyph substitution (S2.4 / C5-D7).
  //     Single substitution only, first occurrence per base char (mirrors
  //     the ASCII homoglyph discipline above), per-char + global caps.
  //     The `domain` we store is the xn-- ToASCII form (so DoH resolves
  //     it); `display` carries the unicode form for human-readable alerts.
  let idnCount = 0;
  idn: for (const [base, confs] of Object.entries(CONFUSABLES)) {
    const idx = name.indexOf(base);
    if (idx < 0) continue;
    let perChar = 0;
    for (const conf of confs) {
      if (perChar >= IDN_PER_CHAR_CAP) break;
      if (idnCount >= IDN_GLOBAL_QUOTA) break idn;
      const unicodeName = name.slice(0, idx) + conf + name.slice(idx + 1);
      const asciiHost = encodeIdnHost(unicodeName, tld);
      // IDNA-disallowed codepoint → skip without throwing.
      if (!asciiHost) continue;
      // No-op guards: a substitution that ToASCII-collapses back to the
      // original, or NFC-folds to the ASCII label, is not a real variant.
      if (asciiHost === domain.toLowerCase()) continue;
      if (unicodeName.normalize('NFC') === name.toLowerCase()) continue;
      // add() lowercases + dedups against the seen set, so an xn-- host
      // can never collide with an existing ASCII variant.
      const display = `${unicodeName}.${tld}`.toLowerCase();
      if (add(asciiHost, 'idn_homoglyph', display)) {
        perChar++;
        idnCount++;
      }
    }
  }

  // 6. TLD swap
  for (const alt of ALT_TLDS) {
    if (alt !== tld) {
      add(`${name}.${alt}`, 'tld_swap');
    }
  }

  // 7. Hyphenation: insert hyphen at word boundaries or arbitrary positions
  for (let i = 1; i < name.length; i++) {
    if (name[i - 1] !== '-' && name[i] !== '-') {
      add(`${name.slice(0, i)}-${name.slice(i)}.${tld}`, 'hyphenation');
    }
  }

  // 8. Keyword additions (prefix/suffix attacks)
  for (const p of PREFIXES) {
    add(`${p}${name}.${tld}`, 'keyword');
  }
  for (const s of SUFFIXES) {
    add(`${name}${s}.${tld}`, 'keyword');
  }
  // 8b. IdP lures — tracked so they can be reserved inside the cap.
  const idpLure = new Set<string>();
  for (const p of IDP_LURE_PREFIXES) {
    if (add(`${p}${name}.${tld}`, 'keyword')) idpLure.add(`${p}${name}.${tld}`.toLowerCase());
  }
  for (const s of IDP_LURE_SUFFIXES) {
    if (add(`${name}${s}.${tld}`, 'keyword')) idpLure.add(`${name}${s}.${tld}`.toLowerCase());
  }

  // Return top 30 most likely permutations (prioritize by type relevance).
  // idn_homoglyph slots between homoglyph and tld_swap; the ASCII types keep
  // their existing relative order (typosquat < homoglyph < tld_swap <
  // keyword < hyphenation), so ASCII ordering is unchanged.
  const typeOrder: Record<string, number> = {
    typosquat: 0,
    homoglyph: 1,
    idn_homoglyph: 2,
    tld_swap: 3,
    keyword: 4,
    hyphenation: 5,
  };
  const byType = (a: DomainPermutation, b: DomainPermutation): number =>
    (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9);

  // Reserved quota: the 30-cap is dominated by typosquat, so a pure
  // sort+slice would starve IDN variants. Reserve the generated idn set
  // (already bounded to IDN_GLOBAL_QUOTA) inside the cap; ASCII fills the
  // remainder by type priority. Note: for confusable-dense names whose ASCII
  // permutations already exceed CAP-idnCount, the reserved idn slots displace
  // the lowest-priority ASCII *survivors* (down to the homoglyph tier for very
  // dense names) — the intended anti-starvation tradeoff, since idn_homoglyph
  // is ~equivalent in value to homoglyph. Short names see no displacement.
  //
  // IdP lures (8b) are reserved the same way, so the total stays at 30: they
  // displace the lowest-priority ASCII survivors (the tail of typosquat for
  // a typical name), never IDN slots.
  const CAP = 30;
  const idnPicks = results.filter((r) => r.type === 'idn_homoglyph');
  const idpPicks = results.filter((r) => idpLure.has(r.domain));
  const asciiPicks = results
    .filter((r) => r.type !== 'idn_homoglyph' && !idpLure.has(r.domain))
    .sort(byType)
    .slice(0, Math.max(0, CAP - idnPicks.length - idpPicks.length));
  return [...asciiPicks, ...idpPicks, ...idnPicks].sort(byType);
}

// ─── DNS resolution check via Cloudflare DoH ────────────────────

export interface LookalikeCheckResult {
  domain: string;
  type: string;
  registered: boolean;
  ip?: string;
}

export async function checkLookalikeDNS(
  permutations: DomainPermutation[],
  maxCheck = 20,
): Promise<LookalikeCheckResult[]> {
  const toCheck = permutations.slice(0, maxCheck);
  const BATCH = 5;
  const results: LookalikeCheckResult[] = [];

  for (let i = 0; i < toCheck.length; i += BATCH) {
    const batch = toCheck.slice(i, i + BATCH);
    const checks = batch.map(async (perm): Promise<LookalikeCheckResult> => {
      try {
        const res = await fetch(
          `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(perm.domain)}&type=A`,
          {
            headers: { Accept: 'application/dns-json' },
            signal: AbortSignal.timeout(3000),
          },
        );
        if (res.ok) {
          const data = (await res.json()) as { Answer?: Array<{ data: string }> };
          if (data.Answer && data.Answer.length > 0) {
            return {
              domain: perm.domain,
              type: perm.type,
              registered: true,
              ip: data.Answer[0]?.data,
            };
          }
        }
        return { domain: perm.domain, type: perm.type, registered: false };
      } catch {
        return { domain: perm.domain, type: perm.type, registered: false };
      }
    });
    results.push(...(await Promise.all(checks)));
  }

  return results;
}
