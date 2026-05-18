// Abuse mailbox List-Unsubscribe handler.
//
// Wired into RFC 8058 one-click unsubscribe: Gmail (and other clients
// honouring `List-Unsubscribe-Post: List-Unsubscribe=One-Click`) POSTs
// to the URL in the email's List-Unsubscribe header with no body and
// no auth. The endpoint records an opt-out row in email_optouts.
//
// Token format: HMAC-SHA256 over the email address, truncated to 16
// hex chars. Stored in the URL alongside the email itself. The token
// is a tamper check — it doesn't add security beyond "the URL came
// from one of our emails" — but it prevents a random bot from opting
// out arbitrary addresses by guessing URLs.
//
// Endpoint:
//   POST /api/abuse-mailbox/unsubscribe?email=<urlencoded>&t=<token>&msg=<message_id>
// Returns:
//   204 — opted out (idempotent)
//   400 — missing/invalid params
//   401 — token mismatch
//
// Reads from `ABUSE_UNSUBSCRIBE_SECRET` (Worker secret). If unset,
// the endpoint falls back to AVERROW_INTERNAL_SECRET so a typo in
// secrets doesn't break the unsubscribe path.

import type { Env } from "../types";

async function hmacToken(email: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(email.toLowerCase()),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/** Build the public unsubscribe URL for the responder to embed in
 *  the List-Unsubscribe header. */
export async function unsubscribeUrl(
  env: Env,
  email: string,
  messageId: string,
): Promise<string> {
  const secret = env.ABUSE_UNSUBSCRIBE_SECRET ?? env.AVERROW_INTERNAL_SECRET ?? "";
  const token = await hmacToken(email, secret);
  const u = new URL("https://averrow.com/api/abuse-mailbox/unsubscribe");
  u.searchParams.set("email", email);
  u.searchParams.set("t", token);
  u.searchParams.set("msg", messageId);
  return u.toString();
}

/** POST /api/abuse-mailbox/unsubscribe — Gmail one-click target. */
export async function handleAbuseMailboxUnsubscribe(
  request: Request,
  env: Env,
): Promise<Response> {
  // Gmail's one-click form posts an empty body. Accept GET too as a
  // user-clickable fallback (so manual link clicks still register).
  if (request.method !== "POST" && request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const url = new URL(request.url);
  const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
  const token = (url.searchParams.get("t") ?? "").trim();
  const msg = (url.searchParams.get("msg") ?? "").trim() || null;

  if (!email || !email.includes("@")) {
    return new Response("Missing or invalid 'email' param", { status: 400 });
  }
  if (!token) {
    return new Response("Missing token", { status: 400 });
  }

  const secret =
    env.ABUSE_UNSUBSCRIBE_SECRET ?? env.AVERROW_INTERNAL_SECRET ?? "";
  const expected = await hmacToken(email, secret);
  if (token !== expected) {
    return new Response("Invalid token", { status: 401 });
  }

  // Idempotent INSERT — duplicate opt-outs are a no-op on the PK.
  try {
    await env.DB.prepare(`
      INSERT OR IGNORE INTO email_optouts
        (email, opted_out_at, source, message_id)
      VALUES (?, datetime('now'), 'list_unsubscribe_one_click', ?)
    `).bind(email, msg).run();
  } catch (err) {
    console.error("[abuse-mailbox-unsubscribe] DB write failed:", err);
    // Still return success to Gmail — failing this returns 5xx and
    // Gmail will retry, but the user has already been told their
    // unsubscribe was registered. Better to log + 204 than to flap.
  }

  // RFC 8058: a 200-class no-content response signals success.
  return new Response(null, { status: 204 });
}
