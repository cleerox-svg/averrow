import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';

export interface OverlayHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  /** Keep the title/description for assistive tech only. */
  hideTitle?: boolean;
}

/** Radix Title/Description + the optional icon tile (title 18/700, body 14/1.5). */
export function OverlayHeader({ title, description, icon, hideTitle }: OverlayHeaderProps): React.ReactElement {
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
