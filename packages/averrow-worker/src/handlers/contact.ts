// TODO: Refactor to use handler-utils (Phase 6 continuation)
/**
 * Contact form submission handler.
 * POST /api/contact
 */
import { json } from "../lib/cors";
import type { Env } from "../types";

interface ContactBody {
  name?: string;
  email?: string;
  company?: string;
  interest?: string;
  message?: string;
}

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

    const id = crypto.randomUUID();
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";

    await env.DB.prepare(
      `INSERT INTO contact_submissions (id, name, email, company, interest, message, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, name, email, body.company?.trim() ?? null, body.interest?.trim() ?? null, message, ip)
      .run();

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
