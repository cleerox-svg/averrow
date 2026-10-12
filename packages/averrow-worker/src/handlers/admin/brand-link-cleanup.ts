// POST /api/internal/brand-links/cleanup (AVERROW_INTERNAL_SECRET, via the
// blanket internal POST guard in index.ts) and POST
// /api/admin/brand-links/cleanup (super_admin). Shared request parsing.

import type { Env } from "../../types";
import {
  APPLY_CONFIRM_TOKEN,
  UNDO_CONFIRM_TOKEN,
  clampCursor,
  clampLimit,
  MAX_BRAND_FILTER,
  runBrandLinkCleanup,
  type CleanupMode,
  type CleanupScope,
} from "../../lib/brand-link-cleanup";

const MODES: readonly CleanupMode[] = ["dry_run", "apply", "undo", "reconcile"];
const SCOPES: readonly CleanupScope[] = ["all", "generic_brands"];
const RUN_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const BRAND_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

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
  // `scope` (dry_run/apply only): "all" (default) or the opt-in
  // "generic_brands" re-validation (lib/brand-link-cleanup.ts CleanupScope).
  if ((mode === "undo" || mode === "reconcile") && (url.searchParams.has("scope") || url.searchParams.has("brand"))) {
    // undo is per run_id; reconcile is global — a scope/brand filter there
    // would silently be ignored, so refuse it.
    return Response.json({ success: false, error: `scope/brand do not apply to mode=${mode}` }, { status: 400 });
  }
  const scopeParam = url.searchParams.get("scope") ?? "all";
  const scope = SCOPES.find((x) => x === scopeParam);
  if (!scope) {
    return Response.json({ success: false, error: `scope must be one of ${SCOPES.join(", ")}` }, { status: 400 });
  }
  // `brand` (scope=generic_brands only): comma-separated brand ids, so the
  // re-validation can run one generic brand at a time.
  const brandParam = url.searchParams.get("brand");
  let brandIds: string[] | undefined;
  if (brandParam !== null) {
    if (scope !== "generic_brands") {
      return Response.json({ success: false, error: "brand requires scope=generic_brands" }, { status: 400 });
    }
    brandIds = [...new Set(brandParam.split(",").map((b) => b.trim()).filter((b) => b.length > 0))];
    if (brandIds.length === 0 || brandIds.length > MAX_BRAND_FILTER || !brandIds.every((b) => BRAND_ID_RE.test(b))) {
      return Response.json({
        success: false,
        error: `brand must be 1-${MAX_BRAND_FILTER} comma-separated ids matching [A-Za-z0-9_.:-]{1,128}`,
      }, { status: 400 });
    }
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
      scope,
      brandIds,
    });
    return Response.json({ success: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}
