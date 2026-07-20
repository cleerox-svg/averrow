// Averrow — Executive identity registry validators (Stage 1).
//
// Pure input-validation + normalization for the org_executives CRUD API
// (EXEC_IMPERSONATION_2026-07 Stage 1). No DB, no env, no side effects —
// so every rule is unit-testable in isolation. Brand-ownership is a DB
// check and lives in the handler, not here.

// Canonical platform-key list. Kept in lockstep with SUPPORTED_PLATFORMS
// in scanners/social-monitor.ts — the 6 platforms the social monitor can
// actually check. Detection (Stage 2) watches exactly these keys.
export const SUPPORTED_EXEC_PLATFORMS = [
  "twitter",
  "linkedin",
  "instagram",
  "tiktok",
  "github",
  "youtube",
] as const;

export type ExecPlatform = (typeof SUPPORTED_EXEC_PLATFORMS)[number];

const PLATFORM_SET: ReadonlySet<string> = new Set(SUPPORTED_EXEC_PLATFORMS);

// Registry lifecycle: `active` = monitored, `paused` = record kept but not
// scanned. Lowercase to match the sibling registries' status casing.
export const VALID_EXEC_STATUS: ReadonlySet<string> = new Set(["active", "paused"]);

export const DEFAULT_EXEC_STATUS = "active";

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

export function isSupportedExecPlatform(platform: string): boolean {
  return PLATFORM_SET.has(platform);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** full_name: required, non-empty after trim, bounded length. */
export function validateFullName(input: unknown): Validated<string> {
  if (typeof input !== "string") return { ok: false, error: "full_name is required" };
  const name = input.trim();
  if (!name) return { ok: false, error: "full_name is required" };
  if (name.length > 200) return { ok: false, error: "full_name is too long (max 200)" };
  return { ok: true, value: name };
}

/** title: optional string; empty/whitespace collapses to null. */
export function validateTitle(input: unknown): Validated<string | null> {
  if (input === undefined || input === null) return { ok: true, value: null };
  if (typeof input !== "string") return { ok: false, error: "title must be a string" };
  const title = input.trim();
  if (title.length > 200) return { ok: false, error: "title is too long (max 200)" };
  return { ok: true, value: title || null };
}

/**
 * status: optional; defaults to `active`; must be in the vocabulary.
 * Normalizes `.trim().toLowerCase()` before the set-match — matching how
 * validateWatchPlatforms / validateOfficialHandles treat their keys.
 */
export function validateStatus(input: unknown): Validated<string> {
  if (input === undefined || input === null) return { ok: true, value: DEFAULT_EXEC_STATUS };
  if (typeof input !== "string") {
    return { ok: false, error: "status must be one of: active, paused" };
  }
  const status = input.trim().toLowerCase();
  if (!VALID_EXEC_STATUS.has(status)) {
    return { ok: false, error: "status must be one of: active, paused" };
  }
  return { ok: true, value: status };
}

/**
 * watch_platforms: JSON array of platform keys to monitor. Optional on
 * create — defaults to all six supported platforms. When provided it must
 * be an array of known platform keys; unknown keys are rejected so the
 * detection stage never receives a platform it can't scan. Deduped,
 * order-preserved.
 */
export function validateWatchPlatforms(input: unknown): Validated<string[]> {
  if (input === undefined || input === null) {
    return { ok: true, value: [...SUPPORTED_EXEC_PLATFORMS] };
  }
  if (!Array.isArray(input)) {
    return { ok: false, error: "watch_platforms must be an array of platform keys" };
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") {
      return { ok: false, error: "watch_platforms must contain only platform-key strings" };
    }
    const key = raw.trim().toLowerCase();
    if (!PLATFORM_SET.has(key)) {
      return { ok: false, error: `Unsupported platform key: ${raw}` };
    }
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  if (out.length === 0) {
    return { ok: false, error: "watch_platforms must include at least one platform" };
  }
  return { ok: true, value: out };
}

/**
 * official_handles: JSON object mapping platform -> handle, mirroring
 * brands.official_handles. Optional (defaults to {}). Keys must be known
 * platforms; values must be non-empty strings. A leading `@` is stripped
 * to match how social-monitor normalizes official handles.
 */
export function validateOfficialHandles(input: unknown): Validated<Record<string, string>> {
  if (input === undefined || input === null) return { ok: true, value: {} };
  if (!isPlainObject(input)) {
    return { ok: false, error: "official_handles must be an object of platform -> handle" };
  }
  const out: Record<string, string> = {};
  for (const [platform, rawHandle] of Object.entries(input)) {
    const key = platform.trim().toLowerCase();
    if (!PLATFORM_SET.has(key)) {
      return { ok: false, error: `Unsupported platform key: ${platform}` };
    }
    if (typeof rawHandle !== "string") {
      return { ok: false, error: `official_handles.${platform} must be a string` };
    }
    const handle = rawHandle.trim().replace(/^@+/, "");
    if (!handle) {
      return { ok: false, error: `official_handles.${platform} cannot be empty` };
    }
    if (handle.length > 100) {
      return { ok: false, error: `official_handles.${platform} is too long (max 100)` };
    }
    out[key] = handle;
  }
  return { ok: true, value: out };
}

export interface ExecutiveUpdateInput {
  full_name?: unknown;
  title?: unknown;
  official_handles?: unknown;
  watch_platforms?: unknown;
  status?: unknown;
}

/**
 * Partial-merge assembler for the update path: turns a body into the
 * `SET col = ?` fragments + bind values for the fields that are PRESENT,
 * leaving omitted fields unchanged. Fails fast on the first invalid field.
 * Pure — no DB. Excludes `brand_id` (validated with a DB ownership check
 * in the handler) and `updated_at` (appended by the handler). JSON columns
 * are serialized here so the handler binds ready values.
 */
export function buildExecutiveUpdate(
  body: ExecutiveUpdateInput,
): Validated<{ sets: string[]; binds: unknown[] }> {
  const sets: string[] = [];
  const binds: unknown[] = [];

  if (body.full_name !== undefined) {
    const r = validateFullName(body.full_name);
    if (!r.ok) return r;
    sets.push("full_name = ?"); binds.push(r.value);
  }
  if (body.title !== undefined) {
    const r = validateTitle(body.title);
    if (!r.ok) return r;
    sets.push("title = ?"); binds.push(r.value);
  }
  if (body.official_handles !== undefined) {
    const r = validateOfficialHandles(body.official_handles);
    if (!r.ok) return r;
    sets.push("official_handles = ?"); binds.push(JSON.stringify(r.value));
  }
  if (body.watch_platforms !== undefined) {
    const r = validateWatchPlatforms(body.watch_platforms);
    if (!r.ok) return r;
    sets.push("watch_platforms = ?"); binds.push(JSON.stringify(r.value));
  }
  if (body.status !== undefined) {
    const r = validateStatus(body.status);
    if (!r.ok) return r;
    sets.push("status = ?"); binds.push(r.value);
  }

  return { ok: true, value: { sets, binds } };
}

export interface ValidatedExecutiveCreate {
  full_name: string;
  title: string | null;
  official_handles: Record<string, string>;
  watch_platforms: string[];
  status: string;
}

export interface ExecutiveCreateInput {
  full_name?: unknown;
  title?: unknown;
  official_handles?: unknown;
  watch_platforms?: unknown;
  status?: unknown;
}

/**
 * Validate a full create payload. brand_id ownership is validated
 * separately in the handler (needs a DB round-trip).
 */
export function validateExecutiveCreate(body: ExecutiveCreateInput): Validated<ValidatedExecutiveCreate> {
  const name = validateFullName(body.full_name);
  if (!name.ok) return name;
  const title = validateTitle(body.title);
  if (!title.ok) return title;
  const handles = validateOfficialHandles(body.official_handles);
  if (!handles.ok) return handles;
  const platforms = validateWatchPlatforms(body.watch_platforms);
  if (!platforms.ok) return platforms;
  const status = validateStatus(body.status);
  if (!status.ok) return status;

  return {
    ok: true,
    value: {
      full_name: name.value,
      title: title.value,
      official_handles: handles.value,
      watch_platforms: platforms.value,
      status: status.value,
    },
  };
}
