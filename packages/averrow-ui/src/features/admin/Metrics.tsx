// Metrics — admin-only ops dashboard.
//
// Phase 1 hosts Pipeline Automation as the first section and stubs
// the four upcoming siblings (D1 Budget, AI Spend, Geo Coverage,
// Feed-Failure Board). Each follow-up PR moves one of those
// sections out of its current location into here and removes the
// original. Rendering them as "coming soon" cards in this PR keeps
// the page structure visible from day one and gives operators a
// consistent place to look for ops health.

import { useAgents } from '@/hooks/useAgents';
import { PageHeader } from '@/design-system/components';
import { Card } from '@/design-system/components';
import {
  PipelineAutomationSection,
} from './metrics/PipelineAutomation';
import { D1BudgetSection } from './metrics/D1Budget';

export function Metrics() {
  const { data: agents = [] } = useAgents();

  return (
    <div className="px-4 sm:px-6 py-4 space-y-6 max-w-7xl mx-auto">
      <PageHeader
        title="Metrics"
        subtitle="Platform operations · Pipelines · D1 budget · AI spend · Geo coverage · Feed health"
      />

      {/* 1. Pipeline Automation — moved from Agents-Monitor. */}
      <PipelineAutomationSection agents={agents} />

      {/* 2. D1 Budget */}
      <D1BudgetSection />

      {/* 3. AI Spend Trend — placeholder, follow-up PR. */}
      <SectionPlaceholder
        title="AI Spend"
        subtitle="Tokens + cost over 24h / 7d / 30d. Per-agent breakdown — Cartographer, Sentinel, Analyst, Alert AI Judge are the usual heavy hitters."
      />

      {/* 4. Geo Coverage Trend — placeholder, follow-up PR. */}
      <SectionPlaceholder
        title="Geo Coverage"
        subtitle="% of threats with lat/lng populated over 24h / 7d / 30d. Tracks Cartographer's enrichment yield against feed inflow."
      />

      {/* 5. Feed-Failure Board — placeholder, follow-up PR. */}
      <SectionPlaceholder
        title="Feed Failures"
        subtitle="Per-feed pull success / failure rate. At-risk feeds (≥60% of consecutive-failure threshold) surface here before auto-pause kicks in."
      />
    </div>
  );
}

function SectionPlaceholder({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <Card style={{ padding: '16px' }}>
      <div className="flex items-center justify-between mb-2">
        <span className="section-label font-mono font-bold">{title}</span>
        <span
          className="font-mono text-[9px] uppercase tracking-wider"
          style={{ color: 'var(--text-tertiary)' }}
        >
          Coming soon
        </span>
      </div>
      <p
        className="font-mono text-[10px] leading-relaxed"
        style={{ color: 'var(--text-muted)' }}
      >
        {subtitle}
      </p>
    </Card>
  );
}
