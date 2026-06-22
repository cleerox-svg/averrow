import * as React from 'react';
import { cn } from './cn';

// Cinematic glass card. `variant` controls elevation/glow; fully fluid width
// so it reflows in any responsive grid. Brand tokens via arbitrary-value
// Tailwind classes (portable across both apps, no config changes).
type CardVariant = 'base' | 'elevated' | 'glow' | 'critical';

export const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { variant?: CardVariant }
>(({ className, variant = 'base', ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      'rounded-2xl border border-[var(--border-base)] [background:linear-gradient(160deg,var(--bg-card),var(--bg-card-deep,var(--bg-card)))]',
      variant === 'elevated' && 'shadow-[0_24px_64px_rgba(0,0,0,0.45)]',
      variant === 'glow' && 'border-[rgba(229,168,50,0.25)] shadow-[0_0_28px_rgba(229,168,50,0.16)]',
      variant === 'critical' && 'border-[rgba(200,60,60,0.30)] shadow-[0_0_28px_rgba(200,60,60,0.18)]',
      className,
    )}
    {...props}
  />
));
Card.displayName = 'Card';

export const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex items-center justify-between gap-3 px-4 py-3.5 sm:px-5 border-b border-[var(--border-base)]', className)} {...props} />
  ),
);
CardHeader.displayName = 'CardHeader';

export const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h3 ref={ref} className={cn('text-[13px] font-bold tracking-[0.01em] text-[var(--text-primary)]', className)} {...props} />
  ),
);
CardTitle.displayName = 'CardTitle';

export const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('p-4 sm:p-5', className)} {...props} />
  ),
);
CardContent.displayName = 'CardContent';

export const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex items-center gap-3 px-4 py-3.5 sm:px-5 border-t border-[var(--border-base)]', className)} {...props} />
  ),
);
CardFooter.displayName = 'CardFooter';
