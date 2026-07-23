/**
 * Post-migration data verification.
 *
 * Wraps `wrangler d1 execute --remote` to assert that specific rows
 * exist in production D1 after `wrangler d1 migrations apply`. Catches
 * the failure mode that bit us with migrations 0180 + 0182: the
 * migration ran without errors (so wrangler recorded it as applied),
 * but INSERT OR IGNORE statements that depended on subqueries silently
 * no-op'd, leaving the table empty even though the migration history
 * says it's done.
 *
 * Add a new assertion here for every new migration that seeds data.
 * Run from CI in `.github/workflows/deploy-radar.yml` after the
 * migration step. Exits non-zero on any missing seed → CI fails loudly.
 *
 * Usage:
 *   tsx scripts/verify-db-seed.ts
 *
 * Env requirements (same as the migration step):
 *   CLOUDFLARE_API_TOKEN  — token with D1 + Workers scope
 *   CLOUDFLARE_ACCOUNT_ID — account id
 */

import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

interface Assertion {
  label: string;
  /** SQL that returns a single row with column `n` = count. */
  query: string;
  /** Expected minimum count. Most assertions are "n >= 1" presence checks. */
  min: number;
  /** Migration that should have produced these rows — for human-readable failures. */
  source: string;
}

const ASSERTIONS: Assertion[] = [
  {
    label: "Averrow self-org provisioned",
    query: "SELECT COUNT(*) AS n FROM organizations WHERE slug = '_averrow_platform'",
    min: 1,
    source: "0180_averrow_self_abuse_mailbox.sql",
  },
  {
    label: "Abuse-mailbox aliases seeded (all 12 expected from 0180 + 0182)",
    query: "SELECT COUNT(*) AS n FROM org_abuse_aliases WHERE org_id = (SELECT id FROM organizations WHERE slug = '_averrow_platform')",
    min: 12,
    source: "0180_averrow_self_abuse_mailbox.sql + 0182_averrow_ca_abuse_aliases.sql",
  },
  {
    label: "seed_domains has the four production domains",
    query: "SELECT COUNT(*) AS n FROM seed_domains WHERE status = 'active'",
    min: 4,
    source: "0181_seed_domains_config.sql",
  },
  {
    label: "threat_cube_arcs has rows (cube actively populated by Navigator + cube-healer)",
    query: "SELECT COUNT(*) AS n FROM threat_cube_arcs",
    min: 1,
    source: "0179_cube_arcs.sql + cron/navigator.ts (current+prev hour builds) + agents/cube-healer.ts (30-day rebuild)",
  },
  {
    label: "Feed-expansion Phase 1 feeds seeded (ipsum, phishing_database, scam_blocklist, epss)",
    query: "SELECT COUNT(*) AS n FROM feed_configs WHERE feed_name IN ('ipsum','phishing_database','scam_blocklist','epss')",
    min: 4,
    source: "0248_expand_feeds_phase1.sql",
  },
];

interface D1Row { n: number }
interface D1Result { results: D1Row[] }
interface WranglerOutput { 0?: D1Result; [k: number]: D1Result | undefined }

/** Runs a shell command and returns stdout. Injectable so the retry
 *  logic in {@link runQuery} can be unit-tested without a real wrangler
 *  / Cloudflare round-trip. */
export type ExecFn = (command: string) => string;

const defaultExec: ExecFn = (command) =>
  execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Default retry policy for transient wrangler/D1 flakes. */
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BACKOFF_MS = [1000, 2000];

/** Dependency-free synchronous sleep (no extra deps, no async plumbing
 *  into the top-level script). */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface RunQueryOptions {
  /** Command executor — defaults to a real `execSync` wrapper. */
  exec?: ExecFn;
  /** Sleep between retries — defaults to a real synchronous sleep. */
  sleep?: (ms: number) => void;
  /** Total attempts before giving up (>= 1). */
  maxAttempts?: number;
  /** Backoff schedule between attempts, in ms. */
  backoffMs?: number[];
}

/**
 * Parse a numeric count out of wrangler's `--json` output.
 * Returns `undefined` (rather than throwing) when the payload is
 * missing/non-numeric so the caller can treat it as a retryable
 * transient — an unparseable body is an infra hiccup, not a seed
 * problem.
 */
function parseCount(raw: string): number | undefined {
  let parsed: WranglerOutput | D1Result[];
  try {
    parsed = JSON.parse(raw) as WranglerOutput | D1Result[];
  } catch {
    return undefined;
  }
  // Wrangler's --json output: [{ results: [{ n: <count> }], ... }] OR object form
  const first = Array.isArray(parsed) ? parsed[0] : parsed[0];
  const rows = first?.results ?? [];
  const n = rows[0]?.n;
  return typeof n === "number" ? n : undefined;
}

/**
 * Run one assertion query against remote D1 and return its count.
 *
 * Retries ONLY on transient infrastructure failures — the exec call
 * throwing (non-zero wrangler exit) or returning unparseable/non-numeric
 * output. A query that SUCCEEDS but returns a low count (e.g. 0 when a
 * seed is expected) is returned as-is on the first attempt and is NEVER
 * retried: that is a genuine seed-missing failure and must surface
 * loudly to the caller, not be masked by a retry loop.
 */
export function runQuery(query: string, opts: RunQueryOptions = {}): number {
  const exec = opts.exec ?? defaultExec;
  const sleep = opts.sleep ?? sleepSync;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;

  const escaped = query.replace(/"/g, '\\"');
  const command = `wrangler d1 execute trust-radar-v2 --remote --command "${escaped}" --json`;

  let lastError: Error = new Error("runQuery: no attempts made");
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let raw: string;
    try {
      raw = exec(command);
    } catch (err) {
      // Transient: wrangler exited non-zero (network blip, D1 5xx, etc.).
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxAttempts) {
        console.error(`    ↻ transient exec failure (attempt ${attempt}/${maxAttempts}): ${lastError.message.split("\n")[0]}`);
        sleep(backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1] ?? 0);
        continue;
      }
      throw lastError;
    }

    const n = parseCount(raw);
    if (typeof n === "number") {
      // Success — return the count verbatim, INCLUDING low/zero counts.
      // Threshold enforcement lives in main(); we must not retry a real
      // seed-missing result or we'd hide a genuine data problem.
      return n;
    }

    // Exec succeeded but produced unparseable/non-numeric output — treat
    // as a transient (partial write, truncated pipe) and retry.
    lastError = new Error(`Query did not return a numeric count: ${raw.slice(0, 200)}`);
    if (attempt < maxAttempts) {
      console.error(`    ↻ unparseable output (attempt ${attempt}/${maxAttempts})`);
      sleep(backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1] ?? 0);
      continue;
    }
    throw lastError;
  }
  // Unreachable — the loop either returns or throws.
  throw lastError;
}

export function main(): void {
  let failed = 0;
  console.log("─── DB seed verification ───");
  for (const a of ASSERTIONS) {
    try {
      const got = runQuery(a.query);
      if (got >= a.min) {
        console.log(`  ✓ ${a.label} (n=${got})`);
      } else {
        console.error(`  ✗ ${a.label}`);
        console.error(`    expected n >= ${a.min}, got ${got}`);
        console.error(`    source: ${a.source}`);
        console.error(`    query:  ${a.query}`);
        failed += 1;
      }
    } catch (err) {
      console.error(`  ✗ ${a.label} (query failed)`);
      console.error(`    error: ${err instanceof Error ? err.message : String(err)}`);
      console.error(`    source: ${a.source}`);
      failed += 1;
    }
  }

  if (failed > 0) {
    console.error(`\n::error::${failed} of ${ASSERTIONS.length} seed assertions failed`);
    console.error("Likely cause: wrangler reported migration applied but INSERT OR IGNORE inside the migration silently no-op'd. Repair via D1 Console with the missing-rows SQL, or revert the migration's d1_migrations row and re-apply.");
    process.exit(1);
  }
  console.log(`\n  All ${ASSERTIONS.length} seed assertions passed.`);
}

// Run only when invoked directly (tsx scripts/verify-db-seed.ts), not when
// imported by a test — importing must not fire real wrangler commands.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
