// Averrow Design System — EntityListShell v1.0
//
// Shared list chrome for the entity surfaces (Brands / Providers / Threat
// Actors / Campaigns). Owns the three controls that were inconsistent across
// those pages — client-side SEARCH, SORT, and PAGINATION — plus the result
// count, skeleton grid, and empty state. It does NOT own card rendering
// (each entity keeps its bespoke card via `renderItem`) nor server-side /
// segment filtering (passed through to the FilterBar via `filters`).
//
// Why a shell and not four inline implementations: Threat Actors had no
// search/sort/pagination at all, Campaigns had search/sort but no pagination,
// Providers/Brands each rolled their own. This unifies the controls so an
// operator's muscle memory transfers between entity types (audit G6 / C1).

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, CSSProperties } from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { FilterBar, EmptyState } from '@/design-system/components';
import type { FilterOption, EmptyVariant } from '@/design-system/components';
import { Skeleton } from './Skeleton';

export interface EntityListSort<T> {
  id: string;
  label: string;
  /** Standard comparator — return <0 to sort `a` before `b`. */
  compare: (a: T, b: T) => number;
}

export interface EntityListShellProps<T> {
  items: T[] | undefined;
  isLoading?: boolean;
  getKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;

  /**
   * Free-text search box. `fields` returns the strings the box matches
   * client-side against `items` — this always runs, even in controlled
   * mode, as a safety net on top of whatever the caller already fetched.
   *
   * Uncontrolled (default): the shell owns the query text itself.
   *
   * Controlled (`value` + `onChange` both set): the caller owns the query
   * text instead — e.g. seeded from a `?q=` deep-link and threaded into
   * the page's data-fetching hook so the list is filtered server-side on
   * arrival, with every further keystroke re-querying too (mirrors
   * Threats.tsx's `?q=` pattern). The box always reflects `value`.
   */
  search?: {
    placeholder?: string;
    fields: (item: T) => Array<string | null | undefined>;
    value?: string;
    onChange?: (value: string) => void;
  };

  /** Sort options rendered as a button group. First is the default. */
  sorts?: EntityListSort<T>[];
  defaultSortId?: string;

  /** Pass-through segment filter pills (server-side or caller-owned state). */
  filters?: FilterOption[];
  activeFilter?: string;
  onFilterChange?: (value: string) => void;

  /** Client-side pagination. Omit/0 to show everything. */
  pageSize?: number;

  /** When set, jump to the page containing this key (deep-link / focus). */
  focusKey?: string | null;

  gridClassName?: string;
  gridStyle?: CSSProperties;
  skeletonCount?: number;
  skeletonClassName?: string;

  empty: {
    icon?: ReactNode;
    title: string;
    subtitle?: string;
    variant?: EmptyVariant;
    action?: { label: string; onClick: () => void; variant?: 'primary' | 'secondary' };
  };

  /** Extra controls placed left of the sort group (e.g. a secondary action). */
  headerActions?: ReactNode;
}

function SortControl({
  sorts,
  activeId,
  onChange,
}: {
  sorts: { id: string; label: string }[];
  activeId: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="font-mono text-[9px] uppercase" style={{ color: 'var(--text-tertiary)' }}>
        Sort:
      </span>
      {sorts.map(s => (
        <button
          key={s.id}
          onClick={() => onChange(s.id)}
          className="font-mono text-[10px] font-semibold px-2 py-0.5 rounded transition-all"
          style={{
            background: activeId === s.id ? 'var(--border-base)' : 'transparent',
            color: activeId === s.id ? 'var(--text-primary)' : 'var(--text-secondary)',
            border: '1px solid var(--border-base)',
          }}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

export function EntityListShell<T>({
  items,
  isLoading = false,
  getKey,
  renderItem,
  search,
  sorts,
  defaultSortId,
  filters,
  activeFilter,
  onFilterChange,
  pageSize = 0,
  focusKey,
  gridClassName,
  gridStyle,
  skeletonCount = 6,
  skeletonClassName = 'h-44 rounded-xl',
  empty,
  headerActions,
}: EntityListShellProps<T>) {
  // Controlled mode (value + onChange both supplied): the caller owns the
  // query text — see the `search` prop doc above. `internalQuery` still
  // exists (and is kept in sync) so the shell behaves identically to
  // before for the uncontrolled callers.
  const isControlledSearch = search?.value !== undefined && !!search?.onChange;
  const [internalQuery, setInternalQuery] = useState(search?.value ?? '');
  const query = isControlledSearch ? (search?.value ?? '') : internalQuery;
  const setQuery = isControlledSearch ? (search?.onChange as (v: string) => void) : setInternalQuery;
  const [sortId, setSortId] = useState(defaultSortId ?? sorts?.[0]?.id ?? '');
  const [page, setPage] = useState(0);

  const all = items ?? [];

  // search → sort. Memoized off the inputs that actually change the result.
  const processed = useMemo(() => {
    let result = all;
    if (search && query.trim()) {
      const q = query.trim().toLowerCase();
      result = result.filter(item =>
        search.fields(item).some(f => (f ?? '').toLowerCase().includes(q)),
      );
    }
    const sort = sorts?.find(s => s.id === sortId);
    if (sort) result = [...result].sort(sort.compare);
    return result;
  }, [all, search, query, sorts, sortId]);

  const total = processed.length;
  const pageCount = pageSize > 0 ? Math.max(1, Math.ceil(total / pageSize)) : 1;

  // Reset to first page whenever the filtered/sorted set changes shape.
  const resetKey = `${query}|${sortId}|${activeFilter ?? ''}|${total}`;
  const lastResetKey = useRef(resetKey);
  useEffect(() => {
    if (lastResetKey.current !== resetKey) {
      lastResetKey.current = resetKey;
      setPage(0);
    }
  }, [resetKey]);

  // Deep-link focus: jump to the page holding the focused key.
  useEffect(() => {
    if (!focusKey || pageSize <= 0) return;
    const idx = processed.findIndex(item => getKey(item) === focusKey);
    if (idx >= 0) setPage(Math.floor(idx / pageSize));
  }, [focusKey, processed, pageSize, getKey]);

  const safePage = Math.min(page, pageCount - 1);
  const visible = pageSize > 0
    ? processed.slice(safePage * pageSize, safePage * pageSize + pageSize)
    : processed;

  const showControls = !!search || !!sorts?.length || !!filters?.length;

  return (
    <div className="space-y-3">
      {showControls && (
        <FilterBar
          search={search ? { value: query, onChange: setQuery, placeholder: search.placeholder } : undefined}
          filters={filters}
          active={activeFilter}
          onChange={onFilterChange}
          actions={
            (headerActions || sorts?.length) ? (
              <div className="flex items-center gap-3 flex-wrap">
                {headerActions}
                {sorts && sorts.length > 0 && (
                  <SortControl
                    sorts={sorts.map(s => ({ id: s.id, label: s.label }))}
                    activeId={sortId}
                    onChange={setSortId}
                  />
                )}
              </div>
            ) : undefined
          }
        />
      )}

      {isLoading ? (
        <div className={gridClassName} style={gridStyle}>
          {Array.from({ length: skeletonCount }).map((_, i) => (
            <Skeleton key={i} className={skeletonClassName} />
          ))}
        </div>
      ) : total === 0 ? (
        <EmptyState
          icon={empty.icon ?? <Search />}
          title={empty.title}
          subtitle={empty.subtitle}
          variant={empty.variant ?? 'clean'}
          action={empty.action}
        />
      ) : (
        <>
          <div className={gridClassName} style={gridStyle}>
            {visible.map(item => (
              <div key={getKey(item)} style={{ display: 'contents' }}>
                {renderItem(item)}
              </div>
            ))}
          </div>

          {pageSize > 0 && pageCount > 1 && (
            <div className="flex items-center justify-between pt-1">
              <span className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                Showing {safePage * pageSize + 1}–{Math.min((safePage + 1) * pageSize, total)} of {total}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={safePage === 0}
                  className="flex items-center gap-1 font-mono text-[10px] uppercase px-2 py-1 rounded transition-all disabled:opacity-30"
                  style={{ border: '1px solid var(--border-base)', color: 'var(--text-secondary)' }}
                >
                  <ChevronLeft size={12} /> Prev
                </button>
                <span className="font-mono text-[10px]" style={{ color: 'var(--text-secondary)' }}>
                  {safePage + 1} / {pageCount}
                </span>
                <button
                  onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))}
                  disabled={safePage >= pageCount - 1}
                  className="flex items-center gap-1 font-mono text-[10px] uppercase px-2 py-1 rounded transition-all disabled:opacity-30"
                  style={{ border: '1px solid var(--border-base)', color: 'var(--text-secondary)' }}
                >
                  Next <ChevronRight size={12} />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
