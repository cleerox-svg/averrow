// TODO: Refactor to use handler-utils (Phase 6 continuation)
/**
 * Contact form submission handler.
 * POST /api/contact
 *
 * Anti-spam (added 2026-08): a hidden honeypot field (`company_website`)
 * that real users never see or fill, plus a per-IP KV rate limit. The
 * marketing contact/demo/abuse-mailbox forms all POST here.
 *
 * After the row is stored, staff are emailed (lib/contact-notify.ts, G33);
 * the outcome lands in `notified_at` / `notify_status`. The email is
 * best-effort: a send failure never fails the submission.
 *
 * The sender's IP is used only for the KV rate-limit key and is never
 * stored (`ip_address` is written NULL — G38, privacy policy).
 */
import { json } from "../lib/cors";
import { logger } from "../lib/logger";
import { normalizePublicHostname } from "../lib/public-hostname";
import { notifyContactSubmission } from "../lib/contact-notify";
import type { Env } from "../types";

interface ContactBody {
  name?: string;
  email?: string;
  company?: string;
  companySize?: string;
  interest?: string;
  message?: string;
  // Optional company domain (the demo form sends it). Validated with
  // normalizePublicHostname; an invalid value is a 400.
  domain?: unknown;
  // Honeypot — rendered off-screen + aria-hidden in the forms, so a real
  // user never populates it. A non-empty value ⇒ a bot filled the hidden
  // field.
  company_website?: string;
}

// Per-IP submission cap over a rolling 1-hour window. The endpoint is
// public + unauthenticated, so this is the volume backstop behind the
// honeypot. Matches the `pub_*` KV pattern used by the other public
// endpoints (handlers/public.ts).
const CONTACT_RATE_LIMIT = 5;
const CONTACT_RATE_WINDOW_SECONDS = 3600;

export async function handleContactSubmission(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  try {
    const body = (await request.json()) as ContactBody;
    const name = body.name?.trim();
    const email = body.email?.trim();
    const message = body.message?.trim();

    // Honeypot: silently accept without persisting. Returning success (not
    // an error) keeps the bot from detecting the trap and adapting.
    if (body.company_website && body.company_website.trim().length > 0) {
      return json({ success: true, data: { id: crypto.randomUUID() } }, 200, origin);
    }

    if (!name || !email || !message) {
      return json(
        { success: false, error: "Name, email, and message are required." },
        400,
        origin,
      );
    }

    // Basic email validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json(
        { success: false, error: "Please provide a valid email address." },
        400,
        origin,
      );
    }

    let domain: string | null = null;
    if (body.domain !== undefined && body.domain !== null && body.domain !== "") {
      domain = normalizePublicHostname(body.domain, { stripWww: true });
      if (!domain) {
        return json(
          { success: false, error: "Please enter a valid domain (e.g. example.com)." },
          400,
          origin,
        );
      }
    }

    // Used only for the rate-limit key below; never persisted (G38).
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";

    // Per-IP rate limit — check before the insert so a flood of otherwise
    // valid submissions from one source can't fill the table.
    const rateKey = `pub_contact_${ip}`;
    const currentCount = parseInt((await env.CACHE.get(rateKey)) || "0", 10);
    if (currentCount >= CONTACT_RATE_LIMIT) {
      return json(
        {
          success: false,
          error: "Too many submissions from this network. Please try again later.",
        },
        429,
        origin,
      );
    }

    const id = crypto.randomUUID();
    const company = body.company?.trim() || null;
    const companySize = body.companySize?.trim() || null;
    const interest = body.interest?.trim() || null;

    // ip_address is bound as NULL: the column stays for compatibility but
    // the IP is not stored.
    await env.DB.prepare(
      `INSERT INTO contact_submissions (id, name, email, company, company_size, interest, message, domain, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
      .bind(id, name, email, company, companySize, interest, message, domain)
      .run();

    // Only count successful, persisted submissions toward the limit.
    await env.CACHE.put(rateKey, String(currentCount + 1), {
      expirationTtl: CONTACT_RATE_WINDOW_SECONDS,
    });

    // Best effort from here on: the row is committed and the visitor gets
    // success whatever happens to the email or the status stamp.
    try {
      const status = await notifyContactSubmission(env, {
        id, name, email, company, companySize, interest, domain, message,
      });
      await env.DB.prepare(
        `UPDATE contact_submissions
            SET notify_status = ?,
                notified_at = CASE WHEN ? = 'sent' THEN datetime('now') ELSE NULL END
          WHERE id = ?`,
      )
        .bind(status, status, id)
        .run();
    } catch (err) {
      logger.warn("contact-notify-stamp-failed", {
        submissionId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return json({ success: true, data: { id } }, 200, origin);
  } catch (err) {
    console.error("[contact] Error:", err);
    return json(
      { success: false, error: "Failed to submit. Please try again." },
      500,
      origin,
    );
  }
}
