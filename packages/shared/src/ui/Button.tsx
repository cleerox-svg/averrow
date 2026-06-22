import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';

// Token-native shadcn-pattern button: Radix Slot for `asChild`, cva for
// variants, Tailwind arbitrary-value classes referencing brand CSS vars so
// it renders identically in averrow-ops + averrow-tenant with no Tailwind
// config changes. Touch targets stay >=40px; motion respects reduced-motion.
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] font-semibold tracking-[0.01em] select-none ' +
  'transition-[background,box-shadow,transform,opacity,filter] duration-150 motion-reduce:transition-none ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--amber)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-page)] ' +
  'disabled:opacity-50 disabled:pointer-events-none',
  {
    variants: {
      variant: {
        primary: 'text-[#0A0F1E] [background:linear-gradient(135deg,var(--amber),var(--amber-dim))] shadow-[0_4px_18px_rgba(229,168,50,0.30)] hover:brightness-110 active:brightness-95',
        secondary: 'text-[var(--text-primary)] bg-[var(--bg-card-deep,rgba(14,20,34,0.92))] border border-[var(--border-base)] hover:border-[var(--border-strong)]',
        danger: 'text-white [background:linear-gradient(135deg,var(--red),var(--red-dim))] shadow-[0_4px_18px_rgba(200,60,60,0.30)] hover:brightness-110 active:brightness-95',
        ghost: 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-white/5',
        outline: 'text-[var(--text-primary)] bg-transparent border border-[var(--border-strong)] hover:bg-white/5',
      },
      size: {
        sm: 'h-9 min-h-9 px-3 text-[12px]',
        md: 'h-10 min-h-10 px-4 text-[13px]',
        lg: 'h-12 min-h-12 px-6 text-sm',
        icon: 'h-10 w-10 min-h-10',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
  },
);
Button.displayName = 'Button';

export { buttonVariants };
