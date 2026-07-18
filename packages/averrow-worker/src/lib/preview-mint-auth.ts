// Averrow — preview/service JWT-mint authorization (S1, Phase 1 PR-A)
//
// The two JWT-minting internal endpoints — `mint-service-jwt` and
// `mint-ui-preview-jwt` — authenticate on AVERROW_PREVIEW_SECRET, a grant
// deliberately SEPARATE from AVERROW_INTERNAL_SECRET (which still gates the
// diagnostics-read + agent-trigger surface). Splitting the secret means the
// ability to MINT a JWT is no longer implied by holding the internal secret.
//
// Fails CLOSED: `timingSafeBearerEq` returns false whenever the secret is
// unset/empty, so an unprovisioned AVERROW_PREVIEW_SECRET rejects every
// caller. There is NO fallback to AVERROW_INTERNAL_SECRET — a silent
// fallback would defeat the split.

import { timingSafeBearerEq } from "./internal-secret";
import type { Env } from "../types";

/**
 * Constant-time check that the request carries `Authorization: Bearer
 * <AVERROW_PREVIEW_SECRET>`. Returns false (→ 401 at the call site) when
 * the header is missing/malformed, the secret doesn't match, or
 * AVERROW_PREVIEW_SECRET is unset/empty. Never consults
 * AVERROW_INTERNAL_SECRET.
 */
export function isPreviewMintAuthorized(request: Request, env: Env): boolean {
  const authHeader = request.headers.get("Authorization");
  return timingSafeBearerEq(authHeader, env.AVERROW_PREVIEW_SECRET);
}
