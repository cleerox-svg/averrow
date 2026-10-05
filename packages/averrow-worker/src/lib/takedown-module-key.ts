// Averrow — takedown_requests.module_key derivation
//
// Every takedown send path (Sparrow Phase G auto-submit, staff
// mark-submitted, staff hand-submit) refuses a row whose `module_key` is
// NULL, because the key is what the takedown_authorizations scope check
// runs against. A writer that forgets to set it produces a takedown that
// can never be sent.
//
// This is the single target_type → module_key mapping. It mirrors what the
// Sparrow creators (agents/sparrow.ts) write as SQL literals — those six
// INSERTs keep their literals (pinned by test/sparrow-resolve-org.test.ts)
// and test/takedown-module-key.test.ts asserts each literal pair agrees
// with this map:
//
//   domain | url    → 'domain'     (malicious URL, lookalike, abuse report)
//   social_profile  → 'social'     (social impersonation)
//   mobile_app      → 'app_store'  (app-store impersonation)
//   paste           → 'dark_web'   (dark-web mention)
//
// Any other target_type (e.g. the customer route's 'email') has no module
// and stays NULL — the send paths then keep refusing it, unchanged.
//
// The backfill migration 0284_takedown_module_key_backfill.sql encodes the
// same mapping in SQL; test/takedown-module-key.test.ts pins the two
// together.

import type { ModuleKey } from "./entitlements";

export const TAKEDOWN_TARGET_TYPE_MODULE_KEYS: Readonly<Record<string, ModuleKey>> = Object.freeze({
  domain:         "domain",
  url:            "domain",
  social_profile: "social",
  mobile_app:     "app_store",
  paste:          "dark_web",
});

/** module_key for a takedown target_type, or null when it has no module. */
export function moduleKeyForTargetType(targetType: string | null | undefined): ModuleKey | null {
  if (!targetType) return null;
  return Object.prototype.hasOwnProperty.call(TAKEDOWN_TARGET_TYPE_MODULE_KEYS, targetType)
    ? TAKEDOWN_TARGET_TYPE_MODULE_KEYS[targetType]!
    : null;
}
