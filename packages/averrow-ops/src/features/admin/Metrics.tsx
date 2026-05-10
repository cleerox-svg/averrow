// /admin/metrics — operator metrics dashboard.
//
// 6-tab layout, default = Summary (stacks all 5 sections so a
// glance answers "is everything healthy?"). Other tabs are focused
// deep-dives.
//
// v2 was decommissioned in favour of this layout — see git history
// for the original v2 + v3 toggle pattern.

import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAgents } from '@/hooks/useAgents';
import {
  PageHeader, Tabs,
} from '@/design-system/components';
import { LiveIndicator } from '@/components/ui/LiveIndicator';
import { Pipelines }         from './metrics/Pipelines';
import { D1Budget }          from './metrics/D1Budget';
import { AiSpend }           from './metrics/AiSpend';
import { GeoCoverage }       from './metrics/GeoCoverage';
import { FeedFailures }      from './metrics/FeedFailures';

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

// Stacks every section in a single scroll so the operator can answer
// "is everything healthy?" without tab-flipping. Lazy data fetching
// is preserved — each section owns its own hook, and TanStack Query
// caches results across mounts so flipping back to a tab doesn't
// refetch.
function SummaryView({ agents }: { agents: ReturnType<typeof useAgents>['data'] }) {
  return (
    <div className="space-y-6">
      <SummaryBlock label="Pipelines">
        <Pipelines agents={agents ?? []} />
      </SummaryBlock>
      <SummaryBlock label="D1 Budget">
        <D1Budget />
      </SummaryBlock>
      <SummaryBlock label="AI Spend">
        <AiSpend />
      </SummaryBlock>
      <SummaryBlock label="Geo Coverage">
        <GeoCoverage />
      </SummaryBlock>
      <SummaryBlock label="Feed Failures">
        <FeedFailures />
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

export function Metrics() {
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
        subtitle="Platform operations · Summary + tabbed deep-dives"
        actions={<LiveIndicator />}
      />

      <Tabs
        tabs={TABS.map((t) => ({ id: t.id, label: t.label }))}
        activeTab={activeTab}
        onChange={onChange}
        variant="pills"
      />

      {activeTab === 'summary'       && <SummaryView agents={agents} />}
      {activeTab === 'pipelines'     && <Pipelines agents={agents} />}
      {activeTab === 'd1-budget'     && <D1Budget />}
      {activeTab === 'ai-spend'      && <AiSpend />}
      {activeTab === 'geo-coverage'  && <GeoCoverage />}
      {activeTab === 'feed-failures' && <FeedFailures />}
    </div>
  );
}
