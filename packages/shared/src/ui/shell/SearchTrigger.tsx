// SearchTrigger: the top-bar "Search… ⌘K" button that opens an app's command
// palette. The kit owns the look and responsive behaviour; the app owns what
// opens (`onOpen`) and the copy.
//
//   > 900px   300px wide field: icon, label, shortcut hint
//   <= 900px  fills the free space in the bar (flex-1)
//   <= 480px  44px icon-only square (label + shortcut hidden; `aria-label`
//             is the accessible name, so always keep it meaningful)
//
// Layout hooks: the root carries `shell-search-trigger`, the label
// `shell-search-label` and the hint `shell-search-kbd`, so an app can address
// them from a stylesheet without forking. Pass `className` to restyle (the
// trigger resolves every colour from tokens, so an always-dark bar only needs
// to override the token values or add classes).

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../cn';
import { ShellSearchIcon } from './icons';

export interface SearchTriggerProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'children' | 'type'> {
  /** Placeholder-style text, e.g. "Search threats, brands, actors…". */
  label: string;
  /** Shortcut hint, e.g. "⌘K". Hidden at phone width. Omit for none. */
  shortcut?: string;
  /** Called on click. The app opens its palette here. */
  onOpen: () => void;
  /** Leading glyph. Defaults to the kit's search icon. */
  icon?: ReactNode;
  /** `data-testid` for the label span. */
  labelTestId?: string;
  /** `data-testid` for the shortcut hint. */
  shortcutTestId?: string;
}

const BASE =
  'shell-search-trigger flex w-[300px] cursor-text items-center gap-[9px] rounded-[10px] border border-[var(--border-base)] ' +
  'bg-[var(--bg-card-deep,rgba(14,20,34,0.92))] px-3 py-2 text-left font-[inherit] text-[13px] text-[var(--text-tertiary)] ' +
  'transition-[border-color,color] duration-[140ms] motion-reduce:transition-none ' +
  'hover:border-[var(--border-strong)] hover:text-[var(--text-secondary)] ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] ' +
  'max-[900px]:w-auto max-[900px]:min-w-0 max-[900px]:flex-1 ' +
  'max-[480px]:min-h-[44px] max-[480px]:w-11 max-[480px]:flex-none max-[480px]:justify-center';

export const SearchTrigger = forwardRef<HTMLButtonElement, SearchTriggerProps>(function SearchTrigger(
  { label, shortcut, onOpen, icon, labelTestId, shortcutTestId, className, 'aria-label': ariaLabel = 'Search', ...rest },
  ref,
) {
  return (
    <button ref={ref} type="button" aria-label={ariaLabel} onClick={onOpen} className={cn(BASE, className)} {...rest}>
      {icon ?? <ShellSearchIcon aria-hidden="true" width={14} height={14} />}
      <span
        data-testid={labelTestId}
        className="shell-search-label overflow-hidden text-ellipsis whitespace-nowrap max-[480px]:hidden"
      >
        {label}
      </span>
      {shortcut ? (
        <kbd
          data-testid={shortcutTestId}
          className={
            'shell-search-kbd ml-auto rounded-[5px] border border-[var(--border-base)] ' +
            'bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] px-1.5 py-0.5 ' +
            'font-[family-name:var(--font-mono,ui-monospace)] text-[length:var(--type-label-size,12px)] ' +
            'text-[var(--text-secondary)] max-[480px]:hidden'
          }
        >
          {shortcut}
        </kbd>
      ) : null}
    </button>
  );
});
