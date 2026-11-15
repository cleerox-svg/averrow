// Where the staff SPA is mounted. One source of truth for the router basename,
// service-worker registration, update-banner shell URL and every auth return_to.
//
// It was /v2 until 2026-11-15 (hard cut: /v2/* now 404s, no redirect). Static
// files that cannot import this — public/sw.js, public/manifest.json,
// index.html's icon links — hard-code the same literal; basePath.test.ts pins
// them to this constant, and the worker has its own twin (src/lib/app-paths.ts).
//
// Keep this file import-free: vite.config.ts imports it.

/** Mount path, no trailing slash. react-router `basename`. */
export const OPS_BASE_PATH = '/ops';
/** Shell URL (trailing slash): SW scope, update-probe URL, auth return_to. */
export const OPS_SHELL_URL = `${OPS_BASE_PATH}/`;
/** The retired mount. Only referenced to clean up / strip legacy values. */
export const LEGACY_OPS_BASE_PATH = '/v2';

const STRIP_RE = new RegExp(`^(?:${OPS_BASE_PATH}|${LEGACY_OPS_BASE_PATH})(?=[/?#]|$)`);

/** Strip a leading /ops (or legacy /v2) mount prefix; other input untouched. */
export function stripOpsBase(path: string): string {
  return path.replace(STRIP_RE, '');
}
