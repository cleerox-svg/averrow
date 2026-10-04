import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from '../cn';
import { Card } from '../Card';
import { Button } from '../Button';
import { OverlayStyles } from './overlay-styles';
import { AlertGlyph, IconTile, InfoGlyph, OverlayHeader, Spinner, type OverlayHeaderProps } from './parts';
import { Sheet, SheetContent } from './Sheet';
import { useIsCompact } from './useMediaQuery';

export type OverlayPresentation = 'auto' | 'dialog' | 'sheet';

export interface DialogProps extends OverlayHeaderProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children?: React.ReactNode;
  /** Action row. Right-aligned on desktop; stacked full-width (first child on the bottom) in a sheet. */
  footer?: React.ReactNode;
  /** Desktop width in px or CSS length. Default 440 (ConfirmDialog spec). */
  width?: number | string;
  /** `auto` = dialog on desktop, bottom sheet on narrow/coarse screens. */
  presentation?: OverlayPresentation;
  className?: string;
  onOpenAutoFocus?: (event: Event) => void;
  onCloseAutoFocus?: (event: Event) => void;
}

/**
 * Centered elevated card on desktop; switches to a bottom {@link Sheet} on
 * narrow/coarse screens (ACCOUNT_DESIGN_SPEC §4.10). Controlled only.
 */
export function Dialog({
  open, onOpenChange, title, description, icon, hideTitle, children, footer,
  width = 440, presentation = 'auto', className, onOpenAutoFocus, onCloseAutoFocus,
}: DialogProps): React.ReactElement {
  const compact = useIsCompact();
  const asSheet = presentation === 'sheet' || (presentation === 'auto' && compact);

  if (asSheet) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          title={title}
          description={description}
          icon={icon}
          hideTitle={hideTitle}
          footer={footer}
          className={className}
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          {children}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="av-ov-scrim">
          <OverlayStyles />
        </DialogPrimitive.Overlay>
        <DialogPrimitive.Content
          asChild
          aria-modal="true"
          {...(description ? {} : { 'aria-describedby': undefined })}
          onOpenAutoFocus={onOpenAutoFocus}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <Card
            variant="elevated"
            padding="lg"
            className={cn('av-ov-dialog', className)}
            style={{
              position: 'fixed',
              inset: 0,
              margin: 'auto',
              height: 'fit-content',
              maxHeight: 'calc(100dvh - 32px)',
              width: typeof width === 'number' ? `min(${width}px, calc(100vw - 32px))` : width,
              overflowY: 'auto',
              zIndex: 'var(--z-modal, 400)' as unknown as number,
            }}
          >
            <div className={hideTitle ? undefined : 'mb-4'}>
              <OverlayHeader title={title} description={description} icon={icon} hideTitle={hideTitle} />
            </div>
            {children}
            {footer ? (
              <div className="av-ov-footer mt-5" data-presentation="dialog">
                {footer}
              </div>
            ) : null}
          </Card>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A question: "Sign out of all devices?" */
  title: string;
  /** What happens, in one sentence. */
  description?: React.ReactNode;
  /** What will NOT happen / the reassurance ("You'll stay signed in here."). */
  consequence?: React.ReactNode;
  /** Repeat the verb ("Sign out everywhere"), never "OK". */
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
  /** Awaited. A rejection keeps the dialog open and shows an inline error. */
  onConfirm: () => void | Promise<void>;
  /** Overrides the inline error text; default is the rejection's message. */
  errorMessage?: string;
  icon?: React.ReactNode;
  presentation?: OverlayPresentation;
}

const DEFAULT_ERROR = "Couldn't complete that. Check your connection and try again.";

export function ConfirmDialog({
  open, onOpenChange, title, description, consequence, confirmLabel, cancelLabel = 'Cancel',
  tone = 'danger', onConfirm, errorMessage, icon, presentation,
}: ConfirmDialogProps): React.ReactElement {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const cancelRef = React.useRef<HTMLButtonElement | null>(null);
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Fresh state every time the dialog (re)opens.
  React.useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const handleOpenChange = (next: boolean) => {
    if (!next && pending) return; // never dismiss mid-request
    onOpenChange(next);
  };

  const handleConfirm = async () => {
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      if (mounted.current) onOpenChange(false);
    } catch (err) {
      if (mounted.current) {
        setError(errorMessage ?? (err instanceof Error && err.message ? err.message : DEFAULT_ERROR));
      }
    } finally {
      if (mounted.current) setPending(false);
    }
  };

  const defaultIcon = tone === 'danger' ? <AlertGlyph /> : <InfoGlyph />;

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      title={title}
      description={description}
      icon={<IconTile tone={tone === 'danger' ? 'danger' : 'primary'}>{icon ?? defaultIcon}</IconTile>}
      presentation={presentation}
      // Destructive: land on Cancel so Enter can never confirm by accident.
      onOpenAutoFocus={tone === 'danger' ? (e) => { e.preventDefault(); cancelRef.current?.focus(); } : undefined}
      footer={
        <>
          <Button ref={cancelRef} type="button" variant="secondary" disabled={pending} onClick={() => handleOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={tone === 'danger' ? 'danger' : 'primary'}
            disabled={pending}
            aria-busy={pending || undefined}
            onClick={() => { void handleConfirm(); }}
          >
            {pending ? <Spinner /> : null}
            {confirmLabel}
          </Button>
        </>
      }
    >
      {consequence ? (
        <p className="m-0 text-[14px] leading-[1.5] text-[var(--text-secondary)]">{consequence}</p>
      ) : null}
      {error ? (
        <p role="alert" className="m-0 mt-3 flex items-start gap-2 text-[13px] leading-[1.45] text-[var(--sev-critical-text)]">
          <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-[3px] shrink-0">
            <circle cx="12" cy="12" r="9.5" />
            <path d="M12 7v6M12 16.5h.01" />
          </svg>
          <span>{error}</span>
        </p>
      ) : null}
    </Dialog>
  );
}
