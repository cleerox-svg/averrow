/**
 * ARCHITECT — repository inventory collector (Worker runtime).
 *
 * Cloudflare Workers have no filesystem, so a live walk is impossible at
 * request time. Instead we ship a build-time generated manifest —
 * scripts/build-architect-manifest.ts runs as part of the averrow-worker
 * build step, walks the monorepo with the Node fs walker in
 * ./repo-fs.ts, and writes ../manifest.generated.ts. That file is
 * committed to git so every deploy carries a deterministic inventory.
 *
 * The HTTP route / Worker `runCollect()` call path imports this module
 * and gets the baked-in snapshot. The CLI (local verification) still
 * uses the live fs walker in ./repo-fs.ts so operators can regenerate a
 * bundle against their working tree without a full build first.
 */

import { REPO_MANIFEST } from "../manifest.generated";
import type { RepoInventory } from "../types";

export function collectRepoInventory(): RepoInventory {
  // Returning the imported constant by reference is fine — downstream
  // consumers treat it as read-only and JSON.stringify the full bundle
  // before handing it to R2.
  return REPO_MANIFEST;
}
