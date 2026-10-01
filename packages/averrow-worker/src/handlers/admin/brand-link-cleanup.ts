// POST /api/internal/brand-links/cleanup (AVERROW_INTERNAL_SECRET, via the
// blanket internal POST guard in index.ts) and POST
// /api/admin/brand-links/cleanup (super_admin). Shared request parsing.

import type { Env } from "../../types";
import {
  APPLY_CONFIRM_TOKEN,
  clampLimit,
  runBrandLinkCleanup,
  type CleanupMode,
} from "../../lib/brand-link-cleanup";

export async function handleBrandLinkCleanup(url: URL, env: Env): Promise<Response> {
  const modeParam = url.searchParams.get("mode") ?? "dry_run";
  if (modeParam !== "dry_run" && modeParam !== "apply") {
    return Response.json({ success: false, error: "mode must be dry_run or apply" }, { status: 400 });
  }
  const mode: CleanupMode = modeParam;
  if (mode === "apply" && url.searchParams.get("confirm") !== APPLY_CONFIRM_TOKEN) {
    return Response.json(
      { success: false, error: `apply requires confirm=${APPLY_CONFIRM_TOKEN}` },
      { status: 400 },
    );
  }
  const cursorRaw = Number(url.searchParams.get("cursor") ?? "0");
  const cursor = Number.isFinite(cursorRaw) && cursorRaw > 0 ? Math.floor(cursorRaw) : 0;
  const limit = clampLimit(url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined);

  try {
    const data = await runBrandLinkCleanup(env, { mode, cursor, limit });
    return Response.json({ success: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}
