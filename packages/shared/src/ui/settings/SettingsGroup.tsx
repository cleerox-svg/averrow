// @averrow/shared/ui/settings — SettingsGroup (ACCOUNT_DESIGN_SPEC §4.1)
//
// A titled `<section>` wrapping a glass Card whose SettingsRow children are
// separated by inset hairlines (CSS in theme/tokens.css). `variant="danger"`
// swaps the Card for the critical wash and is used by DangerZone only.

import { useId, type ReactNode } from 'react';
import { Card } from '../Card';
import { cn } from '../cn';

export interface SettingsGroupProps {
  /** Header above the card (12px/600 uppercase, sans). Omit for an untitled group. */
  title?: ReactNode;
  /** Right-aligned control beside the title (e.g. "Turn all on"). */
  headerAction?: ReactNode;
  /** Help paragraph under the card. */
  footer?: ReactNode;
  variant?: 'default' | 'danger';
  /** Accessible name when there is no visible `title`. */
  'aria-label'?: string;
  className?: string;
  children?: ReactNode;
}

export function SettingsGroup({
  title, headerAction, footer, variant = 'default', className, children, 'aria-label': ariaLabel,
}: SettingsGroupProps) {
  const titleId = useId();
  const hasTitle = title !== undefined && title !== null && title !== false;
  return (
    <section
      className={cn('ds-sgroup', className)}
      aria-labelledby={hasTitle ? titleId : undefined}
      aria-label={hasTitle ? undefined : ariaLabel}
      data-variant={variant}
    >
      {(hasTitle || headerAction) && (
        <div className="ds-sgroup-head">
          {hasTitle ? <h2 id={titleId} className="ds-sgroup-title">{title}</h2> : <span />}
          {headerAction && <div className="shrink-0">{headerAction}</div>}
        </div>
      )}
      <Card variant={variant === 'danger' ? 'critical' : 'base'} padding="none" className="ds-sgroup-body">
        {children}
      </Card>
      {footer && <div className="ds-sgroup-foot">{footer}</div>}
    </section>
  );
}
