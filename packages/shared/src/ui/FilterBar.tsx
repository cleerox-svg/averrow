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
  };
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
  filters, active, onChange, search, actions, children, className, filterLabel,
}: FilterBarProps<V>) {
  const searchId = React.useId();
  const searchLabel = search?.label ?? search?.placeholder ?? 'Search';
  return (
    <Card variant="base" className={cn('px-4 py-2.5 mb-3', className)}>
      <div className="flex flex-wrap items-center gap-2">
        {search && (
          <>
            <label htmlFor={searchId} className="sr-only">{searchLabel}</label>
            <input
              id={searchId}
              type="search"
              value={search.value}
              onChange={(e) => search.onChange(e.target.value)}
              placeholder={search.placeholder ?? 'Search...'}
              className={cn(
                'h-[34px] min-w-[120px] max-w-[320px] flex-[1_1_180px] rounded-lg px-3 text-[12px] font-sans',
                'bg-[var(--bg-input)] text-[var(--text-primary)] border border-[var(--border-base)] placeholder:text-[var(--text-secondary)]',
                'focus-visible:outline-none focus-visible:border-[var(--amber-border)] focus-visible:ring-2 focus-visible:ring-[var(--amber)]',
              )}
            />
          </>
        )}

        {search && filters && filters.length > 0 && (
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
                    'shrink-0 inline-flex items-center gap-[5px] rounded-full px-[14px] py-[5px] font-mono text-[10px] font-bold uppercase tracking-[0.10em] cursor-pointer',
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
                    <span aria-hidden="true" className="text-[9px]" style={{ color: isActive ? 'var(--amber-text)' : 'var(--text-secondary)', opacity: isActive ? 0.8 : 1 }}>
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
