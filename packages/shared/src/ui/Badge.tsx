// @averrow/shared/ui — Badge
//
// Unified severity / status / context / verdict / classification chip.
// Promoted from averrow-ops `components/ui/Badge.tsx` (v2.0) so ops and
// tenant render the same vocabulary. Colours come from theme tokens; the
// text colours are the theme-aware `--sev-*-text` / `--text-*` tokens so
// light mode keeps AA contrast.
//
// Accessibility: the label text always renders (colour is never the only
// signal). The pulse dot is decorative (`aria-hidden`).

import type { ReactNode } from 'react';
import { cn } from './cn';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type BadgeStatus =
  | 'active' | 'inactive' | 'pending' | 'draft'
  | 'running' | 'healthy' | 'degraded' | 'failed'
  | 'success' | 'warning';

/**
 * Context tags describe a row's trend / behaviour, distinct from severity
 * (threat scoring) and status (run state).
 * nexus: correlated with a NEXUS cluster; pivot: went silent (>80% drop);
 * accelerating: 7d trend > 1.5x 30d; quiet: no recent activity;
 * worsening / improving: trend direction.
 */
export type ContextTag =
  | 'nexus' | 'pivot' | 'accelerating' | 'quiet' | 'worsening' | 'improving';

/**
 * Verdict tags describe a pipeline / queue / health probe's current state.
 * clear, draining (backlog shrinking), steady, growing (falling behind),
 * stale (no measurement), updated, stable.
 */
export type VerdictTag =
  | 'clear' | 'draining' | 'steady' | 'growing'
  | 'stale' | 'updated' | 'stable';

/** Social / trademark / app-store finding classification. */
export type Classification =
  | 'impersonation' | 'suspicious' | 'official' | 'legitimate' | 'parked' | 'confirmed';

/** @deprecated Use `severity` / `status` instead. */
export type LegacyVariant =
  | 'critical' | 'high' | 'medium' | 'low'
  | 'success' | 'info' | 'default';

export type BadgeSize = 'xs' | 'sm' | 'md';

export interface BadgeProps {
  /**
   * Any string, matched case-insensitively (underlying tables are
   * inconsistent: social_profiles is UPPERCASE, alerts/threats lowercase).
   * Unknown values render neutral with the raw text; empty/null renders `—`.
   */
  severity?: Severity | (string & {}) | null;
  status?: BadgeStatus;
  context?: ContextTag;
  verdict?: VerdictTag;
  classification?: Classification | (string & {}) | null;
  size?: BadgeSize;
  /** Pulsing dot before the label (only for configs that define a dot). */
  pulse?: boolean;
  label?: string;
  /**
   * `mono` (default) = uppercase mono, for data/codes. `sans` = sentence-case
   * sans, for badges that carry a plain word ("Super admin", "This device").
   * Opt-in so the platform-wide Badge look is unchanged.
   */
  font?: 'mono' | 'sans';
  /** @deprecated Use `severity` / `status` instead. */
  variant?: LegacyVariant;
  children?: ReactNode;
  className?: string;
}

interface Tone {
  bg: string;
  border: string;
  text: string;
  dot?: string;
  label?: string;
}

const NEUTRAL: Tone = {
  bg: 'var(--border-base)',
  border: 'var(--border-base)',
  text: 'var(--text-secondary)',
};

const SEV: Record<Severity, Tone> = {
  critical: { dot: 'var(--sev-critical)', bg: 'var(--sev-critical-bg)', border: 'var(--sev-critical-border)', text: 'var(--sev-critical-text)', label: 'Critical' },
  high:     { dot: 'var(--sev-high)',     bg: 'var(--sev-high-bg)',     border: 'var(--sev-high-border)',     text: 'var(--sev-high-text)',     label: 'High' },
  medium:   { dot: 'var(--sev-medium)',   bg: 'var(--sev-medium-bg)',   border: 'var(--sev-medium-border)',   text: 'var(--sev-medium-text)',   label: 'Medium' },
  low:      { dot: 'var(--sev-low)',      bg: 'var(--sev-low-bg)',      border: 'var(--sev-low-border)',      text: 'var(--sev-low-text)',      label: 'Low' },
  info:     { dot: 'var(--sev-info)',     bg: 'var(--sev-info-bg)',     border: 'var(--sev-info-border)',     text: 'var(--sev-info-text)',     label: 'Info' },
};

// NEXUS / STABLE derive from --cyan-text; --orbital-teal is reserved for the
// Observatory WebGL and must not be hardcoded here.
const CYAN_BG_12 = 'color-mix(in srgb, var(--cyan-text) 12%, transparent)';
const CYAN_BG_7 = 'color-mix(in srgb, var(--cyan-text) 7%, transparent)';
const CYAN_BORDER_30 = 'color-mix(in srgb, var(--cyan-text) 30%, transparent)';
const CYAN_BORDER_20 = 'color-mix(in srgb, var(--cyan-text) 20%, transparent)';

const CTX: Record<ContextTag, Tone> = {
  nexus:        { bg: CYAN_BG_12, border: CYAN_BORDER_30, text: 'var(--cyan-text)', dot: 'var(--cyan-text)', label: 'NEXUS' },
  pivot:        { bg: 'var(--sev-critical-bg)', border: 'var(--sev-critical-border)', text: 'var(--sev-critical-text)', dot: 'var(--sev-critical)', label: 'PIVOT' },
  accelerating: { bg: 'var(--sev-medium-bg)', border: 'var(--sev-medium-border)', text: 'var(--sev-medium-text)', dot: 'var(--sev-medium)', label: 'ACCEL' },
  quiet:        { ...NEUTRAL, label: 'QUIET' },
  worsening:    { bg: 'var(--sev-critical-bg)', border: 'var(--sev-critical-border)', text: 'var(--sev-critical-text)', dot: 'var(--sev-critical)', label: 'WORSENING' },
  improving:    { bg: 'var(--sev-info-bg)', border: 'var(--sev-info-border)', text: 'var(--sev-info-text)', dot: 'var(--sev-info)', label: 'IMPROVING' },
};

const VERDICT: Record<VerdictTag, Tone> = {
  clear:    { bg: 'var(--sev-info-bg)', border: 'var(--sev-info-border)', text: 'var(--sev-info-text)', label: 'CLEAR' },
  draining: { bg: 'var(--sev-info-bg)', border: 'var(--sev-info-border)', text: 'var(--sev-info-text)', dot: 'var(--sev-info)', label: 'DRAINING' },
  steady:   { bg: 'var(--sev-medium-bg)', border: 'var(--sev-medium-border)', text: 'var(--sev-medium-text)', label: 'STEADY' },
  growing:  { bg: 'var(--sev-critical-bg)', border: 'var(--sev-critical-border)', text: 'var(--sev-critical-text)', dot: 'var(--sev-critical)', label: 'GROWING' },
  stale:    { bg: 'var(--sev-medium-bg)', border: 'var(--sev-medium-border)', text: 'var(--sev-medium-text)', label: 'STALE' },
  updated:  { bg: 'var(--blue-glow)', border: 'var(--blue-border)', text: 'var(--sev-low-text)', dot: 'var(--blue)', label: 'UPDATED' },
  stable:   { bg: CYAN_BG_7, border: CYAN_BORDER_20, text: 'var(--cyan-text)', label: 'STABLE' },
};

const STATUS: Record<BadgeStatus, Tone> = {
  active:   { bg: 'var(--sev-info-bg)', border: 'var(--sev-info-border)', text: 'var(--sev-info-text)', dot: 'var(--sev-info)' },
  healthy:  { bg: 'var(--sev-info-bg)', border: 'var(--sev-info-border)', text: 'var(--sev-info-text)', dot: 'var(--sev-info)' },
  running:  { bg: 'var(--blue-glow)', border: 'var(--blue-border)', text: 'var(--sev-low-text)', dot: 'var(--blue)' },
  pending:  { bg: 'var(--sev-medium-bg)', border: 'var(--sev-medium-border)', text: 'var(--sev-medium-text)' },
  draft:    NEUTRAL,
  inactive: { ...NEUTRAL },
  degraded: { bg: 'var(--sev-high-bg)', border: 'var(--sev-high-border)', text: 'var(--sev-high-text)', dot: 'var(--sev-high)' },
  failed:   { bg: 'var(--sev-critical-bg)', border: 'var(--sev-critical-border)', text: 'var(--sev-critical-text)', dot: 'var(--sev-critical)' },
  success:  { bg: 'var(--sev-info-bg)', border: 'var(--sev-info-border)', text: 'var(--sev-info-text)' },
  warning:  { bg: 'var(--sev-medium-bg)', border: 'var(--sev-medium-border)', text: 'var(--sev-medium-text)' },
};

// Matches the tenant ClassificationPill tones, on theme-aware tokens.
const CLASSIFICATION: Record<Classification, Tone> = {
  // Classifications keep their raw text (no tone label) except `confirmed`.
  impersonation: { ...SEV.critical, label: undefined },
  // A confirmed finding reads as critical, with a proper-cased label.
  confirmed:     { ...SEV.critical, label: 'Confirmed' },
  suspicious:    { ...SEV.medium, label: undefined },
  official:      { bg: 'var(--border-base)', border: 'var(--border-strong)', text: 'var(--text-secondary)' },
  legitimate:    NEUTRAL,
  parked:        { ...NEUTRAL },
};

const LEGACY_MAP: Partial<Record<LegacyVariant, Severity>> = {
  critical: 'critical', high: 'high', medium: 'medium', low: 'low',
  success: 'info', info: 'info',
};

const SIZE: Record<BadgeSize, { fontSize: number; padding: string; radius: number }> = {
  xs: { fontSize: 9,  padding: '2px 6px',  radius: 6 },
  sm: { fontSize: 9,  padding: '3px 8px',  radius: 99 },
  // md is 11px (ACCOUNT_DESIGN_SPEC §6: badge text floor on the account surface).
  md: { fontSize: 11, padding: '4px 10px', radius: 99 },
};

function lookup<T extends string>(table: Record<T, Tone>, key: string): Tone | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key as T] : undefined;
}

function resolve(p: BadgeProps): { tone: Tone; fallbackText: string } {
  // Truthiness precedence (matches the ops Badge): a null/empty severity or
  // classification falls through to status/context/verdict/variant. Only when
  // nothing else is set does an explicitly-passed empty value render `—`.
  const sevRaw = (p.severity ?? '').trim();
  if (sevRaw) {
    return { tone: lookup(SEV, sevRaw.toLowerCase()) ?? NEUTRAL, fallbackText: sevRaw };
  }
  const clsRaw = (p.classification ?? '').trim();
  if (clsRaw) {
    return { tone: lookup(CLASSIFICATION, clsRaw.toLowerCase()) ?? NEUTRAL, fallbackText: clsRaw };
  }
  if (p.status) return { tone: STATUS[p.status], fallbackText: p.status };
  if (p.context) return { tone: CTX[p.context], fallbackText: p.context };
  if (p.verdict) return { tone: VERDICT[p.verdict], fallbackText: p.verdict };
  if (p.variant && p.variant !== 'default') {
    const mapped = LEGACY_MAP[p.variant];
    if (mapped) return { tone: SEV[mapped], fallbackText: p.variant };
  }
  if (p.severity !== undefined || p.classification !== undefined) {
    return { tone: NEUTRAL, fallbackText: '—' };
  }
  return { tone: NEUTRAL, fallbackText: '' };
}

export function Badge(props: BadgeProps) {
  const { size = 'sm', pulse = false, label, children, className, font = 'mono' } = props;
  const z = SIZE[size];
  const { tone, fallbackText } = resolve(props);
  const showDot = pulse && !!tone.dot;

  // Caller label/children win; then the tone's pretty-cased label; then raw.
  // Classifications have no tone label (except `confirmed`), so they keep their
  // raw (case-insensitive) text.
  const text = label ?? children ?? tone.label ?? fallbackText;

  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap',
        font === 'sans' ? 'font-sans font-semibold normal-case tracking-[0.01em]' : 'font-mono font-extrabold uppercase tracking-[0.12em]',
        className,
      )}
      style={{
        gap: showDot ? 5 : 0,
        fontSize: font === 'sans' ? z.fontSize + 1 : z.fontSize,
        padding: z.padding,
        borderRadius: z.radius,
        background: tone.bg,
        border: `1px solid ${tone.border}`,
        color: tone.text,
        // color-mix handles both var() and hex dot colours; plain string
        // concatenation (`${dot}30`) is invalid CSS for var().
        boxShadow: tone.dot
          ? `inset 0 1px 0 color-mix(in srgb, ${tone.dot} 19%, transparent), 0 2px 8px color-mix(in srgb, ${tone.dot} 12%, transparent)`
          : 'none',
      }}
    >
      {showDot && (
        <span aria-hidden="true" style={{ position: 'relative', display: 'inline-flex', width: 6, height: 6 }}>
          <span
            style={{
              position: 'absolute', inset: 0, borderRadius: '50%',
              background: tone.dot, opacity: 0.7,
              // Inline so the global reduced-motion rule ([style*="chip-ping"])
              // can hide the ring. Keyframes live in theme/tokens.css.
              animation: 'chip-ping 1.5s ease-in-out infinite',
            }}
          />
          <span
            style={{
              position: 'relative', width: 6, height: 6, borderRadius: '50%',
              background: tone.dot, boxShadow: `0 0 6px ${tone.dot}`,
            }}
          />
        </span>
      )}
      {text}
    </span>
  );
}
