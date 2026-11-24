import type { BadgeStatus } from '@/design-system/components';
import type { IntegrationStatus } from '@/hooks/useTakedownIntegrations';

export const STATUS_BADGE: Record<IntegrationStatus, { status: BadgeStatus; label: string; pulse?: boolean }> = {
  live:         { status: 'healthy',  label: 'Live', pulse: true },
  paused:       { status: 'warning',  label: 'Ready · draft mode' },
  disabled:     { status: 'inactive', label: 'Disabled' },
  active:       { status: 'active',   label: 'Active' },
  unconfigured: { status: 'degraded', label: 'Not configured' },
};

export function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const then = new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z')).getTime();
  if (Number.isNaN(then)) return iso;
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function successColor(rate: number | null): string {
  if (rate === null) return 'var(--text-tertiary)';
  if (rate >= 80) return 'var(--sev-info-text)';
  if (rate >= 50) return 'var(--sev-medium-text)';
  return 'var(--sev-critical-text)';
}

/** "1 Dec": the next UTC month start, when a monthly cap resets. */
function nextResetLabel(now: Date = new Date()): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return next.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/**
 * "This month: 12 / 100 free submissions". Only the count is coloured (like
 * the Credential / Auto-submit values above): amber from 80% with "N left",
 * red at the cap. At the cap Web Risk takedowns WAIT (unclaimed) until the
 * cap resets at the next UTC month start; they are not failed or re-routed.
 */
export function MonthlyQuotaLine({ quota, now }: { quota: { used: number | null; cap: number }; now?: Date }) {
  const { used, cap } = quota;
  const reset = nextResetLabel(now);
  if (cap <= 0) {
    return (
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        This month: <strong style={{ color: 'var(--text-tertiary)' }}>paused</strong> (monthly cap set to 0)
      </div>
    );
  }
  const atCap = used != null && used >= cap;
  const near = used != null && !atCap && used >= cap * 0.8;
  const color = atCap ? 'var(--sev-critical-text)' : near ? 'var(--sev-medium-text)' : 'var(--text-primary)';
  const noun = cap <= 100 ? 'free submissions' : 'submissions';
  return (
    <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
      This month: <strong style={{ color, whiteSpace: 'nowrap' }}>{used ?? '—'} / {cap}</strong> {noun}
      {used == null && ' (count unavailable)'}
      {near && ` · ${cap - used!} left`}
      {atCap && <span style={{ color }}> · cap reached, takedowns wait until {reset} (UTC)</span>}
    </div>
  );
}
