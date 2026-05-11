#!/usr/bin/env node
/**
 * Overlay-copy Astro's dist/ into the trust-radar Worker's public/
 * directory. Runs after `astro build` (see package.json scripts).
 *
 * Why this exists: writing Astro's outDir directly into public/
 * causes Astro's outDir cleanup to wipe legacy SPA assets that
 * share the directory (app.js, dashboard.html, public/v2, etc.).
 * Going through dist/ + post-build copy lets us overlay without
 * destroying anything.
 *
 * Behaviour:
 *  - Copies every file in dist/ into public/ at the matching path
 *  - Creates intermediate directories as needed
 *  - Overwrites existing files (Astro is authoritative for any
 *    path it generated)
 *  - Does NOT delete files in public/ that Astro didn't generate
 */
import { cp, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const SRC = join(ROOT, "dist");
const DEST = resolve(ROOT, "..", "trust-radar", "public");

async function main() {
  if (!existsSync(SRC)) {
    console.error(`[sync-to-worker] No dist/ found at ${SRC}. Did astro build run?`);
    process.exit(1);
  }

  const srcStat = await stat(SRC);
  if (!srcStat.isDirectory()) {
    console.error(`[sync-to-worker] ${SRC} is not a directory.`);
    process.exit(1);
  }

  await mkdir(DEST, { recursive: true });

  // cp with recursive + force gives us the overlay behaviour. Node 22
  // is the project minimum, so cp({recursive:true}) is safe to use.
  await cp(SRC, DEST, {
    recursive: true,
    force: true,
    errorOnExist: false,
  });

  console.log(`[sync-to-worker] Overlayed ${SRC} -> ${DEST}`);
}

main().catch(err => {
  console.error("[sync-to-worker] Failed:", err);
  process.exit(1);
});
