/**
 * Auto-seeder planter — synthesizes new spam-trap addresses and reads
 * the active roster for the public honeypot pages.
 *
 * Design:
 *   The /admin-portal and /internal-staff pages on averrow.com are
 *   crawler bait — bots scraping disallowed paths (per robots.txt)
 *   harvest the email addresses listed there and feed them into spam
 *   campaigns. Historically the listed addresses were hardcoded in
 *   the template (7 total, never rotated), which is why 96 of 101
 *   seeded addresses had never caught anything (PR #873 investigation).
 *
 *   This module flips that: addresses live in seed_addresses, and the
 *   page renders the latest active set. The auto-seeder agent adds
 *   ~6 fresh addresses per page every Sunday, so a harvester that
 *   scrapes us in week 4 sees a different set than one in week 1.
 *   Address volume grows linearly: ~12 addresses/week × 52 = ~600
 *   per year. Plenty of trap surface even before external posting.
 *
 *   "Realistic" address synthesis: first.last@<domain> for employee
 *   channel, drawn from the same FIRST/LAST/TITLE name pools the
 *   honeypot-generator already uses. Every address is unique because
 *   we suffix a short cohort id (yyMMdd of seed week) when the raw
 *   first.last collides — keeps the address looking realistic without
 *   hp-style numeric suffixes that smart spammers might pattern-match.
 */

import type { Env } from "../types";
import { logger } from "./logger";

// ─── Realistic name pools ────────────────────────────────────────
//
// Same shape as honeypot-generator.ts uses for the Haiku-rendered
// trap sites — duplicated here intentionally so the auto-seeder is
// self-contained and doesn't hot-import the honeypot generator's
// AI-call dependencies on its weekly cron path.

const FIRST_NAMES = [
  "Sarah", "James", "Emily", "Michael", "Olivia", "David", "Emma", "Robert",
  "Sophia", "William", "Ava", "Daniel", "Mia", "Matthew", "Isabella",
  "Andrew", "Charlotte", "Ryan", "Amelia", "Nathan", "Lisa", "Kevin",
  "Amanda", "Chris", "Rachel", "Tom", "Jessica", "Brian", "Megan", "Eric",
  "Sophie", "Marcus", "Hannah", "Ethan", "Maya", "Owen", "Zoe", "Lucas",
  "Chloe", "Henry",
];
const LAST_NAMES = [
  "Chen", "Williams", "Patel", "Johnson", "Kim", "Singh", "Brown", "Lee",
  "Garcia", "Wilson", "Thompson", "Martinez", "Anderson", "Taylor", "Thomas",
  "White", "Harris", "Clark", "Lewis", "Walker", "Park", "Cooper", "Bennett",
  "Reyes", "Nguyen", "Foster", "Ramirez", "Hughes", "Murphy", "Bailey",
];
const TITLES = [
  "Operations Director", "Senior Consultant", "Client Relations Manager",
  "Business Development Lead", "Strategy Analyst", "Project Manager",
  "Account Executive", "IT Director", "DevOps Lead", "Infrastructure Engineer",
  "Customer Success Manager", "Product Manager", "Compliance Officer",
  "Threat Research Lead", "Engineering Manager", "Marketing Director",
];

export interface RosterEntry {
  /** Full mailto address as embedded in the page. */
  email: string;
  /** "Firstname Lastname" — used for the visible name column. */
  name: string;
  /** Plausible-sounding job title. */
  title: string;
  /** seed_addresses.id — null when row hasn't been persisted yet. */
  id?: number;
}

// Non-negative modulo. JS `%` keeps the sign of the dividend, so a negative
// `seed` would compute FIRST_NAMES[-n] === undefined and crash localPart's
// .toLowerCase(). Guard every index through this.
function modIndex(n: number, len: number): number {
  return ((Math.trunc(n) % len) + len) % len;
}

/**
 * Synthesize a unique Firstname Lastname pair using the seed week as a
 * cohort hint. The cohort suffix is only used if a raw first.last
 * collides with an existing seed_address — keeps most addresses
 * looking like real people, not "user-2026-04-29@…".
 */
export function synthName(seed: number): { firstName: string; lastName: string; title: string } {
  // Mix the seed through three different prime offsets so a contiguous
  // run of seeds doesn't produce three Sarah Chens.
  const firstName = FIRST_NAMES[modIndex(seed * 7 + 3, FIRST_NAMES.length)]!;
  const lastName = LAST_NAMES[modIndex(seed * 11 + 5, LAST_NAMES.length)]!;
  const title = TITLES[modIndex(seed * 13 + 1, TITLES.length)]!;
  return { firstName, lastName, title };
}

function localPart(firstName: string, lastName: string, suffix?: string): string {
  const base = `${firstName.toLowerCase()}.${lastName.toLowerCase()}`;
  return suffix ? `${base}.${suffix}` : base;
}

/**
 * Plant a batch of N synthetic employee-style addresses for the given
 * (domain, page) target. seeded_location is keyed on the page so the
 * honeypot handlers can query the right roster at render time.
 *
 * Uses INSERT OR IGNORE on the address column (UNIQUE in schema) so
 * collisions silently skip — important because we don't bind a
 * cohort suffix unless we have to retry. If a name pair collides we
 * try one cohort-suffixed retry; if that also collides we move on
 * (vanishingly unlikely with 40×30 = 1200 first/last pairs).
 *
 * Returns the rows that actually landed so the caller can report
 * itemsCreated honestly.
 */
export async function plantBatch(
  env: Env,
  opts: {
    domain: string;            // 'averrow.com' | 'lrxradar.com' | 'trustradar.ca'
    seedLocationKey: string;   // e.g. 'auto-seeder:averrow.com:/admin-portal'
    count: number;
    cohortTag: string;         // e.g. '20260429' — used as the last.first suffix on collision
  },
): Promise<RosterEntry[]> {
  const planted: RosterEntry[] = [];
  // `>>> 0` coerces to UNSIGNED 32-bit. The old `& 0xffffffff` produced a
  // SIGNED int (negative when bit 31 is set), which made synthName index with
  // a negative modulo → undefined name → crash. The bug surfaced on a ~50-day
  // cycle (Date.now() mod 2^32 spends ~25 days above 2^31); it silently zeroed
  // out all planting from ~2026-06-01, drying up the spam trap.
  const baseSeed = Date.now() >>> 0;

  for (let i = 0; i < opts.count; i++) {
    const { firstName, lastName, title } = synthName(baseSeed + i);
    const tries = [
      `${localPart(firstName, lastName)}@${opts.domain}`,
      `${localPart(firstName, lastName, opts.cohortTag)}@${opts.domain}`,
    ];

    let landed = false;
    for (const address of tries) {
      try {
        const result = await env.DB.prepare(
          `INSERT OR IGNORE INTO seed_addresses
             (address, domain, channel, seeded_location, status)
           VALUES (?, ?, 'employee', ?, 'active')`,
        ).bind(address, opts.domain, opts.seedLocationKey).run();

        const inserted = (result.meta?.changes ?? 0) > 0;
        if (inserted) {
          planted.push({
            email: address,
            name: `${firstName} ${lastName}`,
            title,
            id: result.meta?.last_row_id as number | undefined,
          });
          landed = true;
          break;
        }
        // Silent collision (UNIQUE on address) — try the cohort-suffixed
        // variant on the next loop iteration.
      } catch (err) {
        logger.warn('auto_seeder_plant_failed', {
          address,
          err: err instanceof Error ? err.message : String(err),
        });
        // Bail on this entry, continue with the next i.
        break;
      }
    }
    void landed;
  }

  return planted;
}

/**
 * Read the latest active roster for a given seed_location, used by
 * the page render handlers. Returns up to `limit` rows, newest-first.
 *
 * The address column is the only thing persisted, so we re-derive the
 * displayed name + title at render time from the same synth function.
 * This keeps seed_addresses narrow (just the email) while still letting
 * the page show plausible name/title pairs that match the email's
 * first.last shape.
 *
 * Best-effort: if the DB read throws or returns empty, callers fall
 * back to a hardcoded default roster (renderAdminPortalPage,
 * renderInternalStaffPage). Honeypot pages must always render — silent
 * "we lost the page entirely" is worse than "we showed last week's set."
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
    ).bind(seedLocationKey, limit).all<{ id: number; address: string }>();

    return (rows.results ?? []).map((row) => {
      // Re-derive name + title from the address local-part so the page
      // shows e.g. "Sarah Chen — Operations Director" next to the
      // sarah.chen@... mailto. We re-use synthName() with a hash of the
      // address as the seed so the same address always renders with
      // the same name/title — no flicker between renders.
      const local = row.address.split('@')[0] ?? row.address;
      const [first = '', last = ''] = local.split('.');
      const titleSeed = hashString(local);
      const { title } = synthName(titleSeed);
      return {
        id: row.id,
        email: row.address,
        name: capitalize(first) + (last ? ` ${capitalize(last)}` : ''),
        title,
      };
    });
  } catch (err) {
    logger.warn('auto_seeder_read_roster_failed', {
      seedLocationKey,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function hashString(s: string): number {
  // FNV-1a 32-bit hash. Stable across reloads, fast in V8, no deps.
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * Build the cohortTag for the current seed week: 'YYYYMMDD' of the
 * scheduled run start. Used as the address suffix on name collisions
 * and as a hint in agent_outputs so the operator can see what cohort
 * a given address came from.
 */
export function cohortTag(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}
