import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from '../cn';

export type TileTone = 'danger' | 'primary' | 'neutral';

const TILE_TINT: Record<TileTone, { tint: string; glyph: string }> = {
  danger: { tint: 'var(--red)', glyph: 'var(--sev-critical-text)' },
  primary: { tint: 'var(--amber)', glyph: 'var(--amber-text)' },
  neutral: { tint: 'var(--text-secondary)', glyph: 'var(--text-secondary)' },
};

/** Tinted square tile (ACCOUNT_DESIGN_SPEC §4.0): color-mix tint + border, themed % token. */
export function IconTile({
  tone = 'neutral',
  size = 40,
  radius = 9,
  children,
  className,
}: {
  tone?: TileTone;
  size?: number;
  radius?: number;
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  const t = TILE_TINT[tone];
  return (
    <span
      aria-hidden
      className={cn('inline-flex shrink-0 items-center justify-center', className)}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        color: t.glyph,
        background: `color-mix(in srgb, ${t.tint} var(--tile-tint-pct, 16%), transparent)`,
        border: `1px solid color-mix(in srgb, ${t.tint} 30%, transparent)`,
        boxShadow: 'inset 0 1px 0 var(--tile-rim, rgba(255,255,255,0.10))',
      }}
    >
      {children}
    </span>
  );
}

export function AlertGlyph(): React.ReactElement {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}

export function InfoGlyph(): React.ReactElement {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}

/** 16px spinner. Functional, so it stays under reduced motion (slower). */
export function Spinner({ size = 16, className }: { size?: number; className?: string }): React.ReactElement {
  return (
    <svg
      aria-hidden
      className={cn('av-ov-spinner shrink-0', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
    >
      <circle cx="12" cy="12" r="9" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  );
}

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
