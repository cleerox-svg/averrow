/**
 * Lookalike Domain Generator (dnstwist-style)
 *
 * Generates domain permutations to detect typosquatting,
 * homoglyph attacks, TLD swaps, hyphenation tricks,
 * and keyword-based impersonation domains.
 */

export interface DomainPermutation {
  domain: string;
  type: 'typosquat' | 'homoglyph' | 'tld_swap' | 'hyphenation' | 'keyword';
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

// ─── TLD alternatives ───────────────────────────────────────────

const ALT_TLDS = ['com', 'net', 'org', 'co', 'io', 'app', 'xyz', 'info', 'biz', 'site', 'online', 'us', 'ca'];

// ─── Keyword modifiers ──────────────────────────────────────────

const PREFIXES = ['secure-', 'login-', 'my', 'account-', 'www-', 'mail-', 'update-', 'verify-'];
const SUFFIXES = ['-login', '-secure', '-verify', '-support', '-online', '-auth', '-portal'];

// ─── Generator ──────────────────────────────────────────────────

export function generatePermutations(domain: string): DomainPermutation[] {
  const parts = domain.split('.');
  if (parts.length < 2) return [];

  const name = parts[0]!;
  const tld = parts.slice(1).join('.');
  const seen = new Set<string>();
  const results: DomainPermutation[] = [];

  function add(d: string, type: DomainPermutation['type']): void {
    const lower = d.toLowerCase();
    // Skip the original domain and duplicates
    if (lower === domain || seen.has(lower)) return;
    // Basic validity: must have at least 2 chars in name, only ascii-safe for DNS
    const namePart = lower.split('.')[0] ?? '';
    if (namePart.length < 2) return;
    seen.add(lower);
    results.push({ domain: lower, type });
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

  // Return top 30 most likely permutations (prioritize by type relevance)
  const typeOrder: Record<string, number> = {
    typosquat: 0,
    homoglyph: 1,
    tld_swap: 2,
    keyword: 3,
    hyphenation: 4,
  };
  results.sort((a, b) => (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9));
  return results.slice(0, 30);
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
