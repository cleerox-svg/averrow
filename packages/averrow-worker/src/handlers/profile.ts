// Profile handlers — GET + PATCH /api/profile
//
// Powers the Profile page Account / Preferences cards. Distinct from
// /api/auth/me — that returns the session bootstrap (org membership,
// passkey count, role); this is the editable surface (display_name,
// theme_preference, timezone).
//
// PATCH is partial — only the fields included in the body are
// modified. Passing `null` for a field clears it (falls back to
// the Google name / browser timezone / app default).

import { json } from "../lib/cors";
import type { Env } from "../types";

interface ProfileRow {
  id: string;
  email: string;
  name: string;
  role: string;
  display_name: string | null;
  timezone: string | null;
  theme_preference: string | null;
}

// GET /api/profile — auth required
export async function handleGetProfile(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const profile = await env.DB.prepare(
      `SELECT id, email, name, role, display_name, timezone, theme_preference
         FROM users WHERE id = ?`,
    ).bind(userId).first<ProfileRow>();

    if (!profile) {
      return json({ success: false, error: "User not found" }, 404, origin);
    }

    return json({ success: true, data: { profile } }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

interface PatchBody {
  display_name?: string | null;
  timezone?: string | null;
  theme_preference?: "dark" | "light" | null;
}

// PATCH /api/profile — auth required
//
// Validates IANA timezone strings via Intl.DateTimeFormat (only
// available in modern V8/Workers runtimes — same check FarmTrack does).
// theme_preference is enum-checked against the column constraint.
export async function handleUpdateProfile(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = (await request.json()) as PatchBody;

    const sets: string[] = [];
    const params: unknown[] = [];

    if (Object.prototype.hasOwnProperty.call(body, "display_name")) {
      const v = body.display_name;
      // Normalize empty strings to NULL so we cleanly fall back to name.
      const normalized = typeof v === "string" && v.trim() ? v.trim() : null;
      sets.push("display_name = ?");
      params.push(normalized);
    }

    if (Object.prototype.hasOwnProperty.call(body, "timezone")) {
      const v = body.timezone;
      if (v != null) {
        try {
          // Throws RangeError if not a valid IANA zone.
          new Intl.DateTimeFormat("en-US", { timeZone: v }).format(0);
        } catch {
          return json({ success: false, error: "Invalid timezone" }, 400, origin);
        }
      }
      sets.push("timezone = ?");
      params.push(v);
    }

    if (Object.prototype.hasOwnProperty.call(body, "theme_preference")) {
      const v = body.theme_preference;
      if (v != null && v !== "dark" && v !== "light") {
        return json({ success: false, error: "theme_preference must be 'dark' or 'light'" }, 400, origin);
      }
      sets.push("theme_preference = ?");
      params.push(v);
    }

    if (sets.length === 0) {
      return json({ success: false, error: "No fields to update" }, 400, origin);
    }

    params.push(userId);
    await env.DB.prepare(
      `UPDATE users SET ${sets.join(", ")} WHERE id = ?`,
    ).bind(...params).run();

    const profile = await env.DB.prepare(
      `SELECT id, email, name, role, display_name, timezone, theme_preference
         FROM users WHERE id = ?`,
    ).bind(userId).first<ProfileRow>();

    return json({ success: true, data: { profile } }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
