/**
 * Auto-seeder planter — synthesizes new spam-trap addresses and reads
 * the active roster for the public honeypot pages.
 *
 * Design:
 *   The /admin-portal, /internal-staff, /team-directory and /staff-contacts
 *   pages are crawler bait — bots scraping disallowed paths (per robots.txt)
 *   harvest the email addresses listed there and feed them into spam
 *   campaigns. Historically the listed addresses were hardcoded in
 *   the template (7 total, never rotated), which is why 96 of 101
 *   seeded addresses had never caught anything (PR #873 investigation).
 *
 *   This module flips that: addresses live in seed_addresses, and the
 *   page renders the latest active set. The auto-seeder agent adds
 *   ~6 fresh addresses per page every Sunday, so a harvester that
 *   scrapes us in week 4 sees a different set than one in week 1.
 *
 *   Address shape (DISCLOSURE_REGISTER G37, owner decision 2026-10-06 —
 *   "no invented people on any honeypot page"): addresses are role-style
 *   mailboxes, NEVER person names, not even in the local part. Each one is
 *   `<function word>-hp<number>` (e.g. `helpdesk-hp417@averrow.ca`) — the
 *   same seed format as the template defaults (`itops-hp20`), which
 *   parseTrapAddress (spam-trap.ts) files under the "honeypot" channel.
 *   Rows planted before this change were `first.last`-shaped; readRoster
 *   filters them out so they are never rendered again (they stay active
 *   as traps — a harvester that already has them still gets caught).
 */

import type { Env } from "../types";
import { logger } from "./logger";

// ─── Role / function word pool ───────────────────────────────────
//
// Department and mailbox-function words only. Lowercase letters, no
// separators: parseTrapAddress' seed regex is `^[\w]+-([a-z]{2})\d+$`, so a
// hyphen inside the word would stop the address being filed as "honeypot".
// No word may be (or start like) a personal name.
export const ROLE_WORDS = [
  "ops", "itops", "helpdesk", "servicedesk", "billing", "accounts",
  "procurement", "securitydesk", "noc", "payroll", "vendors", "compliance",
  "onboarding", "facilities", "finance", "legal", "audit", "infra",
  "devops", "records", "treasury", "purchasing", "dispatch", "intake",
] as const;

/**
 * Local parts the roster pages may render: `<word>-hp<digits>`, the shape
 * of both the planter's addresses and the template defaults. Anything
 * else — notably legacy `sarah.chen` / `schen42` rows — is never shown.
 */
export const ROLE_MAILBOX_LOCAL_RE = /^[a-z]+-hp\d+$/;

export function isRoleMailboxAddress(address: string): boolean {
  const local = (address.split("@")[0] ?? "").toLowerCase();
  return ROLE_MAILBOX_LOCAL_RE.test(local);
}

export interface RosterEntry {
  /** Full mailto address as embedded in the page. */
  email: string;
  /**
   * Retained for shape compatibility; always "" — the pages render
   * addresses only (G37), so no person name is ever synthesized.
   */
  name: string;
  /** Retained for shape compatibility; always "". */
  title: string;
  /** seed_addresses.id — null when row hasn't been persisted yet. */
  id?: number;
}

// Non-negative modulo. JS `%` keeps the sign of the dividend, so a negative
// `seed` would index ROLE_WORDS[-n] === undefined. Guard every index through
// this.
function modIndex(n: number, len: number): number {
  return ((Math.trunc(n) % len) + len) % len;
}

/**
 * Ordered role-mailbox local-part candidates for one seed:
 * `<word>-hp<100–999>`, mixing the seed through different prime offsets
 * so a contiguous run of seeds spreads across words and numbers. Three-digit
 * numbers keep these clear of the template defaults (hp01–hp36). Pool:
 * 24 words × 900 numbers = 21,600 addresses per domain before the
 * cohort-tagged fallback is needed.
 */
export function roleLocalPartVariants(seed: number): string[] {
  const out: string[] = [];
  for (let k = 0; k < 8; k++) {
    const word = ROLE_WORDS[modIndex(seed * 7 + k * 5, ROLE_WORDS.length)]!;
    const n = modIndex(seed * 13 + k * 101, 900) + 100;
    const lp = `${word}-hp${n}`;
    if (!out.includes(lp)) out.push(lp);
  }
  return out;
}

/**
 * Plant a batch of N role-style mailbox addresses for the given
 * (domain, page) target. seeded_location is keyed on the page so the
 * honeypot handlers can query the right roster at render time.
 *
 * Candidates are roleLocalPartVariants() then a cohort-tagged
 * `<word>-hp<YYYYMMDD>` last resort; one SELECT picks the first free one,
 * and INSERT OR IGNORE (address is UNIQUE) guards the race with a
 * concurrent planter.
 *
 * Returns the rows that actually landed so the caller can report
 * itemsCreated honestly.
 */
export async function plantBatch(
  env: Env,
  opts: {
    domain: string;            // 'averrow.ca' | 'lrxradar.com' | 'trustradar.ca' | …
    seedLocationKey: string;   // e.g. 'auto-seeder:averrow.ca:/admin-portal'
    count: number;
    cohortTag: string;         // e.g. '20260429' — the number on the last-resort candidate
  },
): Promise<RosterEntry[]> {
  const planted: RosterEntry[] = [];
  // `>>> 0` coerces to UNSIGNED 32-bit. The old `& 0xffffffff` produced a
  // SIGNED int (negative when bit 31 is set) and crashed the name lookup on
  // a ~50-day cycle, silently zeroing out all planting from ~2026-06-01.
  const baseSeed = Date.now() >>> 0;

  for (let i = 0; i < opts.count; i++) {
    const seed = baseSeed + i;
    const variants = roleLocalPartVariants(seed);
    // Cohort-tagged form stays as the last resort so a saturated pool
    // still plants rather than silently dropping.
    const tries = [
      ...variants.map(lp => `${lp}@${opts.domain}`),
      `${variants[0]!.replace(/-hp\d+$/, '')}-hp${opts.cohortTag}@${opts.domain}`,
    ];

    // One read for all candidates, then one INSERT of the first free one:
    // 2 round-trips per seed however saturated the pool gets.
    try {
      const placeholders = tries.map(() => '?').join(', ');
      const taken = await env.DB.prepare(
        `SELECT address FROM seed_addresses WHERE address IN (${placeholders})`,
      ).bind(...tries).all<{ address: string }>();
      const takenSet = new Set((taken.results ?? []).map((r) => r.address));
      const address = tries.find((a) => !takenSet.has(a));
      if (!address) continue;

      // channel 'honeypot' matches how parseTrapAddress files `-hpNN`.
      const result = await env.DB.prepare(
        `INSERT OR IGNORE INTO seed_addresses
           (address, domain, channel, seeded_location, status)
         VALUES (?, ?, 'honeypot', ?, 'active')`,
      ).bind(address, opts.domain, opts.seedLocationKey).run();

      if ((result.meta?.changes ?? 0) > 0) {
        planted.push({
          email: address,
          name: '',
          title: '',
          id: result.meta?.last_row_id as number | undefined,
        });
      }
    } catch (err) {
      logger.warn('auto_seeder_plant_failed', {
        candidate: tries[0],
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return planted;
}

/**
 * Read the latest active role-style roster for a given seed_location, used
 * by the page render handlers. Returns up to `limit` rows, newest-first.
 *
 * Only `<word>-hp<digits>` addresses are returned (isRoleMailboxAddress):
 * legacy name-shaped rows planted before G37 are skipped. The SQL over-reads
 * (limit × 4, capped) so a location still dominated by legacy rows can fill
 * the page; with nothing qualifying the caller falls back to the template's
 * default roster.
 *
 * Best-effort: if the DB read throws or returns empty, callers fall
 * back to a hardcoded default roster. Honeypot pages must always render —
 * silent "we lost the page entirely" is worse than "we showed last week's set."
 */
export async function readRoster(
  env: Env,
  seedLocationKey: string,
  limit: number,
): Promise<RosterEntry[]> {
  try {
    const rows = await env.DB.prepare(
      `SELECT id, address
       FROM seed_addresses
       WHERE seeded_location = ? AND status = 'active'
       ORDER BY id DESC
       LIMIT ?`,
    ).bind(seedLocationKey, Math.min(limit * 4, 200)).all<{ id: number; address: string }>();

    return (rows.results ?? [])
      .filter((row) => isRoleMailboxAddress(row.address))
      .slice(0, limit)
      .map((row) => ({ id: row.id, email: row.address, name: '', title: '' }));
  } catch (err) {
    logger.warn('auto_seeder_read_roster_failed', {
      seedLocationKey,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Build the cohortTag for the current seed week: 'YYYYMMDD' of the
 * scheduled run start. Used as the number on the last-resort address
 * candidate and as a hint in agent_outputs so the operator can see what
 * cohort a given address came from.
 */
export function cohortTag(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}
