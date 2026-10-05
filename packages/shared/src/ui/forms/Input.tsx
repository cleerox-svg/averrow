import * as React from 'react';
import { cn } from '../cn';
import { useFieldContext, useFieldControlId, joinIds } from './field-context';
import { FOCUS_FIELD } from './focus';

/** Shared control chrome (Input / Select / TimeInput) — spec §4.5. */
export const controlBase =
  'w-full h-[44px] box-border rounded-[10px] px-[14px] text-[16px] min-[768px]:text-[15px] ' +
  'bg-[var(--bg-input)] border border-[var(--border-base)] text-[var(--text-primary)] ' +
  'placeholder:text-[var(--text-tertiary)] outline-none ' +
  'transition-[border-color,box-shadow] duration-[120ms] motion-reduce:transition-none ' +
  FOCUS_FIELD + ' ' +
  'aria-[invalid=true]:border-[var(--sev-critical-border)] aria-[invalid=true]:focus:border-[var(--sev-critical)] ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

export const controlReadOnly =
  'read-only:bg-[var(--bg-card-deep)] read-only:text-[var(--text-secondary)] read-only:focus:shadow-none';

export function LockIcon(): React.ReactElement {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Error state (border + aria-invalid). Inherited from <Field error> when omitted. */
  invalid?: boolean;
  /** Trailing lock icon. Defaults to true when readOnly. */
  lockIcon?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, id, invalid, lockIcon, readOnly, ...props }, ref) => {
    const field = useFieldContext();
    const controlId = useFieldControlId(id);
    const isInvalid = invalid ?? field?.invalid ?? false;
    const showLock = lockIcon ?? Boolean(readOnly);
    return (
      <div className="relative w-full">
        <input
          {...props}
          ref={ref}
          id={controlId}
          readOnly={readOnly}
          aria-invalid={isInvalid || undefined}
          aria-describedby={joinIds(props['aria-describedby'], field?.describedBy)}
          className={cn(controlBase, controlReadOnly, showLock && 'pr-[42px]', className)}
        />
        {showLock ? (
          <span className="pointer-events-none absolute right-[14px] top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]">
            <LockIcon />
          </span>
        ) : null}
      </div>
    );
  },
);
Input.displayName = 'Input';
