// Live status badge — replaces the static "ALL SYSTEMS OPERATIONAL"
// pill on Home that lied for 82 hours during the Apr 30 - May 2 ingest
// blackout. Reads usePlatformStatus(), which polls /api/v1/public/
// platform-status every 60s.
//
// Two visual sizes:
//   compact — for the desktop Home header (small mono pill)
//   prominent — for the mobile Command Center status bar (larger
//               pulsing dot + label, matches the existing layout)
//
// Color palette uses --sev-* tokens already defined in tokens.css so
// light/dark themes track without overrides.

import { Link } from 'react-router-dom';
import type { CategoryStatus } from '@averrow/shared';
import { usePlatformStatus } from '@/hooks/usePlatformStatus';

interface Props {
  variant?: 'compact' | 'prominent';
  /** When true, the pill links to /v2/admin/diagnostics. Default false. */
  linkToDiagnostics?: boolean;
}

interface PaletteEntry {
  label: string;
  dot: string;
  glow: string;
  text: string;
}

// Palette tuned to match the existing severity badge colors in
// tokens.css (--sev-info / --sev-medium / --sev-critical).
const PALETTE: Record<CategoryStatus | 'loading', PaletteEntry> = {
  operational: {
    label: 'ALL SYSTEMS OPERATIONAL',
    dot: '#22c55e',
    glow: 'rgba(34,197,94,0.9)',
    text: '#4ade80',
  },
  degraded: {
    label: 'DEGRADED',
    dot: '#fbbf24',
    glow: 'rgba(251,191,36,0.9)',
    text: '#fcd34d',
  },
  outage: {
    label: 'OUTAGE',
    dot: '#f87171',
    glow: 'rgba(248,113,113,0.9)',
    text: '#fca5a5',
  },
  loading: {
    label: 'CHECKING…',
    dot: '#9ca3af',
    glow: 'rgba(156,163,175,0.6)',
    text: '#9ca3af',
  },
};

export function PlatformStatusBadge({ variant = 'compact', linkToDiagnostics = false }: Props) {
  const { data, isLoading } = usePlatformStatus();
  const status: CategoryStatus | 'loading' = isLoading || !data ? 'loading' : data.overall;
  // Defensive: status should always be a known PALETTE key, but fall back to
  // the neutral "loading" entry rather than crash if an unexpected value
  // ever slips through (e.g. a malformed API response upstream).
  const palette = PALETTE[status] ?? PALETTE.loading;

  // Prominent variant — used on mobile Command Center. Mirrors the
  // existing layout in MobileCommandCenter.tsx (pulse dot + label
  // text, both styled in monospace).
  if (variant === 'prominent') {
    const content = (
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <div style={{ position: 'relative', width: 8, height: 8 }}>
          <div
            style={{
              position: 'absolute', inset: 0, borderRadius: '50%',
              background: palette.dot, opacity: 0.6,
              animation: status === 'operational' ? 'mcc-ping 1.6s ease-in-out infinite' : 'mcc-ping 1s ease-in-out infinite',
            }}
          />
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: palette.dot, boxShadow: `0 0 8px ${palette.glow}` }} />
        </div>
        <span style={{
          fontSize: 10, fontFamily: 'monospace', fontWeight: 700,
          letterSpacing: '0.14em', color: palette.text,
          textShadow: `0 0 10px ${palette.glow.replace('0.9', '0.5')}`,
        }}>
          {palette.label}
        </span>
      </div>
    );
    return linkToDiagnostics
      ? <Link to="/admin/diagnostics" style={{ textDecoration: 'none' }}>{content}</Link>
      : content;
  }

  // Compact variant — used on desktop Home. Smaller pill, no pulse
  // ring, since it sits next to the page title and shouldn't shout.
  const content = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span
        style={{
          width: 8, height: 8, borderRadius: '50%',
          background: palette.dot,
          boxShadow: `0 0 8px ${palette.glow}`,
          animation: status === 'operational' ? 'mcc-ping 2s ease-in-out infinite' : 'mcc-ping 1s ease-in-out infinite',
        }}
      />
      <span
        style={{
          fontSize: 10, fontFamily: 'var(--font-mono)',
          color: palette.text, letterSpacing: '0.14em',
          textTransform: 'uppercase',
        }}
      >
        {palette.label}
      </span>
    </div>
  );
  return linkToDiagnostics
    ? <Link to="/admin/diagnostics" style={{ textDecoration: 'none' }}>{content}</Link>
    : content;
}
