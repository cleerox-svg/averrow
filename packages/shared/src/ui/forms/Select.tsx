import * as React from 'react';
import { cn } from '../cn';
import { controlBase } from './Input';
import { useFieldContext, useFieldControlId, joinIds } from './field-context';

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  /** `inline` = auto-width control for a row trailing slot (min 148, 44 mobile / 40 desktop, bg card-deep). */
  variant?: 'default' | 'inline';
  invalid?: boolean;
}

function Chevron(): React.ReactElement {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/** Native <select> with a custom chevron, spec §4.6. Pass <option>s as children. */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, id, variant = 'default', invalid, children, ...props }, ref) => {
    const field = useFieldContext();
    const controlId = useFieldControlId(id);
    const isInvalid = invalid ?? field?.invalid ?? false;
    const inline = variant === 'inline';
    return (
      <div className={cn('relative', inline ? 'ds-select-wrap inline-block min-w-[148px]' : 'w-full')}>
        <select
          {...props}
          ref={ref}
          id={controlId}
          aria-invalid={isInvalid || undefined}
          aria-describedby={joinIds(props['aria-describedby'], field?.describedBy)}
          className={cn(
            controlBase,
            'appearance-none cursor-pointer pr-[40px] [color-scheme:inherit]',
            inline && 'w-auto min-w-[148px] bg-[var(--bg-card-deep)] h-[44px] [@media(min-width:1024px)_and_(pointer:fine)]:h-[40px] text-right [text-align-last:right]',
            className,
          )}
        >
          {children}
        </select>
        <span className="pointer-events-none absolute right-[12px] top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]">
          <Chevron />
        </span>
      </div>
    );
  },
);
Select.displayName = 'Select';
