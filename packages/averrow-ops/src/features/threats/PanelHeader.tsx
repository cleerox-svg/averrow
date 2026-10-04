import type { Ref } from 'react';

/**
 * Sectioned narrative divider (matches /brands Intel). Pass `innerRef` to make
 * the header a programmatic focus target (tabIndex -1) for scroll-to-section.
 */
export function PanelHeader({ title, subtitle, id, innerRef }: {
  title: string;
  subtitle: string;
  id?: string;
  innerRef?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      className={innerRef ? 'pt-2 ds-focusable' : 'pt-2'}
      id={id}
      ref={innerRef}
      tabIndex={innerRef ? -1 : undefined}
    >
      <div className="flex items-baseline gap-3">
        <h2 className="text-sm font-mono font-bold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
          {title}
        </h2>
        <span className="text-[11px] text-[var(--text-muted)]">{subtitle}</span>
      </div>
      <div className="mt-1 h-px bg-gradient-to-r from-white/[0.10] via-white/[0.04] to-transparent" />
    </div>
  );
}
