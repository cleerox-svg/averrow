// POST /api/internal/brand-links/cleanup (AVERROW_INTERNAL_SECRET, via the
// blanket internal POST guard in index.ts) and POST
// /api/admin/brand-links/cleanup (super_admin). Shared request parsing.

import type { Env } from "../../types";
import {
  APPLY_CONFIRM_TOKEN,
  UNDO_CONFIRM_TOKEN,
  clampCursor,
  clampLimit,
  runBrandLinkCleanup,
  type CleanupMode,
} from "../../lib/brand-link-cleanup";

const MODES: readonly CleanupMode[] = ["dry_run", "apply", "undo", "reconcile"];
const RUN_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * @param actor "internal" for the internal-secret route, "user:<id>" for
 *              the super_admin route — recorded in the log + audit trail.
 */
export async function handleBrandLinkCleanup(url: URL, env: Env, actor: string): Promise<Response> {
  const modeParam = url.searchParams.get("mode") ?? "dry_run";
  const mode = MODES.find((m) => m === modeParam);
  if (!mode) {
    return Response.json({ success: false, error: `mode must be one of ${MODES.join(", ")}` }, { status: 400 });
  }
  const token = mode === "apply" ? APPLY_CONFIRM_TOKEN : mode === "undo" ? UNDO_CONFIRM_TOKEN : null;
  if (token && url.searchParams.get("confirm") !== token) {
    return Response.json({ success: false, error: `${mode} requires the confirm parameter` }, { status: 400 });
  }
  const runId = url.searchParams.get("run_id") ?? "manual";
  if (!RUN_ID_RE.test(runId)) {
    return Response.json({ success: false, error: "run_id must match [A-Za-z0-9_.:-]{1,64}" }, { status: 400 });
  }

  try {
    const data = await runBrandLinkCleanup(env, {
      mode,
      cursor: clampCursor(Number(url.searchParams.get("cursor") ?? "0")),
      limit: clampLimit(url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined),
      runId,
      actor,
    });
    return Response.json({ success: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}
