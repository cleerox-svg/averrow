// Metrics — admin-only ops dashboard.
//
// Five tabbed sections:
//   1. Pipelines     — Pipeline Automation grid (moved from Agents)
//   2. D1 Budget     — daily / monthly meters + top queries / endpoints
//   3. AI Spend      — 24h/7d/30d windows + 30d daily-cost bar chart
//   4. Geo Coverage  — coverage % windows + 30d trend + exhausted pile
//   5. Feed Failures — per-feed pull stats + auto-pause risk + errors
//
// Tab selection is URL-encoded as `?tab=<id>` so an operator can deep-
// link to a specific view (handy when sharing a triage link). The tab
// component is the same `Tabs` primitive used on /agents.

import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAgents } from '@/hooks/useAgents';
import { PageHeader, Tabs } from '@/design-system/components';
import { VersionToggle } from '@/components/ui/VersionToggle';
import {
  PipelineAutomationSection,
} from './metrics/PipelineAutomation';
import { D1BudgetSection }    from './metrics/D1Budget';
import { AiSpendSection }     from './metrics/AiSpend';
import { GeoCoverageSection } from './metrics/GeoCoverage';
import { FeedFailuresSection } from './metrics/FeedFailures';

type TabId = 'pipelines' | 'd1-budget' | 'ai-spend' | 'geo-coverage' | 'feed-failures';

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'pipelines',     label: 'Pipelines'     },
  { id: 'd1-budget',     label: 'D1 Budget'     },
  { id: 'ai-spend',      label: 'AI Spend'      },
  { id: 'geo-coverage',  label: 'Geo Coverage'  },
  { id: 'feed-failures', label: 'Feed Failures' },
];

const DEFAULT_TAB: TabId = 'pipelines';

function isValidTabId(s: string | null): s is TabId {
  return !!s && TABS.some((t) => t.id === s);
}

export function Metrics() {
  const { data: agents = [] } = useAgents();
  const [searchParams, setSearchParams] = useSearchParams();

  const tabParam = searchParams.get('tab');
  const activeTab: TabId = isValidTabId(tabParam) ? tabParam : DEFAULT_TAB;

  // Normalize the URL on first render: if the user landed without
  // a tab param (or with a bogus one), rewrite to ?tab=pipelines so
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
        subtitle="Platform operations · Pipelines · D1 budget · AI spend · Geo coverage · Feed health"
        actions={<VersionToggle surface="metrics" ariaLabel="Metrics page version" />}
      />

      <Tabs
        tabs={TABS.map((t) => ({ id: t.id, label: t.label }))}
        activeTab={activeTab}
        onChange={onChange}
        variant="pills"
      />

      {/* Only the active tab's section renders. Each section
          fetches its own data via its own hook, so switching tabs
          doesn't refetch anything that's still warm in TanStack
          Query's cache. */}
      {activeTab === 'pipelines'     && <PipelineAutomationSection agents={agents} />}
      {activeTab === 'd1-budget'     && <D1BudgetSection />}
      {activeTab === 'ai-spend'      && <AiSpendSection />}
      {activeTab === 'geo-coverage'  && <GeoCoverageSection />}
      {activeTab === 'feed-failures' && <FeedFailuresSection />}
    </div>
  );
}
