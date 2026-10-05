// @averrow/shared/ui/settings — SettingsRow (ACCOUNT_DESIGN_SPEC §4.2)
//
// One setting: [tile] [title / description / meta] [trailing]. Variants:
//   static  — a plain div (read-only facts, rows with their own controls)
//   button  — whole row is a <button>; chevron appended
//   link    — whole row is a link (default <a>, or `renderLink` for a router
//             Link); chevron appended
//   toggle  — whole row is a <label>; `trailing` is the Switch. `trailing` may
//             be a function receiving {labelId, descriptionId, disabled} so the
//             Switch can set aria-labelledby/-describedby.
//
// State: `disabled` + `disabledReason` (the reason replaces the description),
// `loading` (spinner, trailing dimmed), `error` (role="alert", replaces the
// description). Router-agnostic; no data/API imports.

import { useId, type MouseEvent, type ReactNode } from 'react';
import { cn } from '../cn';
import { IconTile, type IconTileTone } from './IconTile';
import { ChevronRightIcon } from './icons';
import { Spinner } from '../Spinner';
import { defaultRenderLink, type SettingsRenderLink } from './types';

export interface SettingsRowControlContext {
  labelId: string;
  descriptionId: string;
  disabled: boolean;
}

export interface SettingsRowProps {
  variant?: 'static' | 'button' | 'link' | 'toggle';
  /** Glyph shown in the tinted tile. Omit for a tile-less row (hairline insets to 16px). */
  icon?: ReactNode;
  tone?: IconTileTone;
  title: ReactNode;
  description?: ReactNode;
  /** Mono 12px line (timestamps, IPs). */
  meta?: ReactNode;
  /** Right slot: Switch, value text, Select, Badge, Button. Function form for `toggle`. */
  trailing?: ReactNode | ((ctx: SettingsRowControlContext) => ReactNode);
  /** On <480px a wide trailing control (Select/Segmented) drops below the text, full width. */
  stackTrailing?: boolean;
  /** Table-like dense rows (device list): 14px title. */
  dense?: boolean;
  disabled?: boolean;
  /** Why the row is disabled — shown in place of the description. Always say why. */
  disabledReason?: ReactNode;
  /** Row-level save in flight. */
  loading?: boolean;
  /** Failure message (role="alert"); replaces the description. */
  error?: ReactNode;
  /** `button` variant. */
  onClick?: (e: MouseEvent<HTMLElement>) => void;
  /** `link` variant. */
  href?: string;
  renderLink?: SettingsRenderLink;
  /** Marks the link row as the current page. */
  current?: boolean;
  className?: string;
  id?: string;
}

export function SettingsRow({
  variant = 'static', icon, tone = 'neutral', title, description, meta, trailing, stackTrailing = false,
  dense = false, disabled = false, disabledReason, loading = false, error, onClick, href, renderLink,
  current = false, className, id,
}: SettingsRowProps) {
  const uid = useId();
  const labelId = `${uid}-title`;
  const descriptionId = `${uid}-desc`;
  const interactive = variant === 'button' || variant === 'link';
  const hasIcon = icon !== undefined && icon !== null && icon !== false;

  const trailingNode = typeof trailing === 'function'
    ? trailing({ labelId, descriptionId, disabled: disabled || loading })
    : trailing;
  const showChevron = interactive && !loading;

  const message = error
    ? <span id={descriptionId} role="alert" className="ds-srow-desc ds-srow-err">{error}</span>
    : disabled && disabledReason
      ? <span id={descriptionId} className="ds-srow-desc">{disabledReason}</span>
      : description
        ? <span id={descriptionId} className="ds-srow-desc">{description}</span>
        : null;

  const body = (
    <>
      {hasIcon && <IconTile tone={tone}>{icon}</IconTile>}
      <span className="ds-srow-text">
        <span id={labelId} className="ds-srow-title">{title}</span>
        {message}
        {meta && <span className="ds-srow-meta">{meta}</span>}
      </span>
      {(trailingNode || loading || showChevron) && (
        <span className="ds-srow-trailing">
          {loading && <Spinner />}
          {trailingNode && (
            <span className={cn('inline-flex min-w-0 items-center', loading && 'ds-srow-trailing--busy')}>{trailingNode}</span>
          )}
          {showChevron && <ChevronRightIcon className="ds-srow-chev" />}
        </span>
      )}
    </>
  );

  const cls = cn(
    'ds-srow',
    !hasIcon && 'ds-srow--plain',
    dense && 'ds-srow--dense',
    stackTrailing && 'ds-srow--stack',
    interactive && 'ds-srow--interactive',
    variant === 'toggle' && 'ds-srow-label',
    className,
  );

  if (variant === 'button') {
    return (
      <button
        type="button"
        id={id}
        className={cls}
        aria-disabled={disabled || undefined}
        aria-busy={loading || undefined}
        aria-describedby={message ? descriptionId : undefined}
        onClick={(e) => { if (disabled || loading) { e.preventDefault(); return; } onClick?.(e); }}
      >
        {body}
      </button>
    );
  }

  if (variant === 'link') {
    const render = renderLink ?? defaultRenderLink;
    return render({
      href: href ?? '#',
      className: cls,
      children: body,
      'aria-current': current ? 'page' : undefined,
      'aria-disabled': disabled || undefined,
      tabIndex: disabled ? -1 : undefined,
      onClick: (e) => { if (disabled) { e.preventDefault(); return; } onClick?.(e); },
    });
  }

  if (variant === 'toggle') {
    return (
      <label id={id} className={cls} data-disabled={disabled || undefined}>
        {body}
      </label>
    );
  }

  return (
    <div id={id} className={cls} data-disabled={disabled || undefined} aria-busy={loading || undefined}>
      {body}
    </div>
  );
}
