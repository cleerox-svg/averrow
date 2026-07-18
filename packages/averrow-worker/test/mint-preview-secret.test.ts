// S1 (Phase 1 PR-A) regression guards for the JWT-mint escalation fix.
//
// Two independent hardenings:
//   (a) The staff UI-preview mint is locked to the read-only `auditor`
//       role only — `analyst`/`admin` (both mutation-capable) can no
//       longer be minted, closing an internal-secret → mutation-capable
//       token path.
//   (b) The two mint endpoints authenticate on AVERROW_PREVIEW_SECRET, a
//       grant SEPARATE from AVERROW_INTERNAL_SECRET, and fail CLOSED when
//       it is unset — with NO fallback to the internal secret.
//
// Harness mirrors test/service-jwt-scope.test.ts (D1 stub + verifyJWT).

import { describe, it, expect } from "vitest";
import { handleMintUiPreviewJwt, UI_PREVIEW_STAFF_ROLES } from "../src/handlers/auth";
import { isPreviewMintAuthorized } from "../src/lib/preview-mint-auth";
import { verifyJWT } from "../src/lib/jwt";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Env } from "../src/types";

const SECRET = "test-secret-mint-preview";
const MAX_TTL_SECONDS = 240 * 60;

// handleMintUiPreviewJwt (surface=staff) touches:
//   1. INSERT OR IGNORE INTO users -> run()
//   2. SELECT status, role FROM users -> first() -> active analyst placeholder
//   3. (optional) UPDATE users SET role -> run()
//   4. membership SELECT -> first() -> null (no org)
// loadOrgScopeForToken(auditor) short-circuits (global read) with no DB.
function makeEnv(): Env {
  const db = {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async run() {
              return { success: true };
            },
            async first<T>() {
              if (sql.includes("SELECT status")) {
                return { status: "active", role: "analyst" } as unknown as T;
              }
              return null;
            },
          };
        },
      };
    },
  };
  return { JWT_SECRET: SECRET, DB: db } as unknown as Env;
}

function mintRequest(query: string): Request {
  return new Request(`https://averrow.com/api/internal/auth/mint-ui-preview-jwt?${query}`, {
    method: "POST",
    headers: { Origin: "https://averrow.com" },
  });
}

describe("S1(a) — staff preview role is auditor-only", () => {
  it("UI_PREVIEW_STAFF_ROLES is exactly ['auditor']", () => {
    expect(UI_PREVIEW_STAFF_ROLES).toEqual(["auditor"]);
  });

  it("rejects role=admin with 400", async () => {
    const res = await handleMintUiPreviewJwt(mintRequest("surface=staff&role=admin"), makeEnv());
    expect(res.status).toBe(400);
    const body = await res.json<{ success: boolean; error: string }>();
    expect(body.success).toBe(false);
    expect(body.error).toContain("auditor");
  });

  it("rejects role=analyst with 400 (analyst is mutation-capable)", async () => {
    const res = await handleMintUiPreviewJwt(mintRequest("surface=staff&role=analyst"), makeEnv());
    expect(res.status).toBe(400);
  });

  it("rejects role=super_admin with 400", async () => {
    const res = await handleMintUiPreviewJwt(mintRequest("surface=staff&role=super_admin"), makeEnv());
    expect(res.status).toBe(400);
  });

  it("mints role=auditor when explicitly requested", async () => {
    const res = await handleMintUiPreviewJwt(mintRequest("surface=staff&role=auditor"), makeEnv());
    expect(res.status).toBe(200);
    const body = await res.json<{ success: boolean; data: { jwt: string; role: string; ttl_seconds: number } }>();
    expect(body.data.role).toBe("auditor");
    const payload = await verifyJWT(body.data.jwt, SECRET);
    expect(payload?.role).toBe("auditor");
  });

  it("defaults to auditor (no role param) and NEVER carries admin/super_admin", async () => {
    const res = await handleMintUiPreviewJwt(mintRequest("surface=staff"), makeEnv());
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { jwt: string; role: string; ttl_seconds: number } }>();
    expect(body.data.role).toBe("auditor");

    const payload = await verifyJWT(body.data.jwt, SECRET);
    expect(payload).not.toBeNull();
    expect(payload?.role).toBe("auditor");
    expect(payload?.role).not.toBe("admin");
    expect(payload?.role).not.toBe("super_admin");
  });

  it("clamps the TTL to <= 240 minutes even when a larger TTL is requested", async () => {
    const res = await handleMintUiPreviewJwt(mintRequest("surface=staff&ttl_minutes=99999"), makeEnv());
    expect(res.status).toBe(200);
    const body = await res.json<{ data: { jwt: string; ttl_seconds: number } }>();
    expect(body.data.ttl_seconds).toBeLessThanOrEqual(MAX_TTL_SECONDS);

    const payload = await verifyJWT(body.data.jwt, SECRET);
    const ttl = (payload!.exp as number) - (payload!.iat as number);
    expect(ttl).toBeLessThanOrEqual(MAX_TTL_SECONDS);
  });
});

// ─── S1(b) — separated mint secret, fail-closed ───────────────────────
//
// isPreviewMintAuthorized is the exact gate both mint endpoints run in
// index.ts. It reads env.AVERROW_PREVIEW_SECRET only — never
// AVERROW_INTERNAL_SECRET.

const PREVIEW = "preview-secret-value-abc123";
const INTERNAL = "internal-secret-value-xyz789";

function envWith(opts: { preview?: string; internal?: string }): Env {
  return {
    AVERROW_PREVIEW_SECRET: opts.preview,
    AVERROW_INTERNAL_SECRET: opts.internal,
  } as unknown as Env;
}

function bearer(secret: string): Request {
  return new Request("https://averrow.com/api/internal/auth/mint-service-jwt", {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
  });
}

describe("S1(b) — mint endpoints authenticate on AVERROW_PREVIEW_SECRET", () => {
  it("accepts the correct AVERROW_PREVIEW_SECRET", () => {
    const env = envWith({ preview: PREVIEW, internal: INTERNAL });
    expect(isPreviewMintAuthorized(bearer(PREVIEW), env)).toBe(true);
  });

  it("REJECTS the old AVERROW_INTERNAL_SECRET (no fallback)", () => {
    const env = envWith({ preview: PREVIEW, internal: INTERNAL });
    expect(isPreviewMintAuthorized(bearer(INTERNAL), env)).toBe(false);
  });

  it("fails CLOSED when AVERROW_PREVIEW_SECRET is unset — even if internal secret is set and presented", () => {
    const env = envWith({ preview: undefined, internal: INTERNAL });
    // Presenting the internal secret must NOT authenticate.
    expect(isPreviewMintAuthorized(bearer(INTERNAL), env)).toBe(false);
    // Presenting anything else likewise fails.
    expect(isPreviewMintAuthorized(bearer("whatever"), env)).toBe(false);
  });

  it("fails CLOSED when AVERROW_PREVIEW_SECRET is empty string", () => {
    const env = envWith({ preview: "", internal: INTERNAL });
    expect(isPreviewMintAuthorized(bearer(""), env)).toBe(false);
    expect(isPreviewMintAuthorized(bearer(INTERNAL), env)).toBe(false);
  });

  it("rejects a missing Authorization header", () => {
    const env = envWith({ preview: PREVIEW });
    const req = new Request("https://averrow.com/api/internal/auth/mint-service-jwt", { method: "POST" });
    expect(isPreviewMintAuthorized(req, env)).toBe(false);
  });
});

// Source-pin: index.ts must wire BOTH mint endpoints through the preview
// gate, while the diagnostics/agent-trigger surface keeps the internal
// secret. Catches a revert of the endpoint wiring that the unit tests above
// (which exercise the helper directly) would not see.
describe("S1(b) — index.ts wiring pin", () => {
  const src = readFileSync(resolve(__dirname, "../src/index.ts"), "utf-8");

  it("both mint endpoints gate via isPreviewMintAuthorized", () => {
    const calls = src.match(/isPreviewMintAuthorized\(request, env\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("the internal secret still GATES non-mint routes via its runtime check (not just mentioned)", () => {
    // Prove the diagnostics/agent-trigger surface still authenticates with
    // the internal secret's ACTUAL runtime gate — the bearer comparison —
    // rather than a bare string match that a comment would satisfy.
    const bindings = src.match(
      /const internalSecret = [^;]*AVERROW_INTERNAL_SECRET[^;]*;/g,
    ) ?? [];
    const gates = src.match(/timingSafeBearerEq\(authHeader, internalSecret\)/g) ?? [];
    // Many non-mint internal routes wire this pair; require a real floor so a
    // wholesale rip-out of the internal-secret gate fails loudly.
    expect(bindings.length).toBeGreaterThanOrEqual(10);
    expect(gates.length).toBeGreaterThanOrEqual(10);
  });

  it("the two mint endpoints do NOT authenticate on the internal-secret bearer gate", () => {
    // The mint routes must be reachable ONLY through isPreviewMintAuthorized.
    // Confirm neither mint pathname sits adjacent to a timingSafeBearerEq(...,
    // internalSecret) internal-secret check (i.e. no fallback path snuck back).
    for (const mintPath of [
      "/api/internal/auth/mint-service-jwt",
      "/api/internal/auth/mint-ui-preview-jwt",
    ]) {
      const idx = src.indexOf(mintPath);
      expect(idx, `${mintPath} not found in index.ts`).toBeGreaterThan(-1);
      // Look at the route block that follows the pathname guard (bounded slice).
      const block = src.slice(idx, idx + 400);
      expect(block).toContain("isPreviewMintAuthorized(request, env)");
      expect(block).not.toContain("timingSafeBearerEq(authHeader, internalSecret)");
    }
  });
});
