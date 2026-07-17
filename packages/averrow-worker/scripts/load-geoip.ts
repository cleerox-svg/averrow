#!/usr/bin/env tsx
/**
 * load-geoip.ts — operator CLI to download, unzip, and stage the
 * GeoLite2-City CSVs in R2 so the GeoipRefreshWorkflow can import
 * them.
 *
 * Manual one-time run before each refresh (until Phase 3.5
 * automates the download half):
 *
 *   export MAXMIND_LICENSE_KEY=...
 *   pnpm load-geoip
 *
 * The script:
 *   1. Downloads GeoLite2-City-CSV.zip from MaxMind (~80MB)
 *   2. Unzips in /tmp
 *   3. Uploads the two CSVs to R2 via `wrangler r2 object put`
 *   4. Triggers the workflow via /api/admin/geoip-refresh
 *
 * Why a CLI rather than a Workflow step: the unzip step needs the
 * full ~80MB ZIP central directory in memory (ZIPs are appended
 * file format; you can't stream-parse the directory). 80MB +
 * Worker overhead bumps against the 128MB Worker memory budget.
 * Running locally is the pragmatic answer until we either
 * pre-process the ZIP into per-file objects or move to a fetch +
 * R2 multipart-upload pattern.
 *
 * No npm deps beyond what's already in the repo. Uses node's
 * built-in fetch + stream APIs + the system `unzip` binary
 * (ubiquitous on macOS, Linux, and WSL).
 */

import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAXMIND_BASE = 'https://download.maxmind.com/app/geoip_download';
const EDITION = 'GeoLite2-City-CSV';
const STAGING_BUCKET = 'geoip-staging';
const LOCATIONS_FILENAME = 'GeoLite2-City-Locations-en.csv';
const BLOCKS_FILENAME = 'GeoLite2-City-Blocks-IPv4.csv';

function die(msg: string, code = 1): never {
  console.error(`[load-geoip] FATAL: ${msg}`);
  process.exit(code);
}

function info(msg: string): void {
  console.log(`[load-geoip] ${msg}`);
}

async function main(): Promise<void> {
  const licenseKey = process.env['MAXMIND_LICENSE_KEY'];
  if (!licenseKey) {
    die(
      'MAXMIND_LICENSE_KEY env var is not set. Generate one at ' +
      'https://www.maxmind.com/en/accounts/current/license-key.',
    );
  }

  // Sanity-check that wrangler is on PATH; we shell out to it for R2.
  try {
    execSync('wrangler --version', { stdio: 'pipe' });
  } catch {
    die('`wrangler` CLI not found on PATH. Install via `pnpm i -g wrangler` or run from the repo root with `pnpm exec`.');
  }

  // Step 1: download the ZIP.
  const url = `${MAXMIND_BASE}?edition_id=${EDITION}&license_key=${encodeURIComponent(licenseKey)}&suffix=zip`;
  info(`Downloading ${EDITION}.zip from MaxMind...`);
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    die(
      `MaxMind responded ${res.status}: ${body.slice(0, 300)}. ` +
      `If status=401, the license key was rejected. If 403, the ` +
      `account isn't entitled to ${EDITION}.`,
    );
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  info(`Downloaded ${(buffer.length / 1024 / 1024).toFixed(1)}MB.`);

  // Step 2: unzip into a temp dir.
  const workDir = mkdtempSync(join(tmpdir(), 'load-geoip-'));
  const zipPath = join(workDir, 'archive.zip');
  writeFileSync(zipPath, buffer);
  info(`Wrote ZIP to ${zipPath}, unzipping...`);

  try {
    execSync(`unzip -o "${zipPath}" -d "${workDir}"`, { stdio: 'inherit' });
  } catch {
    die('`unzip` failed. Verify the system unzip is installed.');
  }

  // MaxMind ZIP contents nest under `GeoLite2-City-CSV_YYYYMMDD/`.
  // Resolve the dated subdirectory by globbing.
  let datedSubdir: string | null = null;
  for (const entry of execSync(`ls "${workDir}"`, { encoding: 'utf-8' }).split('\n')) {
    if (entry.startsWith('GeoLite2-City-CSV_')) {
      datedSubdir = join(workDir, entry);
      break;
    }
  }
  if (!datedSubdir) die(`Could not locate GeoLite2-City-CSV_YYYYMMDD subdir under ${workDir}.`);

  const locationsPath = join(datedSubdir, LOCATIONS_FILENAME);
  const blocksPath = join(datedSubdir, BLOCKS_FILENAME);
  if (!existsSync(locationsPath)) die(`Missing ${LOCATIONS_FILENAME} in archive.`);
  if (!existsSync(blocksPath)) die(`Missing ${BLOCKS_FILENAME} in archive.`);

  const locationsSize = readFileSync(locationsPath).length;
  const blocksSize = readFileSync(blocksPath).length;
  info(`Locations: ${(locationsSize / 1024 / 1024).toFixed(1)}MB`);
  info(`Blocks:    ${(blocksSize / 1024 / 1024).toFixed(1)}MB`);

  // Step 3: upload to R2 via wrangler.
  info(`Uploading ${LOCATIONS_FILENAME} to R2 bucket "${STAGING_BUCKET}"...`);
  execSync(
    `wrangler r2 object put ${STAGING_BUCKET}/${LOCATIONS_FILENAME} --file="${locationsPath}" --remote`,
    { stdio: 'inherit' },
  );

  info(`Uploading ${BLOCKS_FILENAME} to R2 bucket "${STAGING_BUCKET}"...`);
  execSync(
    `wrangler r2 object put ${STAGING_BUCKET}/${BLOCKS_FILENAME} --file="${blocksPath}" --remote`,
    { stdio: 'inherit' },
  );

  // Step 4: cleanup local temp.
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    info(`(Could not clean ${workDir} — manual rm -rf recommended.)`);
  }

  info('');
  info('Staging complete. Trigger the import workflow:');
  info('');
  info('  curl -X POST https://averrow.com/api/admin/geoip-refresh \\');
  info('    -H "Authorization: Bearer <admin-token>"');
  info('');
  info('Then watch progress:');
  info('  curl https://averrow.com/api/admin/geoip-status \\');
  info('    -H "Authorization: Bearer <admin-token>"');
}

main().catch((err) => {
  die(err instanceof Error ? err.message : String(err));
});
