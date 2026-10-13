// @averrow/shared/ui — Banner
//
// One banner primitive for page-level notices. Two variants:
//   inline     flat card, 3px tone edge. The default.
//   prominent  tinted surface + gradient hairline, for act-now states only.
// Tone drives icon tile + edge colours via --sev-* tokens (CSS in tokens.css,
// `.ds-banner*`). No static role="alert": the banner is a visible region, and
// the root is a <section> only when it has an accessible name.
// Details can be toggled by a text button or by the whole header row.

import { useId, useState, type CSSProperties, type HTMLAttributes, type ReactNode, type Ref } from 'react';
import { cn } from './cn';
import { AlertIcon, ChevronRightIcon, InfoIcon, CheckIcon, WarnIcon, XIcon } from './settings/icons';

export type BannerTone = 'critical' | 'high' | 'medium' | 'low' | 'info' | 'success';
export type BannerVariant = 'inline' | 'prominent';

const ICONS: Record<BannerTone, typeof InfoIcon> = {
  critical: AlertIcon, high: WarnIcon, medium: WarnIcon, low: InfoIcon, info: InfoIcon, success: CheckIcon,
};

function resolveTone(tone: string | undefined): BannerTone {
  return tone && Object.prototype.hasOwnProperty.call(ICONS, tone) ? (tone as BannerTone) : 'info';
}

export interface BannerProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  tone?: BannerTone;
  variant?: BannerVariant;
  title: ReactNode;
  /** Message; clamped to 2 lines unless expanded. */
  children?: ReactNode;
  eyebrow?: ReactNode;
  /** Default: per-tone icon tile. `false` hides it. */
  icon?: ReactNode | false;
  pulse?: boolean;
  /** Right side on desktop; wraps under the text column on narrow screens. */
  actions?: ReactNode;
  /** Always-visible region under the message (stats, notes). */
  footer?: ReactNode;
  /** Expandable region. */
  details?: ReactNode;
  /** Show the toggle (and unclamp the message) even without `details`. */
  expandable?: boolean;
  detailsTrigger?: 'button' | 'header';
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  onDismiss?: () => void;
  dismissLabel?: string;
  headingLevel?: 2 | 3 | 4 | 'none';
  /** Name the region after the title (renders a <section>). */
  labelFromTitle?: boolean;
  /** The header toggle button (detailsTrigger="header"), e.g. to move focus. */
  headerRef?: Ref<HTMLElement>;
}

export function Banner({
  tone, variant = 'inline', title, children, eyebrow, icon, pulse = false, actions, footer, details,
  expandable = false, detailsTrigger = 'button', open, defaultOpen = false, onOpenChange, onDismiss,
  dismissLabel = 'Dismiss', headingLevel = 3, labelFromTitle = false, headerRef, className, style, ...rest
}: BannerProps) {
  const t = resolveTone(tone);
  const uid = useId();
  const titleId = `${uid}-title`;
  const detailsId = `${uid}-details`;
  const [inner, setInner] = useState(defaultOpen);
  const isOpen = open ?? inner;
  const toggle = () => {
    const next = !isOpen;
    if (open === undefined) setInner(next);
    onOpenChange?.(next);
  };

  const hasToggle = details != null || expandable;
  const named = Boolean(rest['aria-label'] || rest['aria-labelledby'] || labelFromTitle);
  const Root = named ? 'section' : 'div';
  const Heading = headingLevel === 'none' ? 'span' : (`h${headingLevel}` as 'h2' | 'h3' | 'h4');
  const showIcon = icon !== false;
  const Glyph = ICONS[t];

  const toggleControls = { 'aria-expanded': isOpen, 'aria-controls': details != null ? detailsId : undefined };
  const headerToggle = hasToggle && detailsTrigger === 'header';
  const titleNode = headerToggle ? (
    <button
      type="button" ref={headerRef as Ref<HTMLButtonElement>} className="ds-banner-head" onClick={toggle} {...toggleControls}
    >
      <span className="ds-banner-headtext">{title}</span>
      <ChevronRightIcon className="ds-banner-chevron" width={14} height={14} strokeWidth={2.5} />
    </button>
  ) : title;

  return (
    <Root
      {...rest}
      aria-labelledby={labelFromTitle ? titleId : rest['aria-labelledby']}
      data-tone={t}
      data-variant={variant}
      className={cn('ds-banner', !showIcon && 'ds-banner-noicon', className)}
      style={style as CSSProperties | undefined}
    >
      {showIcon && (
        <span className="ds-banner-icon" aria-hidden="true">
          {icon ?? <Glyph />}
          {pulse && (
            <span style={{ position: 'absolute', top: -2, right: -2, width: 8, height: 8 }}>
              <span
                style={{
                  position: 'absolute', inset: 0, borderRadius: '50%', background: 'var(--bn-edge)', opacity: 0.6,
                  animation: 'live-ping 1.6s cubic-bezier(0, 0, 0.2, 1) infinite',
                }}
              />
              <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'var(--bn-edge)' }} />
            </span>
          )}
        </span>
      )}

      <div className="ds-banner-main">
        {eyebrow && <span className="ds-banner-eyebrow">{eyebrow}</span>}
        <Heading id={titleId} className={cn('ds-banner-title', !isOpen && !headerToggle && 'ds-banner-clamp')}>
          {titleNode}
        </Heading>
        {children != null && (
          <div className={cn('ds-banner-msg', !isOpen && 'ds-banner-clamp')}>{children}</div>
        )}
        {footer}
        {details != null && (
          <div id={detailsId} className="ds-banner-details" hidden={!isOpen}>{details}</div>
        )}
        {hasToggle && detailsTrigger === 'button' && (
          <button type="button" className="ds-banner-link" onClick={toggle} {...toggleControls}>
            {isOpen ? 'Hide details' : 'Details'}
          </button>
        )}
      </div>

      {actions && <div className="ds-banner-actions">{actions}</div>}

      {onDismiss && (
        <button type="button" className="ds-banner-x ds-banner-close" onClick={onDismiss} aria-label={dismissLabel}>
          <XIcon width={16} height={16} />
        </button>
      )}
    </Root>
  );
}
