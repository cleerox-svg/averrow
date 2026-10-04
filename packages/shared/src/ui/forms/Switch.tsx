import * as React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cn } from '../cn';
import { useFieldContext, joinIds } from './field-context';

// Desktop = >=1024px AND a fine pointer. Everything else (mobile, tablets,
// touch laptops) gets the large 52x32 track.
const DESKTOP = '[@media(min-width:1024px)_and_(pointer:fine)]';

export type SwitchProps = Omit<React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>, 'children'>;

/** Radix switch, spec §4.3. Name it with aria-labelledby/aria-label (the row title). */
export const Switch = React.forwardRef<React.ElementRef<typeof SwitchPrimitive.Root>, SwitchProps>(
  ({ className, id, ...props }, ref) => {
    const field = useFieldContext();
    return (
      <SwitchPrimitive.Root
        {...props}
        ref={ref}
        id={id ?? field?.id}
        aria-describedby={joinIds(props['aria-describedby'], field?.describedBy)}
        className={cn(
          'group relative inline-flex shrink-0 cursor-pointer items-center rounded-full border border-[var(--border-strong)] box-border',
          'h-[32px] w-[52px] px-[3px]',
          `${DESKTOP}:h-[26px] ${DESKTOP}:w-[44px] ${DESKTOP}:px-[2px]`,
          // >=44px hit area via an invisible inset pseudo-element.
          "before:absolute before:content-[''] before:inset-[-6px]",
          `${DESKTOP}:before:inset-y-[-9px]`,
          'bg-[color-mix(in_srgb,var(--text-primary)_14%,transparent)]',
          'data-[state=checked]:border-transparent data-[state=checked]:[background:linear-gradient(135deg,var(--amber),var(--amber-dim))]',
          'data-[state=checked]:shadow-[0_0_12px_var(--amber-glow,rgba(229,168,50,0.40))]',
          'transition-[background,box-shadow] duration-[180ms] motion-reduce:transition-none',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring,var(--amber))] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-page)]',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
      >
        <SwitchPrimitive.Thumb
          className={cn(
            'pointer-events-none block h-[24px] w-[24px] rounded-full bg-[#fff] shadow-[0_1px_3px_rgba(0,0,0,0.4)]',
            'translate-x-0 data-[state=checked]:translate-x-[20px]',
            `${DESKTOP}:h-[20px] ${DESKTOP}:w-[20px] ${DESKTOP}:data-[state=checked]:translate-x-[18px]`,
            'transition-transform duration-[180ms] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none',
          )}
        />
      </SwitchPrimitive.Root>
    );
  },
);
Switch.displayName = 'Switch';
