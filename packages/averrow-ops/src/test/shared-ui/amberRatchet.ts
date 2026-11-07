// Amber ratchet counter (P3-2a), shared by primary-tokens.test.ts.
// Counts primary-pattern amber hits per package so the count can only go down.
// This file is excluded from its own count (its patterns name the literals).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

export const RATCHET_PACKAGES = ['averrow-ops', 'averrow-tenant', 'shared'] as const;
const PATTERNS: Record<string, RegExp> = {
  'var(--amber)': /var\(--amber\)/g,
  '#e5a832': /#e5a832/gi,
  'rgba(229, 168, 50': /rgba\(\s*229\s*,\s*168\s*,\s*50\b/g,
  'tailwind (text|bg|border|ring)-amber': /\b(?:text|bg|border|ring)-amber\b/g,
};
export const RATCHET_PATTERN_KEYS = Object.keys(PATTERNS);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.turbo', 'coverage']);
const SELF = resolve(__dirname, 'amberRatchet.ts');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== 'appearance.css' && p !== SELF) out.push(p);
  }
  return out;
}

/** Count per package + pattern under `<packagesDir>/<pkg>/src`. tokens.css custom-property DEFINITIONS are allowlisted. */
export function countAmber(packagesDir: string): Record<string, Record<string, number>> {
  const result: Record<string, Record<string, number>> = {};
  for (const pkg of RATCHET_PACKAGES) {
    const counts: Record<string, number> = Object.fromEntries(RATCHET_PATTERN_KEYS.map((k) => [k, 0]));
    for (const file of walk(resolve(packagesDir, pkg, 'src'))) {
      let src = readFileSync(file, 'utf8');
      if (relative(packagesDir, file) === join('shared', 'src', 'theme', 'tokens.css')) {
        src = src.split('\n').filter((l) => !/^\s*--[\w-]+\s*:/.test(l)).join('\n');
      }
      for (const [k, re] of Object.entries(PATTERNS)) counts[k]! += src.match(re)?.length ?? 0;
    }
    result[pkg] = counts;
  }
  return result;
}
