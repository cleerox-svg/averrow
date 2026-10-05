import type { ReactElement } from 'react';
import { cn } from './cn';

/**
 * The one spinner (settings rows + overlay confirm buttons). Functional, so
 * tokens.css keeps it turning (slower) under prefers-reduced-motion.
 */
export function Spinner({ size = 16, className }: { size?: number; className?: string }): ReactElement {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      data-testid="ds-spinner"
      className={cn('animate-spin shrink-0', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
    >
      <circle cx="12" cy="12" r="9" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  );
}
