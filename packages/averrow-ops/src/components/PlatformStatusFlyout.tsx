// PlatformStatusFlyout — clickable status bar that expands inline
// to show a condensed availability breakdown for Feeds / Agents /
// Processing. Drop-in replacement for the Card-wrapped
// PlatformStatusBadge prominent on Home.
//
// Intentionally scoped to availability — NO incidents render here
// (operator: "just the availability fly out"). Operators click
// "View full status →" if they want the full /status surface
// including incidents and the 30-day bars.

import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { CategoryRollup, CategoryStatus } from '@averrow/shared';
import { CATEGORY_LABELS } from '@averrow/shared';
import { usePlatformStatus } from '@/hooks/usePlatformStatus';
import { PlatformStatusBadge } from '@/components/PlatformStatusBadge';

const PILL_BG: Record<CategoryStatus, string> = {
  operational: 'rgba(34,197,94,0.10)',
  degraded:    'rgba(251,191,36,0.10)',
  outage:      'rgba(248,113,113,0.10)',
};
const PILL_BORDER: Record<CategoryStatus, string> = {
  operational: 'rgba(34,197,94,0.35)',
  degraded:    'rgba(251,191,36,0.35)',
  outage:      'rgba(248,113,113,0.35)',
};
const PILL_TEXT: Record<CategoryStatus, string> = {
  operational: '#22c55e',
  degraded:    '#fbbf24',
  outage:      '#f87171',
};

const STATUS_LABEL: Record<CategoryStatus, string> = {
  operational: 'Operational',
  degraded:    'Degraded',
  outage:      'Outage',
};

interface CategoryRowProps { rollup: CategoryRollup }

function CategoryRow({ rollup }: CategoryRowProps) {
  const status = rollup.realtime;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 14px',
      borderTop: '1px solid var(--border-base)',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, fontWeight: 600, color: 'var(--text-primary)',
          fontFamily: 'var(--font-display)',
        }}>
          {CATEGORY_LABELS[rollup.category]}
        </div>
        <div style={{
          fontSize: 10, color: 'var(--text-muted)',
          fontFamily: 'var(--font-mono)',
          marginTop: 1,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {rollup.realtime_note || `${rollup.uptime_30d_pct.toFixed(1)}% 30-day uptime`}
        </div>
      </div>
      <div style={{
        fontSize: 10, fontFamily: 'var(--font-mono)',
        color: 'var(--text-tertiary)', flexShrink: 0, minWidth: 56,
        textAlign: 'right',
      }}>
        {rollup.uptime_30d_pct.toFixed(1)}%
      </div>
      <span style={{
        fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700,
        letterSpacing: '0.08em', textTransform: 'uppercase',
        padding: '3px 8px', borderRadius: 100,
        background: PILL_BG[status],
        border: `1px solid ${PILL_BORDER[status]}`,
        color: PILL_TEXT[status],
        flexShrink: 0,
      }}>
        {STATUS_LABEL[status]}
      </span>
    </div>
  );
}

export function PlatformStatusFlyout() {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { data, isLoading } = usePlatformStatus();

  // Close on outside click — operator workflow expects clicking
  // anywhere else on the page to dismiss the flyout.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEscape);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        style={{
          width: '100%',
          padding: '11px 16px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 10,
          background: 'var(--bg-card, rgba(22,30,48,0.65))',
          border: '1px solid var(--border-base, var(--border-base))',
          borderRadius: 12,
          color: 'inherit',
          cursor: 'pointer',
          textAlign: 'left',
          transition: 'border-color 0.15s ease, transform 0.05s ease',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'rgba(229,168,50,0.20)')}
        onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border-base, var(--border-base))')}
      >
        <PlatformStatusBadge variant="prominent" />
        <ChevronDown
          size={14}
          style={{
            color: 'var(--text-tertiary)',
            transition: 'transform 0.18s ease',
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Platform availability"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            // Wide enough for "X.XX% 30-day uptime" without truncation,
            // narrower than the bar so it reads as a flyout, not a
            // page section. Clamps to viewport on small windows.
            width: 'min(420px, calc(100vw - 64px))',
            zIndex: 60,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-base)',
            borderRadius: 12,
            backdropFilter: 'blur(14px)',
            WebkitBackdropFilter: 'blur(14px)',
            boxShadow: 'var(--card-shadow)',
            overflow: 'hidden',
            animation: 'platform-flyout-in 0.15s ease',
          }}
        >
          {/* Header */}
          <div style={{
            padding: '12px 14px',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <span style={{
              fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700,
              letterSpacing: '0.20em', color: 'var(--text-tertiary)',
              textTransform: 'uppercase',
            }}>
              Availability · Last 30 days
            </span>
            <span style={{
              fontFamily: 'var(--font-mono)', fontSize: 10,
              color: 'var(--text-muted)',
            }}>
              {isLoading || !data ? 'checking…' : data.overall_note}
            </span>
          </div>

          {/* Per-category rows */}
          <div>
            {isLoading || !data ? (
              <div style={{
                padding: '24px 14px',
                fontFamily: 'var(--font-mono)', fontSize: 11,
                color: 'var(--text-tertiary)', textAlign: 'center',
                borderTop: '1px solid var(--border-base)',
              }}>
                Loading availability…
              </div>
            ) : (
              data.categories.map((rollup) => (
                <CategoryRow key={rollup.category} rollup={rollup} />
              ))
            )}
          </div>

          {/* Footer */}
          <a
            href="/status"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'block',
              padding: '10px 14px',
              borderTop: '1px solid var(--border-base)',
              fontFamily: 'var(--font-mono)', fontSize: 10,
              fontWeight: 700, letterSpacing: '0.10em',
              color: 'var(--amber)', textDecoration: 'none',
              textTransform: 'uppercase', textAlign: 'center',
            }}
          >
            View full status →
          </a>
        </div>
      )}

      <style>{`
        @keyframes platform-flyout-in {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
