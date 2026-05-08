import { relativeTime } from '@/lib/time';

interface AgentAttributionProps {
  agent: string;
  lastRun?: string | null;
  outputCount?: number;
}

export function AgentAttribution({ agent, lastRun, outputCount }: AgentAttributionProps) {
  const timeLabel = lastRun ? relativeTime(lastRun) : null;

  return (
    <div className="flex items-center gap-1.5 text-white/25 text-[10px] font-mono">
      <span className="w-1 h-1 rounded-full bg-amber-500/40" />
      <span>
        Powered by {agent}
        {timeLabel && ` · ${timeLabel}`}
        {outputCount !== undefined && ` · ${outputCount} outputs`}
      </span>
    </div>
  );
}
