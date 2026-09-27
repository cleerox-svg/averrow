import { describe, it, expect } from 'vitest';
import { synthName, localPartVariants, displayNameFromLocalPart } from '../src/lib/auto-seeder-planter';

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
    ['schen', 'Schen'],
  ])('%s -> %s', (local, name) => {
    expect(displayNameFromLocalPart(local)).toBe(name);
  });
});
