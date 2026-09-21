// Client-side mirror of packages/averrow-worker/src/lib/page-phishing-scorer.ts
// SIGNAL_WEIGHTS / SHADOW_SIGNAL_WEIGHTS, plus small parse/defang helpers
// for rendering `lookalike_domains.page_*` evidence on the tenant Domain
// Findings page. See docs/LANE3_AI_BUILD_ARTIFACTS_SPEC.md §3.5.
//
// Duplicated (not imported) from the worker package deliberately — the
// tenant SPA has no import path into the worker, and this file mirrors
// the ops-side copy in packages/averrow-ops/src/components/ui/
// SignalBreakdownCard.tsx for the same reason. Keep both in sync if the
// scorer's weights change; the worker file is the source of truth.
//
// LIVE vs SHADOW — do not blur this line. `page_signals` are the keys
// that actually drove `page_phishing_score` / `threat_level`.
// `page_ai_signals` are Lane 3 Phase 1 shadow-mode keys: computed and
// persisted for measurement, contributing NOTHING to the verdict. Render
// them in a visually and textually distinct group, explicitly labeled
// "not scoring" — never merged into, or sorted with, the live list.

export const PAGE_SIGNAL_WEIGHTS: Readonly<Record<string, number>> = {
  offdomain_form_exfil: 45,
  credential_form: 30,
  anti_bot_wall: 20,
  cloaking_redirect: 20,
  brand_asset_hotlink: 15,
  favicon_clone: 12,
  title_keyword_density: 10,
};

export const PAGE_SIGNAL_LABELS: Readonly<Record<string, string>> = {
  offdomain_form_exfil: 'Off-domain form exfil',
  credential_form: 'Credential form present',
  anti_bot_wall: 'Anti-bot wall (cloaking)',
  cloaking_redirect: 'Cloaking redirect to brand',
  brand_asset_hotlink: 'Real-brand asset hotlinked',
  favicon_clone: 'Favicon cloned from brand',
  title_keyword_density: 'Brand keyword density',
};

// Mirrors SHADOW_SIGNAL_WEIGHTS. Lane 3 Phase 1 shadow mode only — none
// of these weights are ever added to page_phishing_score.
export const SHADOW_SIGNAL_WEIGHTS: Readonly<Record<string, number>> = {
  covert_exfil_sink: 20,
  form_relay_sink: 10,
  svg_script_payload: 15,
  llm_refusal_leakage: 15,
  unrendered_template_token: 12,
  default_scaffold_title: 12,
  build_placeholder_text: 8,
  agent_scaffold_comment: 8,
};

export const SHADOW_SIGNAL_LABELS: Readonly<Record<string, string>> = {
  covert_exfil_sink: 'Covert exfil sink (Telegram/Discord/tunnel)',
  form_relay_sink: 'Generic form-relay backend',
  svg_script_payload: 'SVG script payload',
  llm_refusal_leakage: 'LLM refusal text left in page',
  unrendered_template_token: 'Unrendered template token',
  default_scaffold_title: 'Default scaffold title never replaced',
  build_placeholder_text: 'Build placeholder text left in page',
  agent_scaffold_comment: 'Agent to-do / scaffold comment left in page',
};

export function pageSignalLabel(key: string, map: Readonly<Record<string, string>>): string {
  return map[key] ?? key.replace(/_/g, ' ');
}

/**
 * `page_signals` / `page_ai_signals` arrive from the API as an
 * un-parsed JSON array string (TEXT column) — null on an unscanned row,
 * '[]' on a scanned row with nothing fired. Degrades to an empty list on
 * null or malformed JSON rather than throwing, so a bad payload blanks
 * one chip, not the whole findings page.
 */
export function parsePageSignalArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Defang a bare exfil-sink host before it is ever rendered.
 * `page_exfil_sink` is a live C2 host (Telegram bot / Discord webhook /
 * tunnel relay) — MUST NEVER be a clickable link or auto-linkified.
 * Clicking it issues a live request to attacker infrastructure from the
 * viewer's network. See migration 0264's constraint comment.
 */
export function defangHost(host: string): string {
  return host.replace(/\./g, '[.]');
}
