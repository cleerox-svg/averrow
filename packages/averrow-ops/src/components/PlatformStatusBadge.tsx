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
import { OVERALL_LABEL, STATUS_BADGE } from '@/components/platform-status-ui';

interface Props {
  variant?: 'compact' | 'prominent';
}

const LOADING = { label: 'Checking…', dot: 'var(--text-tertiary)', text: 'var(--text-tertiary)' };

function paletteFor(status: CategoryStatus | 'loading') {
  if (status === 'loading' || !(status in STATUS_BADGE)) return LOADING;
  return { label: OVERALL_LABEL[status], dot: STATUS_BADGE[status].dot, text: STATUS_BADGE[status].text };
}

export function PlatformStatusBadge({ variant = 'compact' }: Props) {
  const { data, isLoading } = usePlatformStatus();
  const status: CategoryStatus | 'loading' = isLoading || !data ? 'loading' : data.overall;
  // Defensive: status should always be a known PALETTE key, but fall back to
  // the neutral "loading" entry rather than crash if an unexpected value
  // ever slips through (e.g. a malformed API response upstream).
  const palette = paletteFor(status);

  return (
    <div
      data-platform-status={status === 'loading' || !(status in STATUS_BADGE) ? 'loading' : status}
      data-variant={variant}
      style={{ display: 'flex', alignItems: 'center', gap: variant === 'prominent' ? 9 : 8 }}
    >
      <span
        aria-hidden
        style={{ width: 8, height: 8, borderRadius: '50%', background: palette.dot, flexShrink: 0 }}
      />
      <span
        role="status"
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
