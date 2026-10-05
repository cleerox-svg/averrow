import * as React from 'react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { cn } from '../cn';
import { Card } from '../Card';
import { OverlayStyles } from './overlay-styles';
import { FOCUS_RING_INSET } from '../forms/focus';
import { IconTile } from '../settings/IconTile';
import { Sheet, SheetContent, SheetTrigger, useSheetClose } from './Sheet';
import { useIsCompact } from './useMediaQuery';

// Account/avatar menu primitives (ACCOUNT_DESIGN_SPEC §4.12, §5.5). `Menu*`
// wraps Radix DropdownMenu (arrows, typeahead, Esc, focus return). When the
// same items are rendered inside <ResponsiveMenu> on a compact screen they sit
// in a bottom Sheet instead; a context switches MenuItem & co. to plain
// elements there, since Radix menu parts require a DropdownMenu root.

type Presentation = 'popover' | 'sheet';
const PresentationContext = React.createContext<Presentation>('popover');

export function Menu(props: DropdownMenuPrimitive.DropdownMenuProps): React.ReactElement {
  return (
    <>
      <OverlayStyles />
      <DropdownMenuPrimitive.Root {...props} />
    </>
  );
}
export const MenuTrigger = DropdownMenuPrimitive.Trigger;
export const MenuGroup = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function MenuGroup(props, ref) {
    const mode = React.useContext(PresentationContext);
    if (mode === 'sheet') return <div ref={ref} role="group" {...props} />;
    return <DropdownMenuPrimitive.Group ref={ref} {...props} />;
  },
);

export interface MenuContentProps {
  children?: React.ReactNode;
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  className?: string;
  /** Override the default `min(296px, 100vw - 24px)`. */
  width?: number | string;
  onCloseAutoFocus?: (event: Event) => void;
  'aria-label'?: string;
}

export const MenuContent = React.forwardRef<HTMLDivElement, MenuContentProps>(function MenuContent(
  { children, align = 'end', sideOffset = 8, className, width, ...rest },
  ref,
) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        asChild
        align={align}
        sideOffset={sideOffset}
        collisionPadding={12}
        {...rest}
      >
        <Card
          ref={ref}
          variant="elevated"
          padding={6}
          className={cn('av-ov-menu', className)}
          style={{
            width: width === undefined ? 'min(296px, calc(100vw - 24px))' : typeof width === 'number' ? `${width}px` : width,
            maxHeight: 'var(--radix-dropdown-menu-content-available-height, 80dvh)',
            overflowY: 'auto',
            borderRadius: 16,
            zIndex: 'var(--z-popover, 450)' as unknown as number,
          }}
        >
          {children}
        </Card>
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  );
});

const ITEM_CLASS =
  'relative flex min-h-[44px] w-full cursor-pointer select-none items-center gap-3 rounded-[10px] px-3 text-left text-[14px] font-medium leading-[1.3] outline-none ' +
  'text-[var(--text-primary)] transition-colors duration-[var(--dur-fast,120ms)] motion-reduce:transition-none ' +
  'data-[highlighted]:bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)] hover:bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)] ' +
  'focus-visible:bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)] ' + FOCUS_RING_INSET + ' ' +
  'data-[disabled]:pointer-events-none data-[disabled]:opacity-50 disabled:pointer-events-none disabled:opacity-50';

const DANGER_CLASS = 'text-[var(--sev-critical-text)]';

export interface MenuItemProps {
  children: React.ReactNode;
  /** 18px glyph; rendered in a neutral 28px tile (red-tinted for `tone="danger"`). */
  icon?: React.ReactNode;
  /** Secondary line under the label (e.g. "Use a different Google account"). */
  description?: React.ReactNode;
  /** Trailing slot: count Badge, check, chevron… */
  trailing?: React.ReactNode;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  /** Call `event.preventDefault()` to keep the menu/sheet open. */
  onSelect?: (event: Event) => void;
  className?: string;
}

function ItemContent({ icon, description, trailing, tone, children }: Pick<MenuItemProps, 'icon' | 'description' | 'trailing' | 'tone' | 'children'>) {
  const danger = tone === 'danger';
  return (
    <>
      {icon ? (
        <IconTile size={28} tone={danger ? 'red' : 'neutral'} className="[&>svg]:!h-[18px] [&>svg]:!w-[18px]">{icon}</IconTile>
      ) : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{children}</span>
        {description ? (
          <span className="block truncate text-[13px] font-normal text-[var(--text-help)]">{description}</span>
        ) : null}
      </span>
      {trailing ? <span className="ml-auto inline-flex shrink-0 items-center">{trailing}</span> : null}
    </>
  );
}

export const MenuItem = React.forwardRef<HTMLElement, MenuItemProps>(function MenuItem(
  { children, icon, description, trailing, tone = 'default', disabled, onSelect, className },
  ref,
) {
  const mode = React.useContext(PresentationContext);
  const closeSheet = useSheetClose();
  const cls = cn(ITEM_CLASS, tone === 'danger' && DANGER_CLASS, className);
  const content = { icon, description, trailing, tone, children };

  if (mode === 'sheet') {
    const handleClick = () => {
      const ev = new Event('select', { cancelable: true });
      onSelect?.(ev);
      if (!ev.defaultPrevented) closeSheet?.();
    };
    return (
      <button
        ref={ref as React.Ref<HTMLButtonElement>}
        type="button"
        disabled={disabled}
        onClick={handleClick}
        className={cn(cls, 'min-h-[48px]')}
      >
        <ItemContent {...content} />
      </button>
    );
  }

  return (
    <DropdownMenuPrimitive.Item
      ref={ref as React.Ref<HTMLDivElement>}
      disabled={disabled}
      onSelect={onSelect}
      className={cls}
    >
      <ItemContent {...content} />
    </DropdownMenuPrimitive.Item>
  );
});

export const MenuLabel = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function MenuLabel({ className, ...props }, ref) {
    const mode = React.useContext(PresentationContext);
    const cls = cn('px-3 pb-1 pt-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]', className);
    if (mode === 'sheet') return <div ref={ref} className={cls} {...props} />;
    return <DropdownMenuPrimitive.Label ref={ref} className={cls} {...props} />;
  },
);

export const MenuSeparator = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function MenuSeparator({ className, ...props }, ref) {
    const mode = React.useContext(PresentationContext);
    const cls = cn('my-1.5 h-px bg-[var(--border-base)]', className);
    if (mode === 'sheet') return <div ref={ref} role="separator" className={cls} {...props} />;
    return <DropdownMenuPrimitive.Separator ref={ref} className={cls} {...props} />;
  },
);

export interface ResponsiveMenuProps {
  /** The trigger element (rendered `asChild`), e.g. the 36px avatar button. */
  trigger: React.ReactElement;
  /** Accessible name of the menu/sheet. */
  title: string;
  children: React.ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Popover options (desktop). */
  align?: 'start' | 'center' | 'end';
  width?: number | string;
  contentClassName?: string;
}

/**
 * Same items, two shells: Radix popover on desktop, bottom Sheet on
 * narrow/coarse screens (avatar menu, §5.5). Items must be the `Menu*`
 * components above; anything else (identity header, appearance control) is
 * rendered as-is in both shells.
 */
export function ResponsiveMenu({
  trigger, title, children, open, defaultOpen, onOpenChange, align = 'end', width, contentClassName,
}: ResponsiveMenuProps): React.ReactElement {
  const compact = useIsCompact();
  if (compact) {
    return (
      <PresentationContext.Provider value="sheet">
        <Sheet open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
          <SheetTrigger asChild>{trigger}</SheetTrigger>
          <SheetContent title={title} hideTitle bodyClassName="px-2 pb-3">
            {children}
          </SheetContent>
        </Sheet>
      </PresentationContext.Provider>
    );
  }
  return (
    <PresentationContext.Provider value="popover">
      <Menu open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
        <MenuTrigger asChild>{trigger}</MenuTrigger>
        <MenuContent align={align} width={width} className={contentClassName} aria-label={title}>
          {children}
        </MenuContent>
      </Menu>
    </PresentationContext.Provider>
  );
}
