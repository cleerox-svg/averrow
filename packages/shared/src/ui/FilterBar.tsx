import * as React from 'react';
import { Card } from './Card';
import { cn } from './cn';

export interface FilterOption<V extends string = string> {
  value: V;
  label: string;
  count?: number;
}

export interface FilterBarProps<V extends string = string> {
  filters?: FilterOption<V>[];
  active?: V;
  onChange?: (value: V) => void;
  search?: {
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
    /** Accessible label (visually hidden). Defaults to the placeholder or "Search". */
    label?: string;
    /** Enter pressed in the search box. */
    onSubmit?: (value: string) => void;
  };
  /**
   * `sm` (default, dashboard density): 10px mono pills. `md`: legible settings/inbox
   * density — sans 13px/600 sentence-case pills, 13px search, >=44px touch height.
   */
  size?: 'sm' | 'md';
  /**
   * Control shown on the search row, right after the search box (e.g. a type
   * select). When set, search + accessory take the first row and the filter
   * pills wrap onto their own row beneath it.
   */
  searchAccessory?: React.ReactNode;
  /** Right-side slot for action buttons. */
  actions?: React.ReactNode;
  /** Extra filter rows (e.g. a secondary group). */
  children?: React.ReactNode;
  className?: string;
  /** Accessible name for the pill group (e.g. "Severity"). */
  filterLabel?: string;
}

// Outline-based: the active pill's inline boxShadow would override a ring.
const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--amber-text)]';

// Pills are toggle buttons (`aria-pressed`) in a labelled group: filters are
// "show this subset" switches, not a form-style radio selection, and a
// toggle reads naturally with a count in its name ("Critical, 12").
export function FilterBar<V extends string = string>({
  filters, active, onChange, search, searchAccessory, actions, children, className, filterLabel, size = 'sm',
}: FilterBarProps<V>) {
  const searchId = React.useId();
  const md = size === 'md';
  const searchLabel = search?.label ?? search?.placeholder ?? 'Search';
  return (
    <Card variant="base" padding="10px 16px" className={cn('mb-3', className)}>
      <div className="flex flex-wrap items-center gap-2">
        {search && (
          <div className={cn('contents', searchAccessory && '!flex w-full items-center gap-2')}>
            <label htmlFor={searchId} className="sr-only">{searchLabel}</label>
            <input
              id={searchId}
              type="search"
              value={search.value}
              onChange={(e) => search.onChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && search.value) { e.preventDefault(); e.stopPropagation(); search.onChange(''); }
                else if (e.key === 'Enter' && search.onSubmit) { e.preventDefault(); search.onSubmit(search.value); }
              }}
              placeholder={search.placeholder ?? 'Search...'}
              className={cn(
                'h-[34px] min-w-[120px] flex-[1_1_180px] rounded-lg',
                !searchAccessory && 'max-w-[320px]',
                'rounded-lg px-3 text-[12px] font-sans',
                md && 'h-[40px] text-[13px] [@media(pointer:coarse)]:h-11',
                'bg-[var(--bg-input)] text-[var(--text-primary)] border border-[var(--border-base)] placeholder:text-[var(--text-secondary)]',
                'focus-visible:outline-none focus-visible:border-[var(--amber-border)] focus-visible:ring-2 focus-visible:ring-[var(--amber)]',
              )}
            />
            {searchAccessory && <div className="shrink-0">{searchAccessory}</div>}
          </div>
        )}

        {search && !searchAccessory && filters && filters.length > 0 && (
          <div aria-hidden className="h-5 w-px shrink-0 bg-[var(--border-base)]" />
        )}

        {filters && filters.length > 0 && (
          <div role="group" aria-label={filterLabel ?? 'Filters'} className="contents">
            {filters.map((f) => {
              const isActive = f.value === active;
              return (
                <button
                  key={f.value}
                  type="button"
                  aria-pressed={isActive}
                  aria-label={f.count !== undefined ? `${f.label}, ${f.count}` : undefined}
                  onClick={() => onChange?.(f.value)}
                  className={cn(
                    'shrink-0 inline-flex items-center gap-[5px] rounded-full px-[14px] py-[5px] cursor-pointer',
                    md
                      ? 'min-h-[36px] font-sans text-[13px] font-semibold [@media(pointer:coarse)]:min-h-11'
                      : 'font-mono text-[10px] font-bold uppercase tracking-[0.10em]',
                    FOCUS_RING,
                  )}
                  style={{
                    border: `1px solid ${isActive ? 'var(--pill-active-border)' : 'var(--border-base)'}`,
                    background: isActive ? 'linear-gradient(135deg, var(--pill-active-fill-1), var(--pill-active-fill-2))' : 'transparent',
                    color: isActive ? 'var(--amber-text)' : 'var(--text-secondary)',
                    boxShadow: isActive ? 'inset 0 1px 0 var(--pill-active-rim)' : 'none',
                    transition: 'var(--transition-fast)',
                  }}
                >
                  {f.label}
                  {f.count !== undefined && (
                    <span aria-hidden="true" className={md ? 'font-mono text-[11px]' : 'text-[9px]'} style={{ color: isActive ? 'var(--amber-text)' : 'var(--text-secondary)', opacity: isActive ? 0.8 : 1 }}>
                      {f.count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {actions && <div className="flex-1" />}
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>

      {children && <div className="mt-2 border-t border-[var(--border-base)] pt-2">{children}</div>}
    </Card>
  );
}
