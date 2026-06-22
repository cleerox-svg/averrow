import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';

// Unified severity + status badge (mirrors the existing Badge API so it's a
// drop-in during the v4 migration). Severity neons via brand tokens.
const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full font-mono uppercase tracking-[0.08em] whitespace-nowrap border',
  {
    variants: {
      severity: {
        critical: 'text-[var(--sev-critical)] bg-[rgba(248,113,113,0.12)] border-[rgba(248,113,113,0.30)]',
        high: 'text-[var(--sev-high)] bg-[rgba(251,146,60,0.12)] border-[rgba(251,146,60,0.30)]',
        medium: 'text-[var(--sev-medium)] bg-[rgba(251,191,36,0.12)] border-[rgba(251,191,36,0.28)]',
        low: 'text-[var(--sev-low)] bg-[rgba(96,165,250,0.12)] border-[rgba(96,165,250,0.28)]',
        neutral: 'text-[var(--text-secondary)] bg-white/5 border-[var(--border-base)]',
        active: 'text-[var(--green)] bg-[rgba(60,184,120,0.12)] border-[rgba(60,184,120,0.30)]',
      },
      size: {
        sm: 'text-[9px] px-2 py-0.5',
        md: 'text-[10px] px-2.5 py-1',
      },
    },
    defaultVariants: { severity: 'neutral', size: 'md' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  /** Render a glowing severity dot before the label. */
  dot?: boolean;
}

const dotColor: Record<string, string> = {
  critical: 'var(--sev-critical)', high: 'var(--sev-high)', medium: 'var(--sev-medium)',
  low: 'var(--sev-low)', active: 'var(--green)', neutral: 'var(--text-tertiary)',
};

export function Badge({ className, severity, size, dot, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ severity, size }), className)} {...props}>
      {dot && (
        <span
          aria-hidden
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: dotColor[severity ?? 'neutral'], boxShadow: `0 0 8px ${dotColor[severity ?? 'neutral']}` }}
        />
      )}
      {children}
    </span>
  );
}

export { badgeVariants };
