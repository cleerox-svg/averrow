import * as React from 'react';
import { cn } from '../cn';
import { FieldContext, useFieldContext } from './field-context';

export type LabelProps = React.LabelHTMLAttributes<HTMLLabelElement>;

/** 13px/600 sentence-case label (14px on mobile). Inside a <Field> it targets the control automatically. */
export const Label = React.forwardRef<HTMLLabelElement, LabelProps>(({ className, htmlFor, ...props }, ref) => {
  const field = useFieldContext();
  return (
    <label
      ref={ref}
      htmlFor={htmlFor ?? field?.id}
      className={cn('block text-[14px] min-[768px]:text-[13px] font-semibold text-[var(--text-primary)]', className)}
      {...props}
    />
  );
});
Label.displayName = 'Label';

export type HelpTextProps = React.HTMLAttributes<HTMLParagraphElement>;

/** 13px tertiary help line. */
export const HelpText = React.forwardRef<HTMLParagraphElement, HelpTextProps>(({ className, ...props }, ref) => (
  <p ref={ref} className={cn('m-0 text-[13px] leading-[1.45] text-[var(--text-tertiary)]', className)} {...props} />
));
HelpText.displayName = 'HelpText';

function AlertIcon(): React.ReactElement {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-[2px] shrink-0">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

export type FieldErrorProps = React.HTMLAttributes<HTMLParagraphElement>;

/** Error message with an icon (never colour alone) and role="alert". */
export const FieldError = React.forwardRef<HTMLParagraphElement, FieldErrorProps>(
  ({ className, children, ...props }, ref) => (
    <p
      ref={ref}
      role="alert"
      className={cn('m-0 flex items-start gap-1.5 text-[13px] leading-[1.45] text-[var(--sev-critical-text)]', className)}
      {...props}
    >
      <AlertIcon />
      <span>{children}</span>
    </p>
  ),
);
FieldError.displayName = 'FieldError';

export interface FieldProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  label: React.ReactNode;
  help?: React.ReactNode;
  error?: React.ReactNode;
  /** Override the generated control id. */
  id?: string;
  /** The control (Input / Select / TimeInput / Switch) — it reads id + aria wiring from context. */
  children: React.ReactNode;
}

/**
 * Wires label (htmlFor), help and error (aria-describedby) to its control
 * automatically via useId. Controls from this kit pick the wiring up from context.
 */
export const Field = React.forwardRef<HTMLDivElement, FieldProps>(
  ({ label, help, error, id, className, children, ...props }, ref) => {
    const generated = React.useId();
    const controlId = id ?? `field-${generated}`;
    const helpId = help ? `${controlId}-help` : undefined;
    const errorId = error ? `${controlId}-error` : undefined;
    const describedBy = [errorId, helpId].filter(Boolean).join(' ') || undefined;
    const ctx = React.useMemo(
      () => ({ id: controlId, describedBy, invalid: Boolean(error) }),
      [controlId, describedBy, error],
    );
    return (
      <FieldContext.Provider value={ctx}>
        <div ref={ref} className={cn('flex flex-col', className)} {...props}>
          <Label className="mb-1.5">{label}</Label>
          {children}
          {help ? <HelpText id={helpId} className="mt-1.5">{help}</HelpText> : null}
          {error ? <FieldError id={errorId} className="mt-1.5">{error}</FieldError> : null}
        </div>
      </FieldContext.Provider>
    );
  },
);
Field.displayName = 'Field';
