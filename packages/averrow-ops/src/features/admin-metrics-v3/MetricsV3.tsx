// /admin/metrics-v3 — preview surface for the next-gen Metrics page.
//
// First scaffold mirrors the agents-v3 / feeds-v3 first-cut pattern:
// reuse the existing five section components for data parity, add
// the VersionToggle in the page header, and ship a "v3 preview"
// banner explaining what's experimental.
//
// What's experimental in v3 (vs v2):
//   - "Summary" default tab showing top-level numbers from all five
//     sections — answers "is everything healthy?" without tab-flipping
//   - Same tabbed deep-dive when an operator wants a specific area
//
// Iterate from screenshots — this gets the toggle wired and a real
// page to A/B against; subsequent PRs can rework individual section
// layouts (e.g. denser D1 budget gauges, AI-spend heatmap, geo
// coverage map, feed-failures triage queue).

import { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAgents } from '@/hooks/useAgents';
import {
  Card, PageHeader, Tabs,
} from '@/design-system/components';
import { VersionToggle } from '@/components/ui/VersionToggle';
import { LiveIndicator } from '@/components/ui/LiveIndicator';
import { D1BudgetSection }     from '@/features/admin/metrics/D1Budget';
import { AiSpendSection }      from '@/features/admin/metrics/AiSpend';
import { GeoCoverageSection }  from '@/features/admin/metrics/GeoCoverage';
import { FeedFailuresSection } from '@/features/admin/metrics/FeedFailures';
import { PipelinesV3 }         from './PipelinesV3';

type TabId =
  | 'summary'
  | 'pipelines'
  | 'd1-budget'
  | 'ai-spend'
  | 'geo-coverage'
  | 'feed-failures';

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'summary',       label: 'Summary'       },
  { id: 'pipelines',     label: 'Pipelines'     },
  { id: 'd1-budget',     label: 'D1 Budget'     },
  { id: 'ai-spend',      label: 'AI Spend'      },
  { id: 'geo-coverage',  label: 'Geo Coverage'  },
  { id: 'feed-failures', label: 'Feed Failures' },
];

const DEFAULT_TAB: TabId = 'summary';

function isValidTabId(s: string | null): s is TabId {
  return !!s && TABS.some((t) => t.id === s);
}

function PreviewBanner() {
  return (
    <Card variant="elevated" className="p-4">
      <div className="flex items-start gap-3">
        <div
          className="flex-shrink-0 w-8 h-8 rounded-md grid place-items-center"
          style={{ background: 'var(--amber-glow)', color: 'var(--amber)' }}
        >
          v3
        </div>
        <div className="min-w-0">
          <div className="font-mono text-[10px] tracking-[0.18em] uppercase mb-1" style={{ color: 'var(--amber)' }}>
            Metrics · v3 preview
          </div>
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            New <span style={{ color: 'var(--text-primary)' }}>Summary</span> tab
            stacks all five sections at a glance. Same data as <Link to="/admin/metrics"
            className="underline" style={{ color: 'var(--amber)' }}>V2</Link>; iterating
            from screenshots — toggle back any time, your choice persists.
          </p>
        </div>
      </div>
    </Card>
  );
}

// Stacks every section in a single scroll so the operator can answer
// "is everything healthy?" without tab-flipping. Lazy data fetching
// is preserved — each section owns its own hook, and TanStack Query
// caches results across mounts so flipping back to a tab doesn't
// refetch.
function SummaryView({ agents }: { agents: ReturnType<typeof useAgents>['data'] }) {
  return (
    <div className="space-y-6">
      <SummaryBlock label="Pipelines">
        <PipelinesV3 agents={agents ?? []} />
      </SummaryBlock>
      <SummaryBlock label="D1 Budget">
        <D1BudgetSection />
      </SummaryBlock>
      <SummaryBlock label="AI Spend">
        <AiSpendSection />
      </SummaryBlock>
      <SummaryBlock label="Geo Coverage">
        <GeoCoverageSection />
      </SummaryBlock>
      <SummaryBlock label="Feed Failures">
        <FeedFailuresSection />
      </SummaryBlock>
    </div>
  );
}

function SummaryBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <div className="font-mono text-[10px] tracking-[0.20em] uppercase font-bold" style={{ color: 'var(--text-primary)' }}>
        {label}
      </div>
      {children}
    </div>
  );
}

export function MetricsV3() {
  const { data: agents = [] } = useAgents();
  const [searchParams, setSearchParams] = useSearchParams();

  const tabParam = searchParams.get('tab');
  const activeTab: TabId = isValidTabId(tabParam) ? tabParam : DEFAULT_TAB;

  // Normalize the URL on first render: if the user landed without
  // a tab param (or with a bogus one), rewrite to ?tab=summary so
  // bookmarks always carry the explicit selection.
  useEffect(() => {
    if (tabParam !== activeTab) {
      const next = new URLSearchParams(searchParams);
      next.set('tab', activeTab);
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabParam]);

  const onChange = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', id);
    setSearchParams(next);
  };

  return (
    <div className="px-4 sm:px-6 py-4 space-y-4 max-w-7xl mx-auto">
      <PageHeader
        title="Metrics"
        subtitle="v3 preview · Summary + tabbed deep-dives"
        actions={
          <div className="flex items-center gap-3">
            <VersionToggle surface="metrics" ariaLabel="Metrics page version" />
            <LiveIndicator />
          </div>
        }
      />

      <PreviewBanner />

      <Tabs
        tabs={TABS.map((t) => ({ id: t.id, label: t.label }))}
        activeTab={activeTab}
        onChange={onChange}
        variant="pills"
      />

      {activeTab === 'summary'       && <SummaryView agents={agents} />}
      {activeTab === 'pipelines'     && <PipelinesV3 agents={agents} />}
      {activeTab === 'd1-budget'     && <D1BudgetSection />}
      {activeTab === 'ai-spend'      && <AiSpendSection />}
      {activeTab === 'geo-coverage'  && <GeoCoverageSection />}
      {activeTab === 'feed-failures' && <FeedFailuresSection />}
    </div>
  );
}
