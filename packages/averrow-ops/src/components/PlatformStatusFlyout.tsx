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
import { Badge } from '@/design-system/components';
import type { BadgeStatus } from '@/design-system/components';
import { usePlatformStatus } from '@/hooks/usePlatformStatus';
import { PlatformStatusBadge } from '@/components/PlatformStatusBadge';
import './platform-status-flyout.css';

const STATUS_BADGE: Record<CategoryStatus, { status: BadgeStatus; label: string }> = {
  operational: { status: 'healthy', label: 'Operational' },
  degraded: { status: 'degraded', label: 'Degraded' },
  outage: { status: 'failed', label: 'Outage' },
};

interface CategoryRowProps { rollup: CategoryRollup }

function CategoryRow({ rollup }: CategoryRowProps) {
  const b = STATUS_BADGE[rollup.realtime];
  return (
    <div className="psf-row">
      <div className="psf-row-main">
        <div className="psf-row-name">{CATEGORY_LABELS[rollup.category]}</div>
        <div className="psf-row-note">
          {rollup.realtime_note || `${rollup.uptime_30d_pct.toFixed(1)}% 30-day uptime`}
        </div>
      </div>
      <div className="psf-row-pct">{rollup.uptime_30d_pct.toFixed(1)}%</div>
      <Badge status={b.status} label={b.label} size="md" font="sans" />
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
    <div ref={wrapperRef} className="psf">
      <button
        type="button"
        className="psf-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
      >
        <PlatformStatusBadge variant="prominent" />
        <ChevronDown size={14} className="psf-chevron" data-open={open} aria-hidden />
      </button>

      {open && (
        <div role="dialog" aria-label="Platform availability" className="psf-panel">
          <div className="psf-head">
            <span className="psf-head-label">Availability · last 30 days</span>
            <span className="psf-head-note">
              {isLoading || !data ? 'Checking…' : data.overall_note}
            </span>
          </div>

          <div>
            {isLoading || !data ? (
              <div className="psf-loading">Loading availability…</div>
            ) : (
              data.categories.map((rollup) => (
                <CategoryRow key={rollup.category} rollup={rollup} />
              ))
            )}
          </div>

          <a href="/status" target="_blank" rel="noopener noreferrer" className="psf-foot">
            View full status →
          </a>
        </div>
      )}
    </div>
  );
}
