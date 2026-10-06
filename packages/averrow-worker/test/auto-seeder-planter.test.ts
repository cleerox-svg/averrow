import { describe, it, expect } from 'vitest';
import {
  roleLocalPartVariants, plantBatch, readRoster, isRoleMailboxAddress, ROLE_WORDS,
} from '../src/lib/auto-seeder-planter';
import { parseTrapAddress } from '../src/spam-trap';

// G37 (owner decision 2026-10-06): no invented people on any honeypot page —
// planted addresses are role-style mailboxes, never person names.

// Every first/last name the planter (and the old templates) ever used.
const PERSON_NAMES = [
  'sarah', 'james', 'emily', 'michael', 'olivia', 'david', 'emma', 'robert', 'sophia',
  'william', 'ava', 'daniel', 'mia', 'matthew', 'isabella', 'andrew', 'charlotte', 'ryan',
  'amelia', 'nathan', 'lisa', 'kevin', 'amanda', 'chris', 'rachel', 'tom', 'jessica',
  'brian', 'megan', 'eric', 'sophie', 'marcus', 'hannah', 'ethan', 'maya', 'owen', 'zoe',
  'lucas', 'chloe', 'henry', 'claude', 'jennifer',
  'chen', 'williams', 'patel', 'johnson', 'kim', 'singh', 'brown', 'lee', 'garcia',
  'wilson', 'thompson', 'martinez', 'anderson', 'taylor', 'thomas', 'white', 'harris',
  'clark', 'lewis', 'walker', 'park', 'cooper', 'bennett', 'reyes', 'nguyen', 'foster',
  'ramirez', 'hughes', 'murphy', 'bailey', 'smith', 'rodriguez', 'davis',
];

const SEEDS = [
  0, 1, 2, 100,
  2 ** 31, 2 ** 31 + 5, 2 ** 31 + 7, 2 ** 32 - 1, // negative under the old signed mask
  Date.now() >>> 0,
  -1, -123, // defensive: negative seeds must still resolve
];

describe('roleLocalPartVariants', () => {
  it('offers several distinct `<word>-hp<NNN>` candidates for any seed', () => {
    for (const s of SEEDS) {
      const v = roleLocalPartVariants(s);
      expect(new Set(v).size).toBe(v.length);
      expect(v.length).toBeGreaterThanOrEqual(6);
      for (const lp of v) {
        expect(lp, `seed ${s}`).toMatch(/^[a-z]+-hp[1-9]\d{2}$/);
        expect(isRoleMailboxAddress(`${lp}@averrow.ca`)).toBe(true);
      }
    }
  });

  it('is filed under the honeypot channel by the spam-trap parser', () => {
    for (let i = 0; i < 64; i++) {
      for (const lp of roleLocalPartVariants(2 ** 31 + i)) {
        expect(parseTrapAddress(`${lp}@averrow.ca`).channel, lp).toBe('honeypot');
      }
    }
  });

  it('never contains a person name', () => {
    const hits: string[] = [];
    for (let i = 0; i < 2048; i++) {
      for (const lp of roleLocalPartVariants(i * 7919)) {
        const word = lp.split('-')[0]!;
        for (const n of PERSON_NAMES) if (word.includes(n)) hits.push(`${lp}~${n}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('draws only from the role-word pool, which holds no person name', () => {
    for (const w of ROLE_WORDS) {
      expect(w).toMatch(/^[a-z]+$/);
      for (const n of PERSON_NAMES) expect(w).not.toBe(n);
    }
  });

  it('holds no word the inbound mail router sends to the abuse mailbox first', () => {
    // index.ts email(): verify-/verify_/report-/abuse- prefixes and these
    // bare locals go to the abuse mailbox before the spam trap.
    for (const w of ROLE_WORDS) {
      expect(['abuse', 'phishing', 'report', 'security', 'verify']).not.toContain(w);
    }
  });
});

describe('isRoleMailboxAddress', () => {
  it.each([
    ['helpdesk-hp417@averrow.ca', true],
    ['itops-hp20@averrow.ca', true],
    ['billing-hp20260101@lrxradar.com', true],
    ['sarah.chen@averrow.ca', false],
    ['schen42@averrow.ca', false],
    ['sarahchen@averrow.ca', false],
    ['sarah_chen@averrow.ca', false],
    ['sarah.chen.20260101@averrow.ca', false],
    ['info-cp01@averrow.ca', false],
  ])('%s -> %s', (addr, ok) => {
    expect(isRoleMailboxAddress(addr)).toBe(ok);
  });
});

// Minimal D1 stand-in: records every statement, treats `existing` as
// already-planted addresses.
function fakeEnv(existing: Set<string>) {
  const calls: string[] = [];
  const inserts: unknown[][] = [];
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
          inserts.push([sql, ...args]);
          const addr = args[0] as string;
          if (existing.has(addr)) return { meta: { changes: 0 } };
          existing.add(addr);
          return { meta: { changes: 1, last_row_id: existing.size } };
        },
      };
      return stmt;
    },
  };
  return { env: { DB } as never, calls, inserts };
}

describe('plantBatch', () => {
  it('plants role-style addresses with no person name, filed as honeypot', async () => {
    const { env, inserts } = fakeEnv(new Set());
    const planted = await plantBatch(env, { domain: 'averrow.ca', seedLocationKey: 'k', count: 24, cohortTag: '20260101' });
    expect(planted).toHaveLength(24);
    for (const p of planted) {
      expect(p.email).toMatch(/^[a-z]+-hp\d+@averrow\.ca$/);
      expect(p.name).toBe('');
      expect(p.title).toBe('');
      const local = p.email.split('@')[0]!;
      for (const n of PERSON_NAMES) expect(local, p.email).not.toContain(n);
      expect(parseTrapAddress(p.email).channel).toBe('honeypot');
    }
    for (const [sql] of inserts) expect(sql).toContain("'honeypot'");
  });

  it('falls back to the cohort-tagged form with exactly 2 queries per seed when saturated', async () => {
    // Pre-fill every `<word>-hp<100–999>` candidate.
    const existing = new Set<string>();
    for (const w of ROLE_WORDS) for (let n = 100; n < 1000; n++) existing.add(`${w}-hp${n}@x.test`);
    const { env, calls } = fakeEnv(existing);
    const planted = await plantBatch(env, { domain: 'x.test', seedLocationKey: 'k', count: 5, cohortTag: '20260101' });
    expect(planted.length).toBeGreaterThan(0);
    for (const p of planted) expect(p.email).toMatch(/^[a-z]+-hp20260101@x\.test$/);
    expect(calls).toHaveLength(10);
  });
});

describe('readRoster', () => {
  function rosterEnv(rows: Array<{ id: number; address: string }>) {
    const binds: unknown[][] = [];
    const DB = {
      prepare() {
        let args: unknown[] = [];
        const stmt = {
          bind(...a: unknown[]) { args = a; binds.push(a); return stmt; },
          async all() { return { results: rows.slice(0, args[1] as number) }; },
        };
        return stmt;
      },
    };
    return { env: { DB } as never, binds };
  }

  it('skips legacy name-shaped seeds and returns role-style ones without names', async () => {
    const { env } = rosterEnv([
      { id: 9, address: 'helpdesk-hp417@averrow.ca' },
      { id: 8, address: 'sarah.chen@averrow.ca' },
      { id: 7, address: 'schen42@averrow.ca' },
      { id: 6, address: 'payroll-hp233@averrow.ca' },
    ]);
    const roster = await readRoster(env, 'auto-seeder:averrow.ca:/admin-portal', 16);
    expect(roster.map((r) => r.email)).toEqual(['helpdesk-hp417@averrow.ca', 'payroll-hp233@averrow.ca']);
    for (const r of roster) { expect(r.name).toBe(''); expect(r.title).toBe(''); }
  });

  it('over-reads so legacy rows cannot starve the page, then caps at limit', async () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => ({ id: 100 - i, address: `legacy.name${i}@averrow.ca` })),
      ...Array.from({ length: 10 }, (_, i) => ({ id: 50 - i, address: `ops-hp${100 + i}@averrow.ca` })),
    ];
    const { env, binds } = rosterEnv(rows);
    const roster = await readRoster(env, 'k', 4);
    expect(binds[0]![1]).toBe(16);
    expect(roster).toHaveLength(4);
    expect(roster.every((r) => isRoleMailboxAddress(r.email))).toBe(true);
  });

  it('returns [] when only legacy rows exist (caller falls back to defaults)', async () => {
    const { env } = rosterEnv([{ id: 1, address: 'kevin.park@averrow.ca' }]);
    expect(await readRoster(env, 'k', 16)).toEqual([]);
  });
});
