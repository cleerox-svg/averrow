/**
 * Invite Landing Page Handler — renders the invite acceptance page.
 * GET /invite?token=<rawToken>
 *
 * Validates the token, looks up the invitation details, and renders
 * a branded page with a "Sign in with Google" button that kicks off
 * the OAuth invite flow at /api/auth/invite?token=...
 */

import { hashToken } from "../lib/hash";
import { renderInviteAcceptPage, renderInviteErrorPage } from "../templates/invite-accept";
import type { Env } from "../types";

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function handleInviteLanding(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const rawToken = url.searchParams.get("token");

  if (!rawToken) {
    return htmlResponse(renderInviteErrorPage("No invitation token provided. Please check the link in your email."), 400);
  }

  const tokenHash = await hashToken(rawToken);

  const invite = await env.DB.prepare(
    `SELECT i.id, i.email, i.role, i.status, i.expires_at, i.org_id, i.org_role,
            o.name AS org_name
     FROM invitations i
     LEFT JOIN organizations o ON o.id = i.org_id
     WHERE i.token_hash = ?`,
  ).bind(tokenHash).first<{
    id: string; email: string; role: string; status: string;
    expires_at: string; org_id: number | null; org_role: string | null;
    org_name: string | null;
  }>();

  if (!invite) {
    return htmlResponse(renderInviteErrorPage("This invitation link is invalid. Please ask your administrator to send a new invitation."), 404);
  }

  if (invite.status === "accepted") {
    return htmlResponse(renderInviteErrorPage("This invitation has already been accepted. You can log in to your account."), 410);
  }

  if (invite.status === "revoked") {
    return htmlResponse(renderInviteErrorPage("This invitation has been revoked and is no longer valid."), 410);
  }

  if (invite.status === "expired" || new Date(invite.expires_at) < new Date()) {
    if (invite.status !== "expired") {
      await env.DB.prepare("UPDATE invitations SET status = 'expired' WHERE id = ?").bind(invite.id).run();
    }
    return htmlResponse(renderInviteErrorPage("This invitation has expired. Please ask your administrator to send a new invitation."), 410);
  }

  // Build the OAuth invite URL
  const authUrl = `${url.origin}/api/auth/invite?token=${encodeURIComponent(rawToken)}`;

  return htmlResponse(renderInviteAcceptPage({
    email: invite.email,
    role: invite.org_role ?? invite.role,
    orgName: invite.org_name ?? undefined,
    authUrl,
    expiresAt: invite.expires_at,
  }));
}
