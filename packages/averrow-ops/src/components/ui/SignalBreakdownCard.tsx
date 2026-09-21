// SignalBreakdownCard — the weighted-evidence renderer for the
// deterministic page-phishing scorer (packages/averrow-worker/src/lib/
// page-phishing-scorer.ts). See docs/LANE3_AI_BUILD_ARTIFACTS_SPEC.md §3.5.
//
// Sibling to ScoreBreakdownCard
// (features/leads/components/ScoreBreakdownCard.tsx), NOT a reuse of it:
// ScoreBreakdownCard cracks a `{key: weight}` JSON object
// (score_breakdown_json). `lookalike_domains.page_signals` is a JSON
// ARRAY of fired keys with no weight attached, so the weight table has
// to live on this side of the API boundary — hence a new component
// rather than widening ScoreBreakdownCard's prop contract.
//
// LIVE vs SHADOW — do not blur this line. `signals` (page_signals) are
// the keys that actually drove page_phishing_score / threat_level.
// `shadowSignals` (page_ai_signals) are Lane 3 Phase 1 shadow-mode keys:
// computed and persisted for measurement, contributing NOTHING to the
// verdict (spec §4 guardrail 3, §5.1). They render in a visually and
// textually distinct block, explicitly labeled "not scoring" — never
// merged into, sorted with, or badged like the live list. Even a known
// shadow key arriving via the `signals` prop (misuse) is filtered out of
// the scoring group rather than rendered there — see `liveKeys` below.

import { Card, SectionLabel, Badge } from '@/design-system/components';

// Mirrors packages/averrow-worker/src/lib/page-phishing-scorer.ts
// SIGNAL_WEIGHTS. Duplicated here — there is no import path from the ops
// SPA into the worker package. Keep in sync if the scorer's weights
// change; the worker file is the source of truth (its own header says so).
export const PAGE_SIGNAL_WEIGHTS: Readonly<Record<string, number>> = {
  offdomain_form_exfil: 45,
  credential_form: 30,
  anti_bot_wall: 20,
  cloaking_redirect: 20,
  brand_asset_hotlink: 15,
  favicon_clone: 12,
  title_keyword_density: 10,
};

const PAGE_SIGNAL_LABELS: Readonly<Record<string, string>> = {
  offdomain_form_exfil: 'Off-domain form exfil',
  credential_form: 'Credential form present',
  anti_bot_wall: 'Anti-bot wall (cloaking)',
  cloaking_redirect: 'Cloaking redirect to brand',
  brand_asset_hotlink: 'Real-brand asset hotlinked',
  favicon_clone: 'Favicon cloned from brand',
  title_keyword_density: 'Brand keyword density',
};

// Mirrors SHADOW_SIGNAL_WEIGHTS in the same worker file. Lane 3 Phase 1 —
// shadow mode only. None of these weights are ever added to
// page_phishing_score; `shadowScoreDelta` below is the would-be
// contribution, rendered separately and never as a "+N pts" scoring badge.
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

const SHADOW_SIGNAL_LABELS: Readonly<Record<string, string>> = {
  covert_exfil_sink: 'Covert exfil sink (Telegram/Discord/tunnel)',
  form_relay_sink: 'Generic form-relay backend',
  svg_script_payload: 'SVG script payload',
  llm_refusal_leakage: 'LLM refusal text left in page',
  unrendered_template_token: 'Unrendered template token',
  default_scaffold_title: 'Default scaffold title never replaced',
  build_placeholder_text: 'Build placeholder text left in page',
  agent_scaffold_comment: 'Agent to-do / scaffold comment left in page',
};

function humanLabel(key: string, map: Readonly<Record<string, string>>): string {
  return map[key] ?? key.replace(/_/g, ' ');
}

function parseJsonArray(raw: string | string[] | null | undefined): string[] {
  if (Array.isArray(raw)) return raw;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function parseEvidence(
  raw: string | Record<string, string> | null | undefined,
): Record<string, string> {
  if (raw && typeof raw === 'object') return raw;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    return {};
  } catch {
    return {};
  }
}

export interface SignalBreakdownCardProps {
  /** page_phishing_score — 0-100, or null/undefined when never analyzed. */
  score?: number | null;
  /** page_signals — a JSON array string OR an already-parsed array of fired, SCORED signal keys. */
  signals: string | string[] | null;
  /** page_ai_signals — a JSON array string OR an already-parsed array of Lane 3 SHADOW keys. Never scored. */
  shadowSignals?: string | string[] | null;
  /** page_score_delta — shadow would-be contribution. Informational only; never added to `score`. */
  shadowScoreDelta?: number | null;
  /** page_evidence — JSON object string (or parsed object) mapping a fired key to its matched literal. Staff-only field. */
  evidence?: string | Record<string, string> | null;
  compact?: boolean;
}

export function SignalBreakdownCard({
  score = null,
  signals,
  shadowSignals = null,
  shadowScoreDelta = null,
  evidence = null,
  compact = false,
}: SignalBreakdownCardProps) {
  const rawLive = parseJsonArray(signals);
  const rawShadow = parseJsonArray(shadowSignals);
  const evidenceMap = parseEvidence(evidence);

  // Defensive: a key belonging to the SHADOW weight table must never
  // render inside the scoring group, even if it arrived via `signals`.
  const liveKeys = Array.from(new Set(rawLive)).filter(
    (k) => !(k in SHADOW_SIGNAL_WEIGHTS),
  );
  const shadowKeys = Array.from(new Set(rawShadow));

  const liveSorted = [...liveKeys].sort(
    (a, b) => (PAGE_SIGNAL_WEIGHTS[b] ?? 0) - (PAGE_SIGNAL_WEIGHTS[a] ?? 0),
  );
  const shadowSorted = [...shadowKeys].sort(
    (a, b) => (SHADOW_SIGNAL_WEIGHTS[b] ?? 0) - (SHADOW_SIGNAL_WEIGHTS[a] ?? 0),
  );

  return (
    <Card hover={false} padding={compact ? 14 : undefined}>
      <div className="flex items-center justify-between mb-3">
        <SectionLabel>Page Signal Breakdown</SectionLabel>
        {score !== null && score !== undefined && (
          <span className="font-mono text-sm font-bold" style={{ color: 'var(--amber)' }}>
            {Math.round(score)} / 100
          </span>
        )}
      </div>

      {liveSorted.length === 0 ? (
        <p className="text-sm italic" style={{ color: 'var(--text-tertiary)' }}>
          No scored signals fired on the last analysis.
        </p>
      ) : (
        <ul className="space-y-1.5" data-testid="scoring-signals">
          {liveSorted.map((key) => {
            const weight = PAGE_SIGNAL_WEIGHTS[key];
            return (
              <li key={key} className="flex items-start justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {humanLabel(key, PAGE_SIGNAL_LABELS)}
                  </span>
                  {evidenceMap[key] && (
                    <div
                      className="mt-0.5 font-mono text-[11px] truncate"
                      style={{ color: 'var(--text-muted)' }}
                      title={evidenceMap[key]}
                    >
                      &ldquo;{evidenceMap[key]}&rdquo;
                    </div>
                  )}
                </div>
                <Badge variant="info" className="font-mono text-[10px] shrink-0">
                  {weight !== undefined ? `+${weight}` : '—'}
                </Badge>
              </li>
            );
          })}
        </ul>
      )}

      {shadowSorted.length > 0 && (
        <div className="mt-4 pt-3" style={{ borderTop: '1px solid var(--border-base)' }}>
          <div className="flex items-center justify-between mb-2">
            <span
              className="text-[10px] uppercase tracking-widest font-mono font-bold"
              style={{ color: 'var(--text-muted)' }}
            >
              Shadow signals — not scoring
            </span>
            {shadowScoreDelta !== null && shadowScoreDelta !== undefined && (
              <span className="font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
                would-be +{shadowScoreDelta}
              </span>
            )}
          </div>
          <p className="text-[11px] mb-2" style={{ color: 'var(--text-muted)' }}>
            Lane 3 shadow-mode evidence — computed and persisted for measurement only.
            None of these contribute to the score above, to threat level, or to alert triage.
          </p>
          <ul className="space-y-1.5" data-testid="shadow-signals">
            {shadowSorted.map((key) => {
              const weight = SHADOW_SIGNAL_WEIGHTS[key];
              return (
                <li key={key} className="flex items-start justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <span style={{ color: 'var(--text-tertiary)' }}>
                      {humanLabel(key, SHADOW_SIGNAL_LABELS)}
                    </span>
                    {evidenceMap[key] && (
                      <div
                        className="mt-0.5 font-mono text-[11px] truncate"
                        style={{ color: 'var(--text-muted)' }}
                        title={evidenceMap[key]}
                      >
                        &ldquo;{evidenceMap[key]}&rdquo;
                      </div>
                    )}
                  </div>
                  <span
                    className="shrink-0 font-mono text-[9px] uppercase tracking-widest px-1.5 py-0.5 rounded"
                    style={{ color: 'var(--text-muted)', border: '1px solid var(--border-base)' }}
                    title={weight !== undefined ? `Would-be weight: ${weight} (not scored)` : 'Not scored'}
                  >
                    shadow
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Card>
  );
}
