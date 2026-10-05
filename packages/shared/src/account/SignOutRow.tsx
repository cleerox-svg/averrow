// Full-width "Sign out" row (mobile settings home + bottom of Profile).
// Centered, danger-coloured text on a glass card; the confirm-less sign out is
// by design (spec §5.1: sign out needs no ConfirmDialog; signing back in is one tap).

import { SettingsGroup } from '../ui/settings';
import { cn } from '../ui/cn';

export interface SignOutRowProps {
  onSignOut: () => void;
  label?: string;
  className?: string;
}

export function SignOutRow({ onSignOut, label = 'Sign out', className }: SignOutRowProps) {
  return (
    <SettingsGroup aria-label="Sign out" className={className}>
      <button
        type="button"
        onClick={onSignOut}
        className={cn(
          'flex min-h-[56px] w-full items-center justify-center rounded-[inherit] px-4 text-[16px] font-semibold',
          'text-[var(--sev-critical-text)] transition-colors duration-[120ms] motion-reduce:transition-none',
          'hover:bg-[var(--sev-critical-bg)] active:bg-[var(--sev-critical-bg)]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring,var(--amber))]',
        )}
      >
        {label}
      </button>
    </SettingsGroup>
  );
}
