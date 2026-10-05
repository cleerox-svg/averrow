import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';

export interface OverlayHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  /** Keep the title/description for assistive tech only. */
  hideTitle?: boolean;
  /**
   * id of a heading the HOST renders (and styles) itself. The sheet is then labelled by
   * it (`aria-labelledby`) and the built-in title/description are not exposed, so there
   * is exactly one heading with that name.
   */
  labelledBy?: string;
}

/** Radix Title/Description + the optional icon tile (title 18/700, body 14/1.5). */
export function OverlayHeader({ title, description, icon, hideTitle, labelledBy }: OverlayHeaderProps): React.ReactElement {
  if (labelledBy) {
    // Kept in the DOM (Radix looks it up) but removed from layout and the a11y tree.
    return (
      <>
        <DialogPrimitive.Title hidden>{title}</DialogPrimitive.Title>
        {description ? <DialogPrimitive.Description hidden>{description}</DialogPrimitive.Description> : null}
      </>
    );
  }
  if (hideTitle) {
    return (
      <>
        <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
        {description ? <DialogPrimitive.Description className="sr-only">{description}</DialogPrimitive.Description> : null}
      </>
    );
  }
  return (
    <div className="flex items-start gap-3">
      {icon}
      <div className="min-w-0 flex-1">
        <DialogPrimitive.Title className="m-0 text-[18px] font-bold leading-[1.3] text-[var(--text-primary)]">
          {title}
        </DialogPrimitive.Title>
        {description ? (
          <DialogPrimitive.Description className="m-0 mt-1.5 text-[14px] leading-[1.5] text-[var(--text-secondary)]">
            {description}
          </DialogPrimitive.Description>
        ) : null}
      </div>
    </div>
  );
}
