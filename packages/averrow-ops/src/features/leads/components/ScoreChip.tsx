// ScoreChip — unified rendering of Pathfinder's prospect_score.
//
// Replaces the inline 48x48 amber square in KanbanCard and the bare
// integer in the pipeline table with a single chip that scales by
// `size` prop. Color intensity tracks the score so 30-49 is dim,
// 50-69 mid, and 70+ is the saturated amber that signals a hot lead.

import { cn } from '@/lib/cn';

export interface ScoreChipProps {
  score: number;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

function intensity(score: number): { bg: string; border: string } {
  // Amber tinting tracks score buckets: dim (<50), mid (50-69), hot (70+).
  // Three buckets keep the visual grammar legible to a rep skimming the kanban.
  if (score >= 70) return { bg: 'rgba(229,168,50,0.18)', border: 'rgba(229,168,50,0.40)' };
  if (score >= 50) return { bg: 'rgba(229,168,50,0.10)', border: 'rgba(229,168,50,0.25)' };
  return { bg: 'rgba(229,168,50,0.05)', border: 'rgba(229,168,50,0.15)' };
}

const SIZE: Record<NonNullable<ScoreChipProps['size']>, string> = {
  sm: 'w-8 h-8 text-sm',
  md: 'w-10 h-10 text-lg',
  lg: 'w-14 h-14 text-2xl',
};

export function ScoreChip({ score, size = 'md', className }: ScoreChipProps) {
  const tone = intensity(score);
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-lg font-display font-bold',
        SIZE[size],
        className,
      )}
      style={{
        background: tone.bg,
        border: `1px solid ${tone.border}`,
        color: 'var(--amber)',
      }}
      title={`Prospect score: ${score}`}
    >
      {Math.round(score)}
    </span>
  );
}
