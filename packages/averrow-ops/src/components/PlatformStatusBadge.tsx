// Live status badge — replaces the static "ALL SYSTEMS OPERATIONAL"
// pill on Home that lied for 82 hours during the Apr 30 - May 2 ingest
// blackout. Reads usePlatformStatus(), which polls /api/v1/public/
// platform-status every 60s.
//
// Facelift (Phase 6 screen 2): a static, token-coloured dot and a sans
// sentence-case label. No glow, no text-shadow, no looping ping: status is
// carried by colour + words, and motion is reserved for state changes
// (BRAND_BRIEF §3-4). Colours are theme-aware tokens, so light/dark track
// without overrides.
//
// Two sizes share one look:
//   compact   — the desktop Home header pill
//   prominent — the Command Center / flyout trigger (larger gap)

import type { CategoryStatus } from '@averrow/shared';
import { usePlatformStatus } from '@/hooks/usePlatformStatus';

interface Props {
  variant?: 'compact' | 'prominent';
}

interface PaletteEntry {
  label: string;
  dot: string;
  text: string;
}

const PALETTE: Record<CategoryStatus | 'loading', PaletteEntry> = {
  operational: { label: 'All systems operational', dot: 'var(--green)', text: 'var(--green-text, var(--sev-info-text))' },
  degraded: { label: 'Degraded', dot: 'var(--sev-medium)', text: 'var(--sev-medium-text)' },
  outage: { label: 'Outage', dot: 'var(--sev-critical)', text: 'var(--sev-critical-text)' },
  loading: { label: 'Checking…', dot: 'var(--text-tertiary)', text: 'var(--text-tertiary)' },
};

export function PlatformStatusBadge({ variant = 'compact' }: Props) {
  const { data, isLoading } = usePlatformStatus();
  const status: CategoryStatus | 'loading' = isLoading || !data ? 'loading' : data.overall;
  // Defensive: status should always be a known PALETTE key, but fall back to
  // the neutral "loading" entry rather than crash if an unexpected value
  // ever slips through (e.g. a malformed API response upstream).
  const palette = PALETTE[status] ?? PALETTE.loading;

  return (
    <div
      data-platform-status={status in PALETTE ? status : 'loading'}
      data-variant={variant}
      style={{ display: 'flex', alignItems: 'center', gap: variant === 'prominent' ? 9 : 8 }}
    >
      <span
        aria-hidden
        style={{ width: 8, height: 8, borderRadius: '50%', background: palette.dot, flexShrink: 0 }}
      />
      <span
        style={{
          fontSize: 'var(--type-label-size, 12px)',
          lineHeight: 'var(--type-label-lh, 16px)',
          fontFamily: 'var(--font-sans)',
          fontWeight: 500,
          letterSpacing: 'var(--type-label-tracking, 0.01em)',
          color: palette.text,
        }}
      >
        {palette.label}
      </span>
    </div>
  );
}
