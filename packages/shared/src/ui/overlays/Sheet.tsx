import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from '../cn';
import { Card } from '../Card';
import { OverlayStyles } from './overlay-styles';
import { OverlayHeader, type OverlayHeaderProps } from './parts';

// Mobile bottom sheet (ACCOUNT_DESIGN_SPEC §4.13). Radix Dialog supplies the
// focus trap, Esc / scrim dismissal, scroll lock and aria wiring; we add the
// 24px top radius, 85dvh cap, grab handle, safe-area padding and a simple
// pointer-event drag-to-dismiss on the handle (threshold 80px).

const DRAG_DISMISS_PX = 80;

interface SheetContextValue {
  close: () => void;
}
const SheetContext = React.createContext<SheetContextValue | null>(null);

/** Close the surrounding Sheet from any descendant (e.g. a menu item). */
export function useSheetClose(): (() => void) | null {
  return React.useContext(SheetContext)?.close ?? null;
}

export interface SheetProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: React.ReactNode;
}

export function Sheet({ open, defaultOpen = false, onOpenChange, children }: SheetProps): React.ReactElement {
  const [inner, setInner] = React.useState(defaultOpen);
  const controlled = open !== undefined;
  const isOpen = controlled ? open : inner;
  const set = React.useCallback(
    (next: boolean) => {
      if (!controlled) setInner(next);
      onOpenChange?.(next);
    },
    [controlled, onOpenChange],
  );
  const ctx = React.useMemo<SheetContextValue>(() => ({ close: () => set(false) }), [set]);
  return (
    <SheetContext.Provider value={ctx}>
      <DialogPrimitive.Root open={isOpen} onOpenChange={set}>
        <OverlayStyles />
        {children}
      </DialogPrimitive.Root>
    </SheetContext.Provider>
  );
}

export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

export interface SheetContentProps extends OverlayHeaderProps {
  children?: React.ReactNode;
  /** Pinned below the scrolling body (e.g. action buttons). */
  footer?: React.ReactNode;
  className?: string;
  /** Classes for the scrolling body (default `px-4 pb-4`). */
  bodyClassName?: string;
  /** Hide the grab handle (also disables drag-to-dismiss). */
  hideHandle?: boolean;
  onOpenAutoFocus?: (event: Event) => void;
  onCloseAutoFocus?: (event: Event) => void;
  /** Fill the viewport height (e.g. notification panel) instead of hugging content. */
  fullHeight?: boolean;
}

export const SheetContent = React.forwardRef<HTMLDivElement, SheetContentProps>(function SheetContent(
  {
    title, description, icon, hideTitle, children, footer, className, bodyClassName,
    hideHandle = false, fullHeight = false, onOpenAutoFocus, onCloseAutoFocus,
  },
  ref,
) {
  const close = useSheetClose();
  const localRef = React.useRef<HTMLDivElement | null>(null);
  const drag = React.useRef<{ startY: number; dy: number; id: number } | null>(null);

  const setRefs = React.useCallback(
    (node: HTMLDivElement | null) => {
      localRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
    },
    [ref],
  );

  // Drag moves the sheet with the individual `translate` property (driven by
  // --sheet-drag-y in overlay-styles). It composes with the keyframe
  // `transform`, so the enter/exit animations never restart and a dismissal
  // leaves from the drop point. data-drag-active only switches the spring-back
  // transition off while the finger is down.
  const applyOffset = (dy: number, active: boolean) => {
    const el = localRef.current;
    if (!el) return;
    el.dataset.dragActive = active ? 'true' : 'false';
    el.style.setProperty('--sheet-drag-y', `${dy}px`);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    drag.current = { startY: e.clientY, dy: 0, id: e.pointerId };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    d.dy = Math.max(0, e.clientY - d.startY); // never drag upward past rest
    applyOffset(d.dy, true);
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const el = localRef.current;
    if (d.dy >= DRAG_DISMISS_PX) {
      // Keep the offset: the exit animation starts from the drop point.
      if (el) el.dataset.dragActive = 'false';
      close?.();
      // A refused close (controlled `open` stays true) must not leave the sheet stranded.
      requestAnimationFrame(() => {
        if (localRef.current && localRef.current.dataset.state === 'open') applyOffset(0, false);
      });
    } else {
      applyOffset(0, false); // spring back via the translate transition
    }
  };

  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="av-ov-scrim" />
      <DialogPrimitive.Content
        asChild
        aria-modal="true"
        {...(description ? {} : { 'aria-describedby': undefined })}
        onOpenAutoFocus={onOpenAutoFocus}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <Card
          ref={setRefs}
          variant="elevated"
          padding="none"
          className={cn('av-ov-sheet', className)}
          style={{
            position: 'fixed',
            left: 0,
            right: 0,
            bottom: 0,
            margin: '0 auto',
            maxWidth: 560,
            width: '100%',
            height: fullHeight ? '100dvh' : undefined,
            maxHeight: fullHeight ? '100dvh' : '85dvh',
            borderRadius: fullHeight ? 0 : '24px 24px 0 0',
            zIndex: 'var(--z-modal, 400)' as unknown as number,
            display: 'flex',
            flexDirection: 'column',
            paddingBottom: 'env(safe-area-inset-bottom, 0px)',
            willChange: 'transform, translate',
          }}
        >
          {hideHandle ? null : (
            <div
              data-sheet-handle=""
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              style={{ touchAction: 'none', cursor: 'grab' }}
              className="flex shrink-0 justify-center px-4 pb-2 pt-2.5"
            >
              <span aria-hidden className="block h-1 w-9 rounded-full bg-[var(--border-strong)]" />
            </div>
          )}
          <div className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain', bodyClassName ?? 'px-4 pb-4')}>
            <div className={hideTitle ? undefined : 'mb-4'}>
              <OverlayHeader title={title} description={description} icon={icon} hideTitle={hideTitle} />
            </div>
            {children}
          </div>
          {footer ? (
            <div className="av-ov-footer shrink-0 px-4 pb-4 pt-1" data-presentation="sheet">
              {footer}
            </div>
          ) : null}
        </Card>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});
