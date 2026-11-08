// Platform pulse: feeds / agents / processing from the public, KV-cached
// platform-status rollup. The existing PlatformStatusFlyout is the header bar;
// clicking it opens the availability breakdown. It sits OUTSIDE the Card
// because the Card clips overflow and the flyout is absolutely positioned.
//
// There is deliberately no "AI calls" cell or AI-mode note: `ai_health` only
// exists in super-admin diagnostics, and a hardcoded mode label would go stale
// the moment AI_MODE flips.

import { Badge, Card, PageState } from '@/design-system/components';
import type { CategoryRollup } from '@averrow/shared';
import { CATEGORY_LABELS } from '@averrow/shared';
import { PlatformStatusFlyout } from '@/components/PlatformStatusFlyout';
import { STATUS_BADGE } from '@/components/platform-status-ui';
import { HOME_CARD_VARIANT } from '@/features/home/homeCard';
import { usePlatformStatus } from '@/hooks/usePlatformStatus';

function Cell({ rollup }: { rollup: CategoryRollup }) {
  const b = STATUS_BADGE[rollup.realtime];
  return (
    <div className="min-w-0" data-pulse-cell={rollup.category}>
      <div className="home-label">{CATEGORY_LABELS[rollup.category]}</div>
      <div className="mt-1.5"><Badge {...b.tone} label={b.label} size="md" font="sans" /></div>
      <div className="pulse-note">
        {rollup.realtime_note || `${rollup.uptime_30d_pct.toFixed(1)}% 30-day uptime`}
      </div>
    </div>
  );
}

export function PlatformPulse() {
  const { data, isLoading, refetch } = usePlatformStatus();

  return (
    <section aria-labelledby="home-pulse-title" className="flex flex-col gap-3">
      <h2 id="home-pulse-title" className="home-label">Platform pulse</h2>
      <PlatformStatusFlyout />
      <Card variant={HOME_CARD_VARIANT} padding="md">
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
          <div className="pulse-grid">
            {data.categories.map((c) => <Cell key={c.category} rollup={c} />)}
          </div>
        )}
      </Card>
    </section>
  );
}
