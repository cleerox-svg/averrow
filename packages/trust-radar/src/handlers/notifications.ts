// TODO: Refactor to use handler-utils (Phase 6 continuation)
/**
 * Notification API handlers — per-user notification system.
 *
 * Uses the `notifications` table (per-user rows with read_at)
 * and `notification_preferences` table.
 *
 * Preference shape (event keys + channel keys + their defaults) is
 * derived from `lib/notification-events.ts` — the single source of
 * truth. Adding a new toggleable event there + a column to
 * `notification_preferences` automatically lights it up here.
 */

import { json } from "../lib/cors";
import { newTally, addToTally, recordD1Reads } from "../lib/analytics";
import type { Env } from "../types";
import {
  USER_TOGGLEABLE_EVENTS,
  NOTIFICATION_CHANNELS,
} from "@averrow/shared";

// Combined list of preference column names — events first, then channels.
// SQL columns in `notification_preferences` use these exact names.
const PREF_COLUMNS = [
  ...USER_TOGGLEABLE_EVENTS.map((e) => e.key),
  ...NOTIFICATION_CHANNELS.map((c) => c.key),
] as const;
type PrefColumn = (typeof PREF_COLUMNS)[number];

const PREF_DEFAULTS: Record<PrefColumn, boolean> = (() => {
  const out = {} as Record<PrefColumn, boolean>;
  for (const e of USER_TOGGLEABLE_EVENTS) out[e.key] = e.defaultEnabled;
  for (const c of NOTIFICATION_CHANNELS) out[c.key] = c.defaultEnabled;
  return out;
})();

// GET /api/notifications
//
// Powers both the bell dropdown (no filters) and the /v2/notifications
// archive page (filtered + searched + cursor-paginated).
//
// Query params:
//   limit       — page size, capped at 50
//   unread      — 'true' to filter unread only (bell uses this)
//   type        — filter by notification type (matches registry keys)
//   severity    — filter by severity (lowercase: critical/high/medium/low/info)
//   q           — case-insensitive LIKE search across title + message
//   cursor      — ISO timestamp from the last item's created_at;
//                 returns rows STRICTLY OLDER than this. Cursor-based
//                 pagination is stable across new inserts (offset
//                 pagination would shift rows under the user as new
//                 events arrive).
//
// Response also includes `next_cursor` (the oldest row's created_at
// in the current page), or null if fewer rows than `limit` were
// returned (= last page).
export async function handleListNotificationsV2(request: Request, env: Env, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const limit = Math.min(50, parseInt(url.searchParams.get("limit") ?? "50", 10));
    const unreadOnly = url.searchParams.get("unread") === "true";
    const stateFilter = url.searchParams.get("state"); // 'inbox'|'snoozed'|'done'|'all'
    const type = url.searchParams.get("type");
    const severity = url.searchParams.get("severity");
    const q = url.searchParams.get("q")?.trim();
    const cursor = url.searchParams.get("cursor");
    // N1: audience filter — comma-separated list of valid audience values.
    // The ops bell passes `audience=super_admin,team,all` to hide tenant
    // brand events from operators; the tenant inbox passes `audience=tenant`.
    // Unspecified = no filter (returns everything for backwards compatibility).
    const audienceParam = url.searchParams.get("audience");
    const VALID_AUDIENCES = new Set(['tenant', 'super_admin', 'team', 'all']);
    const audienceFilter = audienceParam
      ? audienceParam.split(',').map(s => s.trim()).filter(s => VALID_AUDIENCES.has(s))
      : null;

    // N3: surface state machine + tenant-scoping fields. The state
    // column is canonical; read_at stays for backwards compatibility
    // until N5 retires the legacy preferences UI. Snoozed rows are
    // hidden by default — unhidden by `unread=true` filter or when
    // snoozed_until <= now (handled by the SELECT predicate below).
    let sql = `SELECT id, brand_id, org_id, audience,
                      type, severity, title, message,
                      reason_text, recommended_action, link,
                      state, read_at, snoozed_until, done_at,
                      group_key, created_at, updated_at, metadata
               FROM notifications WHERE user_id = ?`;
    const params: unknown[] = [userId];

    // N4: explicit state filter for the triage inbox tabs
    // (Inbox / Snoozed / Done / All). Falls back to legacy
    // unread-only / inbox-default filtering when not provided.
    if (stateFilter === 'snoozed') {
      sql += ` AND state = 'snoozed' AND snoozed_until > datetime('now')`;
    } else if (stateFilter === 'done') {
      sql += ` AND state = 'done'`;
    } else if (stateFilter === 'all') {
      // No state predicate — return everything regardless of state.
    } else if (unreadOnly) {
      sql += ` AND state = 'unread'`;
    } else {
      // 'inbox' (default): hide done rows and unexpired snoozed rows.
      sql += ` AND state != 'done'
               AND (state != 'snoozed' OR snoozed_until <= datetime('now'))`;
    }
    if (type) {
      sql += ` AND type = ?`;
      params.push(type);
    }
    if (severity) {
      sql += ` AND severity = ?`;
      params.push(severity);
    }
    if (audienceFilter && audienceFilter.length > 0) {
      sql += ` AND audience IN (${audienceFilter.map(() => '?').join(',')})`;
      params.push(...audienceFilter);
    }
    if (q) {
      sql += ` AND (LOWER(title) LIKE ? OR LOWER(message) LIKE ?)`;
      const needle = `%${q.toLowerCase()}%`;
      params.push(needle, needle);
    }
    if (cursor) {
      sql += ` AND created_at < ?`;
      params.push(cursor);
    }

    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    const tally = newTally();
    const rows = await env.DB.prepare(sql).bind(...params).all<{
      id: string;
      brand_id: string | null; org_id: string | null; audience: string;
      type: string; severity: string;
      title: string; message: string;
      reason_text: string | null; recommended_action: string | null; link: string | null;
      state: string;
      read_at: string | null; snoozed_until: string | null; done_at: string | null;
      group_key: string | null;
      created_at: string; updated_at: string;
      metadata: string | null;
    }>();
    addToTally(tally, rows.meta);
    const results = rows.results;

    // next_cursor is the oldest row's created_at (so the next page
    // can ask for rows older than this). null when we got fewer than
    // `limit` rows = last page.
    const nextCursor = results.length === limit
      ? results[results.length - 1]!.created_at
      : null;

    // Get unread count. The badge reflects the audience-scoped total so
    // the ops bell badge doesn't blink on tenant-only events when the ops
    // view filters them out. Unfiltered query keeps the legacy contract
    // when no audience filter is supplied.
    let countSql = `SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND state = 'unread'`;
    const countParams: unknown[] = [userId];
    if (audienceFilter && audienceFilter.length > 0) {
      countSql += ` AND audience IN (${audienceFilter.map(() => '?').join(',')})`;
      countParams.push(...audienceFilter);
    }
    const countRow = await env.DB.prepare(countSql).bind(...countParams).first<{ c: number }>();
    tally.queries += 1;

    recordD1Reads(env, "notifications_feed", tally);
    return json({
      success: true,
      data: results,
      unread_count: countRow?.c ?? 0,
      next_cursor: nextCursor,
    }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// POST /api/notifications/:id/read
export async function handleMarkNotificationReadV2(request: Request, env: Env, notificationId: string, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    // N3: write both the canonical state column AND read_at (legacy)
    // so any code path still consulting read_at keeps working until
    // N5 retires it.
    await env.DB.prepare(
      `UPDATE notifications
          SET state = 'read', read_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND user_id = ? AND state = 'unread'`
    ).bind(notificationId, userId).run();
    return json({ success: true }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// POST /api/notifications/read-all
export async function handleMarkAllNotificationsReadV2(request: Request, env: Env, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const result = await env.DB.prepare(
      `UPDATE notifications
          SET state = 'read', read_at = datetime('now'), updated_at = datetime('now')
        WHERE user_id = ? AND state = 'unread'`
    ).bind(userId).run();
    return json({ success: true, data: { marked: result.meta.changes } }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// GET /api/notifications/unread-count
//
// N1: accepts the same `audience=comma,separated` filter as the list
// endpoint so the bell badge reflects only operator-relevant unread when
// the ops UI scopes itself. Unspecified = unfiltered (legacy contract).
export async function handleUnreadCount(request: Request, env: Env, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const url = new URL(request.url);
    const audienceParam = url.searchParams.get("audience");
    const VALID_AUDIENCES = new Set(['tenant', 'super_admin', 'team', 'all']);
    const audienceFilter = audienceParam
      ? audienceParam.split(',').map(s => s.trim()).filter(s => VALID_AUDIENCES.has(s))
      : null;

    let sql = `SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND state = 'unread'`;
    const params: unknown[] = [userId];
    if (audienceFilter && audienceFilter.length > 0) {
      sql += ` AND audience IN (${audienceFilter.map(() => '?').join(',')})`;
      params.push(...audienceFilter);
    }
    const row = await env.DB.prepare(sql).bind(...params).first<{ count: number }>();
    return json({ success: true, count: row?.count ?? 0 }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// POST /api/notifications/:id/snooze
// Body: { until: ISO-8601 timestamp }
//
// State transition: any → 'snoozed'. The row resurfaces in the inbox
// when snoozed_until <= now (LIST handler honors this without a cron).
// Per Q1 + Q6 — snooze targets a single notification today;
// per-type / per-brand snoozing lands in N5 via subscriptions.
export async function handleSnoozeNotification(request: Request, env: Env, notificationId: string, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json().catch(() => ({})) as { until?: string };
    if (!body.until || typeof body.until !== 'string') {
      return json({ success: false, error: "until is required (ISO-8601)" }, 400, origin);
    }
    // Sanity-check: must be a parseable future timestamp.
    const ts = Date.parse(body.until);
    if (Number.isNaN(ts) || ts <= Date.now()) {
      return json({ success: false, error: "until must be a future ISO-8601 timestamp" }, 400, origin);
    }
    const result = await env.DB.prepare(
      `UPDATE notifications
          SET state = 'snoozed', snoozed_until = ?, updated_at = datetime('now')
        WHERE id = ? AND user_id = ?`
    ).bind(body.until, notificationId, userId).run();
    if (result.meta.changes === 0) {
      return json({ success: false, error: "Notification not found" }, 404, origin);
    }
    return json({ success: true }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// POST /api/notifications/:id/done
//
// State transition: any → 'done'. Done rows are hidden from the inbox
// view but still queryable (e.g. archive search). Per Q1 — replaces
// the binary read/unread with a four-state machine.
export async function handleMarkDone(request: Request, env: Env, notificationId: string, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const result = await env.DB.prepare(
      `UPDATE notifications
          SET state = 'done', done_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND user_id = ?`
    ).bind(notificationId, userId).run();
    if (result.meta.changes === 0) {
      return json({ success: false, error: "Notification not found" }, 404, origin);
    }
    return json({ success: true }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

/** Quiet-hours fields layered onto the existing flat-bool preferences.
 *  Added in PR 3a (migration 0106). Optional in the API payload — a request
 *  that doesn't include them leaves them unchanged. */
interface QuietHoursPayload {
  quiet_hours_start?: string | null;   // 'HH:MM' or null to clear
  quiet_hours_end?: string | null;
  quiet_hours_tz?: string | null;
  critical_breakthrough?: boolean;
}

interface PreferencesGetResponse extends Record<PrefColumn, boolean>, QuietHoursPayload {}

// GET /api/notifications/preferences
export async function handleGetPreferences(request: Request, env: Env, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const colsWithQuiet = `${PREF_COLUMNS.join(', ')}, quiet_hours_start, quiet_hours_end, quiet_hours_tz, critical_breakthrough`;
    const row = await env.DB.prepare(
      `SELECT ${colsWithQuiet} FROM notification_preferences WHERE user_id = ?`
    ).bind(userId).first<Record<PrefColumn, number | null> & {
      quiet_hours_start: string | null;
      quiet_hours_end: string | null;
      quiet_hours_tz: string | null;
      critical_breakthrough: number | null;
    }>();

    if (!row) {
      const defaults: PreferencesGetResponse = {
        ...PREF_DEFAULTS,
        quiet_hours_start: null,
        quiet_hours_end: null,
        quiet_hours_tz: null,
        critical_breakthrough: false,
      };
      return json({ success: true, data: defaults }, 200, origin);
    }

    const data = {} as PreferencesGetResponse;
    for (const col of PREF_COLUMNS) {
      data[col] = row[col] === null ? PREF_DEFAULTS[col] : !!row[col];
    }
    data.quiet_hours_start = row.quiet_hours_start;
    data.quiet_hours_end = row.quiet_hours_end;
    data.quiet_hours_tz = row.quiet_hours_tz;
    data.critical_breakthrough = !!row.critical_breakthrough;
    return json({ success: true, data }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// PUT /api/notifications/preferences
export async function handleUpdatePreferences(request: Request, env: Env, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json() as Partial<Record<PrefColumn, boolean>> & QuietHoursPayload;

    // SQL columns + placeholders + UPDATE clauses are all derived from the
    // registry — no hand-maintained list to drift from the column set.
    // Column names come from the typed registry, so SQL injection is impossible.
    const colList = PREF_COLUMNS.join(', ');
    const placeholders = PREF_COLUMNS.map(() => '?').join(', ');
    const updateClauses = PREF_COLUMNS.map((c) => `${c} = excluded.${c}`).join(', ');

    const values = PREF_COLUMNS.map((c) => {
      const explicit = body[c];
      const value = explicit !== undefined ? explicit : PREF_DEFAULTS[c];
      return value ? 1 : 0;
    });

    // Step 1: upsert the flat-bool columns (existing behavior — unchanged
    // contract for the still-deployed UI).
    await env.DB.prepare(
      `INSERT INTO notification_preferences (user_id, ${colList})
       VALUES (?, ${placeholders})
       ON CONFLICT(user_id) DO UPDATE SET ${updateClauses}`
    ).bind(userId, ...values).run();

    // Step 2: if the body included quiet-hours fields, update them. Done as
    // a separate UPDATE so omitting these fields doesn't accidentally clear
    // them (additive contract — clients that don't know about quiet hours
    // continue to work exactly as before).
    const quietUpdates: string[] = [];
    const quietBindings: unknown[] = [];
    if ('quiet_hours_start' in body) {
      quietUpdates.push('quiet_hours_start = ?');
      quietBindings.push(body.quiet_hours_start ?? null);
    }
    if ('quiet_hours_end' in body) {
      quietUpdates.push('quiet_hours_end = ?');
      quietBindings.push(body.quiet_hours_end ?? null);
    }
    if ('quiet_hours_tz' in body) {
      quietUpdates.push('quiet_hours_tz = ?');
      quietBindings.push(body.quiet_hours_tz ?? null);
    }
    if ('critical_breakthrough' in body) {
      quietUpdates.push('critical_breakthrough = ?');
      quietBindings.push(body.critical_breakthrough ? 1 : 0);
    }
    if (quietUpdates.length > 0) {
      quietBindings.push(userId);
      await env.DB.prepare(
        `UPDATE notification_preferences SET ${quietUpdates.join(', ')} WHERE user_id = ?`
      ).bind(...quietBindings).run();
    }

    return json({ success: true }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── N5: notification_preferences_v2 ──────────────────────────────────
//
// Replacement for the legacy flat-bool preferences. Per-channel
// severity floors + digest mode + super_admin opt-in. The legacy
// table stays in place (read-only) until the bell + email paths are
// fully migrated; this lets v1 and v2 UIs coexist briefly.

type SeverityFloor = 'critical' | 'high' | 'medium' | 'low' | 'info';
type SeverityFloorWithOff = SeverityFloor | 'off';
type DigestMode = 'realtime' | 'hourly' | 'daily' | 'weekly' | 'off';

// NX5: per-group cadence type. Distinct from digest_mode (which gates
// tenant-targeted brand events) — these two fields control how
// intel + platform notifications batch.
type GroupCadence = 'realtime' | 'daily_digest' | 'weekly_digest';

interface PreferencesV2Row {
  inapp_severity_floor: SeverityFloor;
  push_severity_floor: SeverityFloorWithOff;
  email_severity_floor: SeverityFloorWithOff;
  digest_mode: DigestMode;
  digest_severity_floor: 'high' | 'medium' | 'low' | 'info';
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  quiet_hours_timezone: string;
  critical_bypasses_quiet: number;
  show_tenant_notifications: number;
  // NX5: per-group cadence (migration 0193)
  cadence_intel: GroupCadence;
  cadence_platform: GroupCadence;
}

const PREF_V2_DEFAULTS: PreferencesV2Row = {
  inapp_severity_floor: 'info',
  // NX5+1: lowered from 'high' so default-installed users actually receive
  // notifications on push. Migration 0194 backfilled existing staff rows
  // that were still on the legacy default. Industry standard for operator
  // tooling is opt-out from noisy types, not opt-in to seeing anything at all.
  push_severity_floor: 'low',
  email_severity_floor: 'high',
  digest_mode: 'daily',
  digest_severity_floor: 'medium',
  quiet_hours_start: null,
  quiet_hours_end: null,
  quiet_hours_timezone: 'UTC',
  critical_bypasses_quiet: 1,
  show_tenant_notifications: 0,
  cadence_intel: 'realtime',
  cadence_platform: 'realtime',
};

const VALID_SEVERITY: ReadonlySet<SeverityFloor> = new Set(['critical','high','medium','low','info']);
const VALID_SEVERITY_OFF: ReadonlySet<SeverityFloorWithOff> = new Set(['critical','high','medium','low','info','off']);
const VALID_DIGEST: ReadonlySet<DigestMode> = new Set(['realtime','hourly','daily','weekly','off']);
const VALID_DIGEST_FLOOR: ReadonlySet<'high'|'medium'|'low'|'info'> = new Set(['high','medium','low','info']);
const VALID_GROUP_CADENCE: ReadonlySet<GroupCadence> = new Set(['realtime','daily_digest','weekly_digest']);

// GET /api/notifications/preferences/v2
export async function handleGetPreferencesV2(request: Request, env: Env, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const row = await env.DB.prepare(
      `SELECT inapp_severity_floor, push_severity_floor, email_severity_floor,
              digest_mode, digest_severity_floor,
              quiet_hours_start, quiet_hours_end, quiet_hours_timezone,
              critical_bypasses_quiet, show_tenant_notifications,
              cadence_intel, cadence_platform
         FROM notification_preferences_v2 WHERE user_id = ?`
    ).bind(userId).first<PreferencesV2Row>();

    // Auto-seed if missing (the N2 backfill covered active users at
    // migration time but new users won't have a row). Explicit columns
    // so the seeded row matches PREF_V2_DEFAULTS — not the (now-stale)
    // column DEFAULTs in migration 0127. Specifically push_severity_floor
    // needs to be 'low' for new staff users; migration 0194 lowered the
    // legacy 'high' value for existing rows.
    if (!row) {
      await env.DB.prepare(
        `INSERT INTO notification_preferences_v2 (
           user_id, inapp_severity_floor, push_severity_floor, email_severity_floor,
           digest_mode, digest_severity_floor,
           quiet_hours_timezone, critical_bypasses_quiet, show_tenant_notifications,
           cadence_intel, cadence_platform
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO NOTHING`
      ).bind(
        userId,
        PREF_V2_DEFAULTS.inapp_severity_floor,
        PREF_V2_DEFAULTS.push_severity_floor,
        PREF_V2_DEFAULTS.email_severity_floor,
        PREF_V2_DEFAULTS.digest_mode,
        PREF_V2_DEFAULTS.digest_severity_floor,
        PREF_V2_DEFAULTS.quiet_hours_timezone,
        PREF_V2_DEFAULTS.critical_bypasses_quiet,
        PREF_V2_DEFAULTS.show_tenant_notifications,
        PREF_V2_DEFAULTS.cadence_intel,
        PREF_V2_DEFAULTS.cadence_platform,
      ).run();
      return json({ success: true, data: PREF_V2_DEFAULTS }, 200, origin);
    }
    return json({ success: true, data: row }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// PUT /api/notifications/preferences/v2
export async function handleUpdatePreferencesV2(request: Request, env: Env, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json() as Partial<PreferencesV2Row>;

    // Validate every provided field against its allowlist before
    // building the UPDATE — anything not in the allowlist is dropped.
    const updates: string[] = [];
    const bindings: unknown[] = [];

    if (body.inapp_severity_floor !== undefined) {
      if (!VALID_SEVERITY.has(body.inapp_severity_floor)) {
        return json({ success: false, error: "Invalid inapp_severity_floor" }, 400, origin);
      }
      updates.push('inapp_severity_floor = ?'); bindings.push(body.inapp_severity_floor);
    }
    if (body.push_severity_floor !== undefined) {
      if (!VALID_SEVERITY_OFF.has(body.push_severity_floor)) {
        return json({ success: false, error: "Invalid push_severity_floor" }, 400, origin);
      }
      updates.push('push_severity_floor = ?'); bindings.push(body.push_severity_floor);
    }
    if (body.email_severity_floor !== undefined) {
      if (!VALID_SEVERITY_OFF.has(body.email_severity_floor)) {
        return json({ success: false, error: "Invalid email_severity_floor" }, 400, origin);
      }
      updates.push('email_severity_floor = ?'); bindings.push(body.email_severity_floor);
    }
    if (body.digest_mode !== undefined) {
      if (!VALID_DIGEST.has(body.digest_mode)) {
        return json({ success: false, error: "Invalid digest_mode" }, 400, origin);
      }
      updates.push('digest_mode = ?'); bindings.push(body.digest_mode);
    }
    if (body.digest_severity_floor !== undefined) {
      if (!VALID_DIGEST_FLOOR.has(body.digest_severity_floor)) {
        return json({ success: false, error: "Invalid digest_severity_floor" }, 400, origin);
      }
      updates.push('digest_severity_floor = ?'); bindings.push(body.digest_severity_floor);
    }
    if ('quiet_hours_start' in body) {
      updates.push('quiet_hours_start = ?'); bindings.push(body.quiet_hours_start ?? null);
    }
    if ('quiet_hours_end' in body) {
      updates.push('quiet_hours_end = ?'); bindings.push(body.quiet_hours_end ?? null);
    }
    if (body.quiet_hours_timezone !== undefined) {
      updates.push('quiet_hours_timezone = ?'); bindings.push(body.quiet_hours_timezone);
    }
    if (body.critical_bypasses_quiet !== undefined) {
      updates.push('critical_bypasses_quiet = ?'); bindings.push(body.critical_bypasses_quiet ? 1 : 0);
    }
    if (body.show_tenant_notifications !== undefined) {
      updates.push('show_tenant_notifications = ?'); bindings.push(body.show_tenant_notifications ? 1 : 0);
    }
    // NX5: per-group cadence
    if (body.cadence_intel !== undefined) {
      if (!VALID_GROUP_CADENCE.has(body.cadence_intel)) {
        return json({ success: false, error: "Invalid cadence_intel" }, 400, origin);
      }
      updates.push('cadence_intel = ?'); bindings.push(body.cadence_intel);
    }
    if (body.cadence_platform !== undefined) {
      if (!VALID_GROUP_CADENCE.has(body.cadence_platform)) {
        return json({ success: false, error: "Invalid cadence_platform" }, 400, origin);
      }
      updates.push('cadence_platform = ?'); bindings.push(body.cadence_platform);
    }

    if (updates.length === 0) {
      return json({ success: false, error: "No valid fields provided" }, 400, origin);
    }

    updates.push("updated_at = datetime('now')");

    await env.DB.prepare(
      `INSERT INTO notification_preferences_v2 (user_id) VALUES (?)
       ON CONFLICT(user_id) DO NOTHING`
    ).bind(userId).run();

    bindings.push(userId);
    await env.DB.prepare(
      `UPDATE notification_preferences_v2 SET ${updates.join(', ')} WHERE user_id = ?`
    ).bind(...bindings).run();

    return json({ success: true }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// ─── N5: notification_subscriptions ───────────────────────────────────

type SubscriptionLevel = 'watching' | 'default' | 'ignored';
const VALID_SUB_LEVEL: ReadonlySet<SubscriptionLevel> = new Set(['watching','default','ignored']);

interface SubscriptionRow {
  brand_id: string;
  brand_name: string | null;
  level: SubscriptionLevel;
  snoozed_until: string | null;
  updated_at: string;
}

// GET /api/notifications/subscriptions
//
// Returns the user's per-brand subscription list joined with brand
// metadata so the UI can render brand names without a second fetch.
export async function handleListSubscriptions(request: Request, env: Env, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const rows = await env.DB.prepare(
      `SELECT ns.brand_id, b.name AS brand_name, ns.level, ns.snoozed_until, ns.updated_at
         FROM notification_subscriptions ns
         LEFT JOIN brands b ON b.id = ns.brand_id
        WHERE ns.user_id = ?
        ORDER BY ns.updated_at DESC`
    ).bind(userId).all<SubscriptionRow>();
    return json({ success: true, data: rows.results }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// PUT /api/notifications/subscriptions/:brandId
// Body: { level: 'watching'|'default'|'ignored', snoozed_until?: string }
export async function handleUpdateSubscription(request: Request, env: Env, brandId: string, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    const body = await request.json() as { level?: SubscriptionLevel; snoozed_until?: string | null };
    if (!body.level || !VALID_SUB_LEVEL.has(body.level)) {
      return json({ success: false, error: "level required (watching|default|ignored)" }, 400, origin);
    }
    if (!brandId) {
      return json({ success: false, error: "brandId required" }, 400, origin);
    }
    const brandRow = await env.DB.prepare("SELECT id FROM brands WHERE id = ?")
      .bind(brandId).first<{ id: string }>();
    if (!brandRow) {
      return json({ success: false, error: "Brand not found" }, 404, origin);
    }

    await env.DB.prepare(
      `INSERT INTO notification_subscriptions (user_id, brand_id, level, snoozed_until, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, brand_id) DO UPDATE
         SET level = excluded.level,
             snoozed_until = excluded.snoozed_until,
             updated_at = datetime('now')`
    ).bind(userId, brandId, body.level, body.snoozed_until ?? null).run();

    return json({ success: true }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}

// DELETE /api/notifications/subscriptions/:brandId
export async function handleDeleteSubscription(request: Request, env: Env, brandId: string, userId: string): Promise<Response> {
  const origin = request.headers.get("Origin");
  try {
    if (!brandId) {
      return json({ success: false, error: "brandId required" }, 400, origin);
    }
    await env.DB.prepare(
      "DELETE FROM notification_subscriptions WHERE user_id = ? AND brand_id = ?"
    ).bind(userId, brandId).run();
    return json({ success: true }, 200, origin);
  } catch (err) {
    return json({ success: false, error: "An internal error occurred" }, 500, origin);
  }
}
