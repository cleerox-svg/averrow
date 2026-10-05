import * as React from 'react';
import * as RadioGroup from '@radix-ui/react-radio-group';
import { cn } from '../cn';
import { FOCUS_RING } from './focus';

export interface SegmentedOption {
  value: string;
  label: string;
  /** Optional 16px leading icon (e.g. monitor / moon / sun). */
  icon?: React.ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps
  extends Omit<React.ComponentPropsWithoutRef<typeof RadioGroup.Root>, 'children' | 'onChange' | 'dir'> {
  options: SegmentedOption[];
  /** Stretch to the container width (equal segments either way). */
  fullWidth?: boolean;
}

/** Radix RadioGroup pill selector, spec §4.4. Provide aria-label. Arrow keys rove natively. */
export const SegmentedControl = React.forwardRef<React.ElementRef<typeof RadioGroup.Root>, SegmentedControlProps>(
  ({ options, fullWidth = false, className, ...props }, ref) => (
    <RadioGroup.Root
      ref={ref}
      orientation="horizontal"
      className={cn(
        'grid grid-flow-col auto-cols-fr gap-0 rounded-[12px] p-[3px] box-border',
        'min-h-[44px] [@media(min-width:1024px)_and_(pointer:fine)]:h-[40px] [@media(min-width:1024px)_and_(pointer:fine)]:min-h-0',
        'bg-[var(--bg-card-deep)] border border-[var(--border-base)]',
        fullWidth ? 'w-full' : 'w-fit',
        className,
      )}
      {...props}
    >
      {options.map((o) => (
        <RadioGroup.Item
          key={o.value}
          value={o.value}
          disabled={o.disabled}
          className={cn(
            'inline-flex min-h-[36px] min-w-[72px] items-center [@media(pointer:coarse)]:min-h-[44px] justify-center gap-1.5 rounded-[9px] px-3 text-[13px] font-semibold whitespace-nowrap select-none',
            'text-[var(--text-secondary)] border border-transparent cursor-pointer',
            'transition-[background,color,box-shadow] duration-[120ms] motion-reduce:transition-none',
            'hover:text-[var(--text-primary)]',
            'data-[state=checked]:text-[var(--amber-text,var(--amber))] data-[state=checked]:border-[var(--pill-active-border)]',
            'data-[state=checked]:[background:linear-gradient(135deg,var(--pill-active-fill-1),var(--pill-active-fill-2))]',
            'data-[state=checked]:shadow-[inset_0_1px_0_var(--pill-active-rim)]',
            FOCUS_RING,
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          {o.icon ? (
            <span aria-hidden="true" className="inline-flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:h-4 [&>svg]:w-4">
              {o.icon}
            </span>
          ) : null}
          <span>{o.label}</span>
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  ),
);
SegmentedControl.displayName = 'SegmentedControl';
