import { relativeTime } from '@/lib/time';

interface AgentAttributionProps {
  agent: string;
  lastRun?: string | null;
  outputCount?: number;
}

export function AgentAttribution({ agent, lastRun, outputCount }: AgentAttributionProps) {
  const timeLabel = lastRun ? relativeTime(lastRun) : null;

  return (
    <div className="flex items-center gap-1.5 text-type-label font-normal" style={{ color: 'var(--text-tertiary)' }}>
      <span aria-hidden="true" className="h-1 w-1 shrink-0 rounded-full" style={{ background: 'var(--text-muted)' }} />
      <span>
        Powered by {agent}
        {timeLabel && ` · ${timeLabel}`}
        {outputCount !== undefined && ` · ${outputCount} outputs`}
      </span>
    </div>
  );
}
