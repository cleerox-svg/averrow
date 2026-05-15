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
];

interface D1Row { n: number }
interface D1Result { results: D1Row[] }
interface WranglerOutput { 0?: D1Result; [k: number]: D1Result | undefined }

function runQuery(query: string): number {
  const escaped = query.replace(/"/g, '\\"');
  const raw = execSync(
    `wrangler d1 execute trust-radar-v2 --remote --command "${escaped}" --json`,
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  // Wrangler's --json output: [{ results: [{ n: <count> }], ... }] OR object form
  const parsed = JSON.parse(raw) as WranglerOutput | D1Result[];
  const first = Array.isArray(parsed) ? parsed[0] : parsed[0];
  const rows = first?.results ?? [];
  const n = rows[0]?.n;
  if (typeof n !== "number") {
    throw new Error(`Query did not return a numeric count: ${raw.slice(0, 200)}`);
  }
  return n;
}

function main(): void {
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

main();
