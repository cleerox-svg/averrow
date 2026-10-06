// TODO: Refactor to use handler-utils (Phase 6 continuation)
/**
 * Contact form submission handler.
 * POST /api/contact
 *
 * Anti-spam (added 2026-08): a hidden honeypot field (`company_website`)
 * that real users never see or fill, plus a per-IP rate limit. The
 * marketing contact/demo/abuse-mailbox forms all POST here.
 *
 * The per-IP limit is an atomic D1 counter (contact_rate, lib/contact-rate.ts)
 * in fixed 1-hour windows, keyed on an HMAC of the IP (IPv6: its /64) — the
 * IP itself is never stored (`ip_address` is written NULL — G38, privacy
 * policy).
 *
 * After the row is stored, staff are emailed (lib/contact-notify.ts, G33);
 * the outcome lands in `notified_at` / `notify_status`. The email is
 * best-effort: a send failure never fails the submission.
 */
import { json } from "../lib/cors";
import { logger } from "../lib/logger";
import { normalizePublicHostname } from "../lib/public-hostname";
import { notifyContactSubmission } from "../lib/contact-notify";
import { contactIpRateKey, incrementContactRate, refundContactRate } from "../lib/contact-rate";
import type { Env } from "../types";

// Per-IP submission cap over a fixed 1-hour window. The endpoint is
// public + unauthenticated, so this is the volume backstop behind the
// honeypot.
export const CONTACT_RATE_LIMIT = 5;
export const CONTACT_RATE_WINDOW_SECONDS = 3600;

// Length limits. `message` keeps no limit (the email truncates it; the row
// keeps the whole text).
const NAME_MAX = 200;
const EMAIL_MAX = 254;
const OPTIONAL_FIELD_MAX = 200;

const OPTIONAL_FIELDS = ["company", "companySize", "interest"] as const;
type OptionalField = (typeof OPTIONAL_FIELDS)[number];

/**
 * One mailbox: a local part of permitted atom characters (RFC 5322 atext plus
 * dots, no leading/trailing/double dot) and a dotted domain. Rejects
 * whitespace, quotes, angle brackets, commas and colons, so a scheme-like
 * value such as `javascript:alert(1)@x.com` is refused.
 */
const EMAIL_RE =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

export function isValidContactEmail(email: string): boolean {
  return email.length <= EMAIL_MAX && EMAIL_RE.test(email);
}

const bad = (error: string, origin: string | null) =>
  json({ success: false, error }, 400, origin);

/** undefined/null → absent; a string → trimmed; anything else → invalid. */
function optionalString(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false };
  const t = v.trim();
  return { ok: true, value: t.length > 0 ? t : null };
}

export async function handleContactSubmission(
  request: Request,
  env: Env,
): Promise<Response> {
  const origin = request.headers.get("Origin");

  try {
    const raw: unknown = await request.json().catch(() => null);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return bad("Invalid request body.", origin);
    }
    const body = raw as Record<string, unknown>;

    // Honeypot: silently accept without persisting. Returning success (not
    // an error) keeps the bot from detecting the trap and adapting. Any
    // non-empty value (string or not) counts as filled.
    const trap = body.company_website;
    if (trap !== undefined && trap !== null && (typeof trap !== "string" || trap.trim().length > 0)) {
      return json({ success: true, data: { id: crypto.randomUUID() } }, 200, origin);
    }

    const nameF = optionalString(body.name);
    const emailF = optionalString(body.email);
    const messageF = optionalString(body.message);
    if (!nameF.ok || !emailF.ok || !messageF.ok) {
      return bad("Name, email, and message must be text.", origin);
    }
    const name = nameF.value;
    const email = emailF.value;
    const message = messageF.value;
    if (!name || !email || !message) {
      return bad("Name, email, and message are required.", origin);
    }
    if (name.length > NAME_MAX) return bad(`Name must be ${NAME_MAX} characters or fewer.`, origin);
    if (!isValidContactEmail(email)) {
      return bad("Please provide a valid email address.", origin);
    }

    const optional = {} as Record<OptionalField, string | null>;
    for (const f of OPTIONAL_FIELDS) {
      const r = optionalString(body[f]);
      if (!r.ok) return bad(`${f} must be text.`, origin);
      if (r.value && r.value.length > OPTIONAL_FIELD_MAX) {
        return bad(`${f} must be ${OPTIONAL_FIELD_MAX} characters or fewer.`, origin);
      }
      optional[f] = r.value;
    }
    const { company, companySize, interest } = optional;

    let domain: string | null = null;
    if (body.domain !== undefined && body.domain !== null && body.domain !== "") {
      domain = normalizePublicHostname(body.domain, { stripWww: true });
      if (!domain) {
        return bad("Please enter a valid domain (e.g. example.com).", origin);
      }
    }

    // Per-IP rate limit: one atomic bump before the insert, so a flood of
    // otherwise valid submissions from one source can't fill the table and
    // concurrent requests can't both slip under the limit. The IP is used
    // only to derive the hashed key (G38). A counter error fails OPEN: the
    // insert below needs D1 anyway, and losing a real enquiry is worse than
    // one unthrottled submission.
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    let rateKey: string | null = null;
    try {
      const k = await contactIpRateKey(env, ip, CONTACT_RATE_WINDOW_SECONDS);
      const n = await incrementContactRate(env.DB, k.key, k.expiresAtMs);
      if (n > CONTACT_RATE_LIMIT) {
        return json(
          {
            success: false,
            error: "Too many submissions from this network. Please try again later.",
          },
          429,
          origin,
        );
      }
      rateKey = k.key;
    } catch (err) {
      logger.warn("contact-rate-limit-error", { error: err instanceof Error ? err.message : String(err) });
    }

    const id = crypto.randomUUID();

    // ip_address is bound as NULL: the column stays for compatibility but
    // the IP is not stored.
    try {
      await env.DB.prepare(
        `INSERT INTO contact_submissions (id, name, email, company, company_size, interest, message, domain, ip_address)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
        .bind(id, name, email, company, companySize, interest, message, domain)
        .run();
    } catch (err) {
      // Only persisted submissions count toward the limit.
      if (rateKey) {
        await refundContactRate(env.DB, rateKey).catch(() => undefined);
      }
      throw err;
    }

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
    logger.error("contact-submission-failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return json(
      { success: false, error: "Failed to submit. Please try again." },
      500,
      origin,
    );
  }
}
