// Threat tempo band: the current hourly ingest rate against the 7-day baseline,
// with a 24h sparkline. Reads the same two queries as ThreatInflowChart
// (`['threats','inflow','24h'|'7d']`, `/api/threats/inflow`), so the React Query
// cache, and the worker's KV cache, are shared with /threats. The math lives in
// lib/threat-tempo.ts.

import { PageState, Sparkline, StatTile } from '@/design-system/components';
import { useThreatInflow } from '@/features/threats/useThreatInflow';
import { computeTempo, type Tempo, type TempoState } from '@/lib/threat-tempo';

const STATE_ACCENT: Record<TempoState, string> = {
  surge: 'var(--sev-high)',
  normal: 'var(--blue)',
  quiet: 'var(--text-tertiary)',
  unknown: 'var(--text-tertiary)',
};

export function tempoChipText(t: Tempo): string {
  if (t.ratio === null) {
    return t.state === 'quiet' ? 'quiet · no ingest in 7d' : 'baseline unavailable';
  }
  const x = `${t.ratio.toFixed(1)}× baseline`;
  return t.state === 'quiet' ? `quiet · ${x}` : x;
}

function Chip({ tempo }: { tempo: Tempo }) {
  const surge = tempo.state === 'surge';
  return (
    <span
      data-tempo-state={tempo.state}
      className="inline-flex items-center rounded-full px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider"
      style={{
        color: surge ? 'var(--sev-high-text)' : 'var(--text-secondary)',
        background: surge ? 'var(--sev-high-bg)' : 'var(--border-base)',
        border: `1px solid ${surge ? 'var(--sev-high)' : 'var(--border-strong)'}`,
      }}
    >
      {tempoChipText(tempo)}
    </span>
  );
}

export function TempoBand() {
  const day = useThreatInflow('24h');
  const week = useThreatInflow('7d');

  // A failed window with nothing cached is an error: never a 0/hr "calm" reading.
  const failed = (day.isError && !day.data) || (week.isError && !week.data);
  if (failed) {
    return (
      <PageState
        kind="error"
        layout="card"
        compact
        title="Couldn't load threat tempo"
        onRetry={() => {
          void day.refetch();
          void week.refetch();
        }}
      />
    );
  }

  const tempo = day.data && week.data ? computeTempo(day.data, week.data) : null;
  const loading = !tempo && (day.isLoading || week.isLoading || !day.data || !week.data);

  if (loading) {
    return <StatTile label="Threat tempo · last hour" value={null} />;
  }
  if (!tempo) {
    // Loaded, but the 24h window has no completed hour to read.
    return <PageState kind="empty" layout="card" compact title="No threat tempo yet" description="The ingest window has no completed hour." />;
  }

  return (
    <StatTile
      label="Threat tempo · last hour"
      value={Math.round(tempo.currentRate)}
      accent={STATE_ACCENT[tempo.state]}
      sub={tempo.baselineRate !== null
        ? `threats/hr · 7d baseline ${Math.round(tempo.baselineRate).toLocaleString()}/hr`
        : 'threats/hr'}
      footer={(
        <span className="flex items-center gap-3">
          <Chip tempo={tempo} />
          <span className="min-w-0 flex-1">
            <Sparkline
              data={tempo.sparkline}
              fill
              height={36}
              color={STATE_ACCENT[tempo.state]}
              baseline="zero"
              label="Threats ingested per hour, last 24 hours"
            />
          </span>
        </span>
      )}
    />
  );
}
