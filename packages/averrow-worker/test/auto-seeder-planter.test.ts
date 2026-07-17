import { describe, it, expect } from 'vitest';
import { synthName } from '../src/lib/auto-seeder-planter';

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
