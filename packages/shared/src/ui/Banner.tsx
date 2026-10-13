// @averrow/shared/ui — Banner
//
// One banner primitive for page-level notices. Two variants:
//   inline     flat card, 3px tone edge. The default.
//   prominent  tinted surface + gradient hairline, for act-now states only.
// Tone drives icon tile + edge colours via --sev-* tokens (CSS in tokens.css,
// `.ds-banner*`). No static role="alert": the banner is a visible region, and
// the root is a <section> only when it has an accessible name.
// Details can be toggled by a text button or by the whole header row.

import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode, type Ref } from 'react';
import { cn } from './cn';
import { AlertIcon, ChevronRightIcon, InfoIcon, CheckIcon, WarnIcon, XIcon } from './settings/icons';

export type BannerTone = 'critical' | 'high' | 'medium' | 'low' | 'info' | 'success';
export type BannerVariant = 'inline' | 'prominent';
export type BannerDensity = 'default' | 'compact';

const ICONS: Record<BannerTone, typeof InfoIcon> = {
  critical: AlertIcon, high: WarnIcon, medium: WarnIcon, low: InfoIcon, info: InfoIcon, success: CheckIcon,
};

type Slot = 'icon' | 'main' | 'actions' | 'close';

// Grid columns/areas built from what is actually rendered, so an absent
// icon/actions/close never leaves an empty track. `stacked` puts actions on a
// second row under the text column (narrow screens and the prominent variant).
function layout(has: Record<Exclude<Slot, 'main'>, boolean>, stacked: boolean, iconWidth: string): { cols: string; areas: string } {
  const row: Slot[] = [];
  const cols: string[] = [];
  if (has.icon) { row.push('icon'); cols.push(iconWidth); }
  row.push('main'); cols.push('minmax(0, 1fr)');
  if (has.actions && !stacked) { row.push('actions'); cols.push('auto'); }
  if (has.close) { row.push('close'); cols.push('auto'); }
  const rows = [row.join(' ')];
  if (has.actions && stacked) {
    rows.push(row.map((n) => (n === 'icon' ? '.' : 'actions')).join(' '));
  }
  return { cols: cols.join(' '), areas: rows.map((r) => `"${r}"`).join(' ') };
}

function resolveTone(tone: string | undefined): BannerTone {
  return tone && Object.prototype.hasOwnProperty.call(ICONS, tone) ? (tone as BannerTone) : 'info';
}

export interface BannerProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  tone?: BannerTone;
  variant?: BannerVariant;
  /** `compact` is the form/settings flavour (inside cards, forms, settings groups): tinted fill, bare 20px icon, never clamped. Inline variant only. Default is page-level. */
  density?: BannerDensity;
  title: ReactNode;
  /** Message. Inline banners clamp title/message to 2 lines while collapsed, and offer "Show more" only when the text actually overflows. */
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
  detailsTrigger?: 'button' | 'header';
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  onDismiss?: () => void;
  dismissLabel?: string;
  /** Title element. Default 'none' (a span): the region label carries the semantics. */
  headingLevel?: 2 | 3 | 4 | 'none';
  /** Name the region after the title (renders a <section>). */
  labelFromTitle?: boolean;
  /** The header toggle button (detailsTrigger="header"), e.g. to move focus. */
  headerRef?: Ref<HTMLElement>;
}

export function Banner({
  tone, variant = 'inline', density = 'default', title, children, eyebrow, icon, pulse = false, actions, footer, details,
  detailsTrigger = 'button', open, defaultOpen = false, onOpenChange, onDismiss,
  dismissLabel = 'Dismiss', headingLevel = 'none', labelFromTitle = false, headerRef, className, style, ...rest
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

  const headerToggle = details != null && detailsTrigger === 'header';
  // Inline banners clamp while collapsed (and the clamp is measured); the
  // header-toggle title lives in a button and is never clamped. Prominent
  // banners never clamp.
  const compact = variant === 'inline' && density === 'compact';
  const clampable = variant === 'inline' && !compact;
  const titleRef = useRef<HTMLElement | null>(null);
  const msgRef = useRef<HTMLDivElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  useLayoutEffect(() => {
    if (!clampable || isOpen) return undefined; // keep the last measurement while open
    const measure = () => {
      const over = (el: HTMLElement | null) => !!el && el.scrollHeight > el.clientHeight + 1;
      setOverflowing(over(headerToggle ? null : titleRef.current) || over(msgRef.current));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    if (titleRef.current) ro.observe(titleRef.current);
    if (msgRef.current) ro.observe(msgRef.current);
    return () => ro.disconnect();
  }, [clampable, isOpen, headerToggle, title, children]);

  const hasDetails = details != null;
  const hasToggle = hasDetails || (clampable && overflowing);
  // Clamp whenever collapsed: it is a no-op for text that fits, and it is what
  // makes overflow measurable. The toggle only appears on real overflow (or details).
  const clamp = clampable && !isOpen;
  const named = Boolean(rest['aria-label'] || rest['aria-labelledby'] || labelFromTitle);
  const Root = named ? 'section' : 'div';
  const Heading = headingLevel === 'none' ? 'span' : (`h${headingLevel}` as 'h2' | 'h3' | 'h4');
  const showIcon = icon !== false;
  const Glyph = ICONS[t];

  const toggleControls = { 'aria-expanded': isOpen, 'aria-controls': hasDetails ? detailsId : undefined };
  const stacked = variant === 'prominent';
  const iconWidth = compact ? '20px' : '28px';
  const wide = layout({ icon: showIcon, actions: Boolean(actions), close: Boolean(onDismiss) }, stacked, iconWidth);
  const narrow = layout({ icon: showIcon, actions: Boolean(actions), close: Boolean(onDismiss) }, true, iconWidth);
  const gridVars = {
    '--bn-cols': wide.cols, '--bn-areas': wide.areas, '--bn-cols-s': narrow.cols, '--bn-areas-s': narrow.areas,
  } as CSSProperties;
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
      aria-labelledby={rest['aria-labelledby'] ?? (labelFromTitle ? titleId : undefined)}
      data-tone={t}
      data-variant={variant}
      data-density={compact ? 'compact' : 'default'}
      className={cn('ds-banner', className)}
      style={{ ...gridVars, ...style }}
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
        <div className="ds-banner-top">
          <Heading
            id={titleId}
            ref={titleRef as Ref<HTMLHeadingElement>}
            className={cn('ds-banner-title', clamp && !headerToggle && 'ds-banner-clamp')}
          >
            {titleNode}
          </Heading>
          {children != null && (
            <div ref={msgRef} className={cn('ds-banner-msg', clamp && 'ds-banner-clamp')}>{children}</div>
          )}
        </div>
        {footer}
        {details != null && (
          <div id={detailsId} className="ds-banner-details" hidden={!isOpen}>{details}</div>
        )}
        {hasToggle && !headerToggle && (
          <button type="button" className="ds-banner-link" onClick={toggle} {...toggleControls}>
            {hasDetails ? 'Details' : isOpen ? 'Show less' : 'Show more'}
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
