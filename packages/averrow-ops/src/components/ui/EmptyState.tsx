import { ReactNode } from 'react';

/**
 * EmptyState variant semantics. The original four (clean / scanning
 * / error / locked) describe the visual treatment; the aliases that
 * follow are the audit's preferred semantic names — pick whichever
 * reads more naturally at the call site.
 *
 * - clean | success | empty-list   — calm "nothing here / all done"
 *                                    (green bell, target icon, etc.)
 * - scanning                        — in-progress / waiting on data
 * - error | data-unavailable        — something's wrong / unreachable
 * - locked | configure-me           — feature requires setup or
 *                                    permission
 */
export type EmptyVariant =
  | 'clean' | 'success' | 'empty-list'
  | 'scanning'
  | 'error' | 'data-unavailable'
  | 'locked' | 'configure-me';

const VARIANT_ALIAS: Record<EmptyVariant, 'clean' | 'scanning' | 'error' | 'locked'> = {
  clean:              'clean',
  success:            'clean',
  'empty-list':       'clean',
  scanning:           'scanning',
  error:              'error',
  'data-unavailable': 'error',
  locked:             'locked',
  'configure-me':     'locked',
};

interface EmptyStateAction {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary';
}

interface EmptyStateProps {
  icon?: ReactNode;
  title?: string;
  /** @deprecated Use `title` instead */
  message?: string;
  subtitle?: string;
  /** @deprecated Use `subtitle` instead */
  description?: string;
  action?: EmptyStateAction;
  secondaryAction?: EmptyStateAction;
  variant?: EmptyVariant;
  compact?: boolean;
}

type ResolvedVariant = 'clean' | 'scanning' | 'error' | 'locked';

const variantStyles: Record<ResolvedVariant, {
  iconBg: string;
  iconColor: string;
  titleColor: string;
  border: string;
}> = {
  clean: {
    iconBg: 'bg-emerald-500/10',
    iconColor: 'text-emerald-400',
    titleColor: 'text-white/70',
    border: 'border-emerald-500/10',
  },
  scanning: {
    iconBg: 'bg-amber-500/10',
    iconColor: 'text-amber-400',
    titleColor: 'text-white/70',
    border: 'border-amber-500/10',
  },
  error: {
    iconBg: 'bg-red-500/10',
    iconColor: 'text-red-400',
    titleColor: 'text-white/80',
    border: 'border-red-500/15',
  },
  locked: {
    iconBg: 'bg-slate-500/10',
    iconColor: 'text-slate-400',
    titleColor: 'text-white/50',
    border: 'border-white/5',
  },
};

export function EmptyState({
  icon,
  title,
  message,
  subtitle,
  description,
  action,
  secondaryAction,
  variant = 'clean',
  compact = false,
}: EmptyStateProps) {
  const styles = variantStyles[VARIANT_ALIAS[variant]];
  const displayTitle = title ?? message;
  const displaySubtitle = subtitle ?? description;

  return (
    <div
      className={`flex flex-col items-center justify-center text-center
        ${compact ? 'py-8 px-4' : 'py-16 px-6'}
        rounded-xl border ${styles.border}`}
    >
      {icon && (
        <div className={`w-12 h-12 rounded-xl ${styles.iconBg}
          flex items-center justify-center mb-4 ${styles.iconColor}`}>
          <div className="w-6 h-6">{icon}</div>
        </div>
      )}

      {displayTitle && (
        <h3 className={`font-semibold text-sm ${styles.titleColor} mb-1`}>
          {displayTitle}
        </h3>
      )}

      {displaySubtitle && (
        <p className="text-white/35 text-xs max-w-xs leading-relaxed">
          {displaySubtitle}
        </p>
      )}

      {(action || secondaryAction) && (
        <div className="flex items-center gap-3 mt-5">
          {action && (
            <button
              onClick={action.onClick}
              className={`px-4 py-2 rounded-lg text-xs font-medium transition-all ${
                action.variant === 'secondary'
                  ? 'bg-white/5 hover:bg-white/10 text-white/70 hover:text-[var(--text-primary)] border border-white/10'
                  : 'bg-amber-500 hover:bg-amber-400 text-black font-semibold'
              }`}
            >
              {action.label}
            </button>
          )}
          {secondaryAction && (
            <button
              onClick={secondaryAction.onClick}
              className="px-4 py-2 rounded-lg text-xs font-medium
                bg-white/5 hover:bg-white/10 text-white/60 hover:text-[var(--text-primary)]
                border border-white/10 transition-all"
            >
              {secondaryAction.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
