import { describe, it, expect } from 'vitest';
import { synthName, localPartVariants, displayNameFromLocalPart, plantBatch } from '../src/lib/auto-seeder-planter';

// Regression for the spam-trap drought (2026-06): `Date.now() & 0xffffffff`
// produced a SIGNED 32-bit int that went negative ~half of each ~50-day
// cycle, so synthName indexed FIRST_NAMES[-n] === undefined and crashed
// localPart's .toLowerCase() — zeroing out all honeypot planting.
describe('synthName', () => {
  const seeds = [
    0, 1, 2, 100,
    2 ** 31, 2 ** 31 + 5, 2 ** 31 + 7, 2 ** 32 - 1, // would be negative under the old signed mask
    Date.now() >>> 0,
    -1, -123, // defensive: negative seeds must still resolve
  ];

  it('returns non-empty names + title for any seed (incl. previously-negative ones)', () => {
    for (const s of seeds) {
      const { firstName, lastName, title } = synthName(s);
      expect(firstName, `firstName for seed ${s}`).toBeTypeOf('string');
      expect(firstName.length).toBeGreaterThan(0);
      expect(lastName.length).toBeGreaterThan(0);
      expect(title.length).toBeGreaterThan(0);
    }
  });

  it('never throws building the local part (the exact crash site)', () => {
    for (let i = 0; i < 256; i++) {
      const { firstName, lastName } = synthName(2 ** 31 + i);
      expect(() => `${firstName.toLowerCase()}.${lastName.toLowerCase()}`).not.toThrow();
    }
  });
});

// 2026-09: the 1,200-pair name pool saturated, so nearly every new seed fell
// through to `first.last.YYYYMMDD` — a date stamp harvesters and list
// cleaners discard. Collisions must now land on realistic directory shapes.
describe('localPartVariants', () => {
  it('offers several distinct, date-free, RFC-safe candidates', () => {
    for (let i = 0; i < 64; i++) {
      const { firstName, lastName } = synthName(2 ** 31 + i);
      const v = localPartVariants(firstName, lastName, 2 ** 31 + i);
      expect(new Set(v).size).toBe(v.length);
      expect(v.length).toBeGreaterThanOrEqual(6);
      for (const lp of v) {
        expect(lp).toMatch(/^[a-z][a-z0-9._]*[a-z0-9]$/);
        expect(lp).not.toMatch(/\d{8}/); // no YYYYMMDD stamp
      }
    }
  });

  it('keeps first.last as the first choice (existing roster shape)', () => {
    expect(localPartVariants('Sarah', 'Chen', 1)[0]).toBe('sarah.chen');
  });

  it('never goes negative on the digit suffix', () => {
    for (const s of [-1, -999, 2 ** 32 - 1]) {
      const last = localPartVariants('Sarah', 'Chen', s).at(-1)!;
      expect(last).toMatch(/^schen[1-9]\d$/);
    }
  });
});

describe('displayNameFromLocalPart', () => {
  it.each([
    ['sarah.chen', 'Sarah Chen'],
    ['s.chen', 'S. Chen'],
    ['sarah.c', 'Sarah C.'],
    ['sarah_chen', 'Sarah Chen'],
    ['sarah.chen42', 'Sarah Chen'],
    ['schen', 'S. Chen'],
    ['sarahchen', 'Sarah Chen'],
    ['schen42', 'S. Chen'],
    ['zzz', 'Zzz'],
  ])('%s -> %s', (local, name) => {
    expect(displayNameFromLocalPart(local)).toBe(name);
  });
});

describe('plantBatch', () => {
  // Minimal D1 stand-in: records every statement, treats `existing` as
  // already-planted addresses.
  function fakeEnv(existing: Set<string>) {
    const calls: string[] = [];
    const DB = {
      prepare(sql: string) {
        let args: unknown[] = [];
        const stmt = {
          bind(...a: unknown[]) { args = a; return stmt; },
          async all() {
            calls.push('select');
            return { results: (args as string[]).filter((a) => existing.has(a)).map((address) => ({ address })) };
          },
          async run() {
            calls.push('insert');
            const addr = args[0] as string;
            if (existing.has(addr)) return { meta: { changes: 0 } };
            existing.add(addr);
            return { meta: { changes: 1, last_row_id: existing.size } };
          },
        };
        return stmt;
      },
    };
    return { env: { DB } as never, calls };
  }

  it('plants the first free candidate with exactly 2 queries per seed, even when saturated', async () => {
    // Pre-fill every variant except the cohort-tagged fallback, for every name.
    const existing = new Set<string>();
    for (let i = 0; i < 1200; i++) {
      const { firstName, lastName } = synthName(i);
      for (let s = 0; s < 90; s++) {
        for (const lp of localPartVariants(firstName, lastName, s)) existing.add(`${lp}@x.test`);
      }
    }
    const { env, calls } = fakeEnv(existing);
    const planted = await plantBatch(env, { domain: 'x.test', seedLocationKey: 'k', count: 5, cohortTag: '20260101' });
    expect(planted).toHaveLength(5);
    for (const p of planted) expect(p.email).toMatch(/\.20260101@x\.test$/);
    expect(calls).toHaveLength(10);
  });

  it('prefers first.last when it is free', async () => {
    const { env } = fakeEnv(new Set());
    const [p] = await plantBatch(env, { domain: 'x.test', seedLocationKey: 'k', count: 1, cohortTag: '20260101' });
    expect(p!.email).toMatch(/^[a-z]+\.[a-z]+@x\.test$/);
  });
});
