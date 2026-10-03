// Platform pulse: feeds / agents / processing from the public, KV-cached
// platform-status rollup. The existing PlatformStatusFlyout is the header bar;
// clicking it opens the availability breakdown. It sits OUTSIDE the Card
// because the Card clips overflow and the flyout is absolutely positioned.
//
// There is deliberately no "AI calls" cell or AI-mode note: `ai_health` only
// exists in super-admin diagnostics, and a hardcoded mode label would go stale
// the moment AI_MODE flips.

import { Badge, Card, PageState } from '@/design-system/components';
import type { BadgeStatus } from '@/design-system/components';
import type { CategoryRollup, CategoryStatus } from '@averrow/shared';
import { CATEGORY_LABELS } from '@averrow/shared';
import { PlatformStatusFlyout } from '@/components/PlatformStatusFlyout';
import { usePlatformStatus } from '@/hooks/usePlatformStatus';

const BADGE: Record<CategoryStatus, { status: BadgeStatus; label: string }> = {
  operational: { status: 'healthy', label: 'Operational' },
  degraded: { status: 'degraded', label: 'Degraded' },
  outage: { status: 'failed', label: 'Outage' },
};

function Cell({ rollup }: { rollup: CategoryRollup }) {
  const b = BADGE[rollup.realtime];
  return (
    <div className="min-w-0" data-pulse-cell={rollup.category}>
      <div className="font-mono text-[9px] uppercase tracking-widest" style={{ color: 'var(--text-secondary)' }}>
        {CATEGORY_LABELS[rollup.category]}
      </div>
      <div className="mt-1.5"><Badge status={b.status} label={b.label} size="xs" /></div>
      <div className="mt-1.5 font-mono text-[10px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
        {rollup.realtime_note || `${rollup.uptime_30d_pct.toFixed(1)}% 30-day uptime`}
      </div>
    </div>
  );
}

export function PlatformPulse() {
  const { data, isLoading, refetch } = usePlatformStatus();

  return (
    <section aria-labelledby="home-pulse-title" className="flex flex-col gap-3">
      <h2
        id="home-pulse-title"
        className="font-mono text-[10px] font-bold uppercase tracking-[0.18em]"
        style={{ color: 'var(--text-secondary)', margin: 0 }}
      >
        Platform pulse
      </h2>
      <PlatformStatusFlyout />
      <Card padding="md">
        {isLoading && <PageState kind="loading" layout="inline" compact title="Checking platform status…" />}
        {!isLoading && !data && (
          <PageState
            kind="error"
            layout="inline"
            compact
            assertive
            title="Platform status unavailable"
            onRetry={() => { void refetch(); }}
          />
        )}
        {data && (
          <div className="grid grid-cols-3 gap-3">
            {data.categories.map((c) => <Cell key={c.category} rollup={c} />)}
          </div>
        )}
      </Card>
    </section>
  );
}
