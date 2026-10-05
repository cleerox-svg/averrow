// @averrow/shared/ui/settings — InlineBanner (ACCOUNT_DESIGN_SPEC §4.14)
//
// In-flow notice (info / warn / error / success), e.g. "Push is blocked in
// this browser". Tinted with the --sev-* tokens; an icon plus text means
// colour is never the only signal. `error` is announced (role="alert"), the
// rest are polite status.

import type { ReactNode } from 'react';
import { cn } from '../cn';
import { AlertIcon, CheckIcon, InfoIcon, WarnIcon, XIcon } from './icons';

export type InlineBannerTone = 'info' | 'warn' | 'error' | 'success';

const TONES: Record<InlineBannerTone, { bg: string; border: string; text: string; Icon: typeof InfoIcon }> = {
  info:    { bg: 'var(--sev-low-bg)',      border: 'var(--sev-low-border)',      text: 'var(--sev-low-text)',      Icon: InfoIcon },
  warn:    { bg: 'var(--sev-medium-bg)',   border: 'var(--sev-medium-border)',   text: 'var(--sev-medium-text)',   Icon: WarnIcon },
  error:   { bg: 'var(--sev-critical-bg)', border: 'var(--sev-critical-border)', text: 'var(--sev-critical-text)', Icon: AlertIcon },
  success: { bg: 'var(--sev-info-bg)',     border: 'var(--sev-info-border)',     text: 'var(--sev-info-text)',     Icon: CheckIcon },
};

export interface InlineBannerProps {
  tone?: InlineBannerTone;
  title?: ReactNode;
  children?: ReactNode;
  /** Trailing action (a Button or link). */
  action?: ReactNode;
  /** Renders a 44px dismiss button when provided. */
  onDismiss?: () => void;
  dismissLabel?: string;
  className?: string;
}

export function InlineBanner({
  tone = 'info', title, children, action, onDismiss, dismissLabel = 'Dismiss', className,
}: InlineBannerProps) {
  const t = TONES[tone];
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      data-tone={tone}
      className={cn('flex items-start gap-3 rounded-xl px-3.5 py-3', className)}
      style={{ background: t.bg, border: `1px solid ${t.border}` }}
    >
      <t.Icon width={18} height={18} className="mt-0.5 shrink-0" style={{ color: t.text }} />
      <div className="min-w-0 flex-1 text-[14px] leading-[1.5] text-[var(--text-primary)]">
        {title && <p className="m-0 font-semibold" style={{ color: t.text }}>{title}</p>}
        {children && <div className={cn('text-[var(--text-secondary)]', title && 'mt-0.5')}>{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
      {onDismiss && (
        <button type="button" className="ds-iconbtn -my-2 -mr-2" aria-label={dismissLabel} onClick={onDismiss}>
          <XIcon width={16} height={16} />
        </button>
      )}
    </div>
  );
}
