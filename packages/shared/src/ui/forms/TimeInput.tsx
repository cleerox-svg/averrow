import * as React from 'react';
import { cn } from '../cn';
import { controlBase } from './Input';
import { useFieldContext, joinIds } from './field-context';

export interface TimeInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  invalid?: boolean;
}

/** Native type="time", Input metrics, tabular-nums (never mono), 15-minute step by default. Spec §4.7. */
export const TimeInput = React.forwardRef<HTMLInputElement, TimeInputProps>(
  ({ className, id, invalid, step = 900, ...props }, ref) => {
    const field = useFieldContext();
    const isInvalid = invalid ?? field?.invalid ?? false;
    return (
      <input
        {...props}
        ref={ref}
        type="time"
        id={id ?? field?.id}
        step={step}
        aria-invalid={isInvalid || undefined}
        aria-describedby={joinIds(props['aria-describedby'], field?.describedBy)}
        className={cn(controlBase, '[font-variant-numeric:tabular-nums] [color-scheme:inherit]', className)}
      />
    );
  },
);
TimeInput.displayName = 'TimeInput';

function parseHHMM(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(v);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Human summary of a quiet window, e.g. ("22:00","07:00") -> "Quiet for 9 hours overnight".
 * Returns null for unparsable input or an empty (start === end) window.
 */
export function describeQuietWindow(start: string, end: string): string | null {
  const s = parseHHMM(start);
  const e = parseHHMM(end);
  if (s === null || e === null || s === e) return null;
  const overnight = e < s;
  const total = overnight ? 24 * 60 - s + e : e - s;
  const h = Math.floor(total / 60);
  const m = total % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h} ${h === 1 ? 'hour' : 'hours'}`);
  if (m > 0) parts.push(`${m} ${m === 1 ? 'minute' : 'minutes'}`);
  return `Quiet for ${parts.join(' ')}${overnight ? ' overnight' : ''}`;
}
