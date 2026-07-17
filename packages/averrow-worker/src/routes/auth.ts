import { Router } from "itty-router";
import type { RouterType, IRequest } from "itty-router";
import type { Env } from "../types";
import { requireAuth, requireAuthAllowEnroll, isAuthContext } from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import {
  handleOAuthLogin, handleOAuthInviteLogin, handleOAuthCallback,
  handleRefreshToken, handleLogout, handleMe,
  handleMagicLinkRequest, handleMagicLinkVerify,
} from "../handlers/auth";
import {
  handlePasskeyRegisterBegin, handlePasskeyRegisterFinish,
  handlePasskeyAuthBegin, handlePasskeyAuthFinish,
  handleListPasskeys, handleDeletePasskey,
} from "../handlers/passkeys";
import { handleGetProfile, handleUpdateProfile } from "../handlers/profile";
import { handleValidateInvite } from "../handlers/invites";
import { handleInviteLanding } from "../handlers/invite-landing";

export function registerAuthRoutes(router: RouterType<IRequest>): void {
  // Invite landing page (public — renders accept UI before OAuth redirect)
  router.get("/invite", async (request: Request, env: Env) => {
    return handleInviteLanding(request, env);
  });

  router.get("/api/auth/login", async (request: Request, env: Env) => {
    const limited = await rateLimit(request, env, "auth");
    if (limited) return limited;
    return handleOAuthLogin(request, env);
  });

  router.get("/api/auth/invite", async (request: Request, env: Env) => {
    const limited = await rateLimit(request, env, "auth");
    if (limited) return limited;
    return handleOAuthInviteLogin(request, env);
  });

  router.get("/api/auth/callback", async (request: Request, env: Env) => {
    const limited = await rateLimit(request, env, "auth");
    if (limited) return limited;
    return handleOAuthCallback(request, env);
  });

  router.post("/api/auth/refresh", async (request: Request, env: Env) => {
    const limited = await rateLimit(request, env, "auth");
    if (limited) return limited;
    return handleRefreshToken(request, env);
  });

  // Logout must work for enrollment-scoped sessions too — let a privileged
  // user bail out of the passkey-setup gate (H-3).
  router.post("/api/auth/logout", async (request: Request, env: Env) => {
    const ctx = await requireAuthAllowEnroll(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleLogout(request, env, ctx.userId);
  });

  // /me must remain reachable by enrollment-scoped sessions so the SPA can
  // render the mandatory passkey-setup gate (H-3). It echoes
  // `passkey_required` from ctx.enrollOnly.
  router.get("/api/auth/me", async (request: Request, env: Env) => {
    const ctx = await requireAuthAllowEnroll(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleMe(request, env, ctx.userId, ctx.enrollOnly);
  });

  // ─── /api/profile (user-editable surface) ──────────────────────
  // GET returns the editable profile (display_name, timezone,
  // theme_preference). PATCH updates a partial set; pass null to
  // clear a field back to its default. Distinct from /api/auth/me
  // which is the read-only session bootstrap.
  router.get("/api/profile", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleGetProfile(request, env, ctx.userId);
  });
  router.patch("/api/profile", async (request: Request, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleUpdateProfile(request, env, ctx.userId);
  });

  // ─── Magic-link sign-in (public — no auth required) ─────────────
  // POST /api/auth/magic-link/request — body: { email, return_to? }
  // GET  /api/auth/magic-link/:token  — clicked from the email body;
  //   on success, mints a session and 302s to the SPA exactly like the
  //   OAuth callback does, so the React shell hydrates the session
  //   without any new client-side code path.
  router.post("/api/auth/magic-link/request", async (request: Request, env: Env) => {
    const limited = await rateLimit(request, env, "auth");
    if (limited) return limited;
    return handleMagicLinkRequest(request, env);
  });

  router.get("/api/auth/magic-link/:token", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const limited = await rateLimit(request, env, "auth");
    if (limited) return limited;
    return handleMagicLinkVerify(request, env, request.params["token"] ?? "");
  });

  // ─── Passkeys (WebAuthn) ────────────────────────────────────────
  // Registration is auth-required (passkey is added to a signed-in user).
  // Authentication is public (it produces a fresh session).
  // Passkey registration is the bootstrap path out of an enrollment-scoped
  // session, so it must accept those tokens (H-3).
  router.post("/api/passkeys/register/begin", async (request: Request, env: Env) => {
    const ctx = await requireAuthAllowEnroll(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handlePasskeyRegisterBegin(request, env, ctx.userId);
  });
  router.post("/api/passkeys/register/finish", async (request: Request, env: Env) => {
    const ctx = await requireAuthAllowEnroll(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handlePasskeyRegisterFinish(request, env, ctx.userId);
  });
  router.post("/api/passkeys/auth/begin", async (request: Request, env: Env) => {
    const limited = await rateLimit(request, env, "auth");
    if (limited) return limited;
    return handlePasskeyAuthBegin(request, env);
  });
  router.post("/api/passkeys/auth/finish", async (request: Request, env: Env) => {
    const limited = await rateLimit(request, env, "auth");
    if (limited) return limited;
    return handlePasskeyAuthFinish(request, env);
  });
  // Listing passkeys stays reachable in enrollment scope so the setup gate
  // can show any already-registered devices (H-3).
  router.get("/api/passkeys", async (request: Request, env: Env) => {
    const ctx = await requireAuthAllowEnroll(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleListPasskeys(request, env, ctx.userId);
  });
  router.delete("/api/passkeys/:id", async (request: Request & { params: Record<string, string> }, env: Env) => {
    const ctx = await requireAuth(request, env);
    if (!isAuthContext(ctx)) return ctx;
    return handleDeletePasskey(request, env, request.params["id"] ?? "", ctx.userId);
  });

  // Invite token validation (public — no auth required)
  router.get("/api/invites/:token", async (request: Request & { params: Record<string, string> }, env: Env) => {
    return handleValidateInvite(request, env, request.params["token"] ?? "");
  });
}
