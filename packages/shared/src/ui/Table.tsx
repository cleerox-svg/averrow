import * as React from 'react';
import { cn } from './cn';

// ── Low-level primitives ─────────────────────────────────────────────────
// API-compatible with averrow-ops `components/ui/Table.tsx` (children +
// className), widened to accept native element props so PR6 can swap them in.

export interface TableProps extends React.TableHTMLAttributes<HTMLTableElement> {
  /** When set, the scroll wrapper becomes a focusable labelled region so
   *  keyboard users can scroll wide tables. */
  label?: string;
  wrapperClassName?: string;
}

export function Table({ children, className, label, wrapperClassName, ...props }: TableProps) {
  return (
    <div
      className={cn(
        'overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--amber-text)]',
        wrapperClassName,
      )}
      {...(label ? { tabIndex: 0, role: 'region', 'aria-label': label } : {})}
    >
      <table className={cn('w-full border-collapse', className)} {...props}>{children}</table>
    </div>
  );
}

export const Th = React.forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(
  ({ children, className, style, scope = 'col', ...props }, ref) => (
    <th
      ref={ref}
      scope={scope}
      style={{ color: 'var(--text-secondary)', ...style }}
      className={cn(
        'font-mono text-[11px] font-semibold uppercase tracking-wider px-3 py-2.5 text-left border-b border-[var(--border-base)]',
        className,
      )}
      {...props}
    >
      {children}
    </th>
  ),
);
Th.displayName = 'Th';

export const Td = React.forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(
  ({ children, className, ...props }, ref) => (
    <td
      ref={ref}
      className={cn('px-3 py-2.5 text-sm text-[var(--text-primary)] border-b border-[var(--border-base)]', className)}
      {...props}
    >
      {children}
    </td>
  ),
);
Td.displayName = 'Td';

// ── Column-driven DataTable ──────────────────────────────────────────────

export type SortDir = 'asc' | 'desc';
export interface SortState { key: string; dir: SortDir }
export type RowSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  align?: 'left' | 'right' | 'center';
  /** Explicit override; defaults to `!!sortAccessor`. Set true on a column
   *  with no accessor for server-side sort (parent handles `onSortChange`). */
  sortable?: boolean;
  /** Sort value. Severity/status columns should return a rank, not a label. */
  sortAccessor?: (row: T) => string | number | null | undefined;
  render: (row: T) => React.ReactNode;
  /** CSS width (e.g. 120, '8rem'). */
  width?: number | string;
  cellClassName?: string;
}

export type TableDensity = 'compact' | 'comfortable';

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  getRowKey: (row: T) => string;
  initialSort?: SortState;
  /** Controlled sort. Rows are sorted client-side only for columns that have a
   *  `sortAccessor`; omit accessors for server-side sort. */
  sort?: SortState | null;
  onSortChange?: (sort: SortState) => void;
  onRowClick?: (row: T) => void;
  /** Sets `data-severity` so the standard severity-coloured hover applies. */
  rowSeverity?: (row: T) => RowSeverity | null | undefined;
  /** Accessible name for a clickable row. Defaults to the first column's text. */
  rowLabel?: (row: T) => string;
  /** Screen-reader-only caption; also labels the scroll region. */
  caption?: string;
  density?: TableDensity;
  className?: string;
  /** Rendered in a full-width row when `rows` is empty. */
  empty?: React.ReactNode;
}

const ALIGN = { left: 'text-left', right: 'text-right', center: 'text-center' } as const;

// Standard data-row hover (AVERROW_UI_STANDARD "Table row standard"): amber
// left rail + soft gradient; severity rows swap the amber for the severity hue.
const ROW_BASE =
  'transition-colors duration-100 motion-reduce:transition-none [&>td:first-child]:border-l-2 [&>td:first-child]:border-l-transparent ' +
  'hover:[background:linear-gradient(90deg,rgba(229,168,50,0.04)_0%,transparent_40%)] hover:[&>td:first-child]:border-l-[rgba(229,168,50,0.45)] ' +
  'data-[severity=critical]:hover:[background:linear-gradient(90deg,rgba(239,68,68,0.06)_0%,transparent_40%)] data-[severity=critical]:hover:[&>td:first-child]:border-l-[rgba(239,68,68,0.50)] ' +
  'data-[severity=high]:hover:[background:linear-gradient(90deg,rgba(249,115,22,0.06)_0%,transparent_40%)] data-[severity=high]:hover:[&>td:first-child]:border-l-[rgba(249,115,22,0.50)] ' +
  'data-[severity=medium]:hover:[background:linear-gradient(90deg,rgba(229,168,50,0.06)_0%,transparent_40%)] data-[severity=medium]:hover:[&>td:first-child]:border-l-[rgba(229,168,50,0.50)] ' +
  'data-[severity=low]:hover:[background:linear-gradient(90deg,rgba(59,130,246,0.06)_0%,transparent_40%)] data-[severity=low]:hover:[&>td:first-child]:border-l-[rgba(59,130,246,0.50)]';

const FOCUS_RING = 'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--amber-text)]';

function SortIcon({ dir }: { dir: SortDir | null }) {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: dir ? 1 : 0.35 }}>
      {dir === 'asc' && <path d="M3 7.5 6 4.5l3 3" />}
      {dir === 'desc' && <path d="M3 4.5 6 7.5l3-3" />}
      {dir === null && <path d="M3 4.5 6 2l3 2.5M3 7.5 6 10l3-2.5" />}
    </svg>
  );
}

export function DataTable<T>({
  columns, rows, getRowKey, initialSort, sort, onSortChange, onRowClick,
  rowSeverity, rowLabel, caption, density = 'comfortable', className, empty,
}: DataTableProps<T>) {
  const [internal, setInternal] = React.useState<SortState | null>(initialSort ?? null);
  const controlled = sort !== undefined;
  const current = controlled ? sort : internal;

  const sorted = React.useMemo(() => {
    const col = current ? columns.find((c) => c.key === current.key) : undefined;
    if (!current || !col?.sortAccessor) return rows;
    const acc = col.sortAccessor;
    const factor = current.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = acc(a); const bv = acc(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1; // nulls always last
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * factor;
      return String(av).localeCompare(String(bv)) * factor;
    });
  }, [rows, columns, current]);

  // First click on a new column sorts DESCENDING (highest first, so the worst
  // severity/rank leads); subsequent clicks flip asc/desc. Intentional.
  const toggle = (col: Column<T>) => {
    const next: SortState = current?.key === col.key
      ? { key: col.key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
      : { key: col.key, dir: 'desc' };
    if (!controlled) setInternal(next);
    onSortChange?.(next);
  };

  // The scroll region is only a tab stop when it actually overflows.
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const [overflows, setOverflows] = React.useState(false);
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollWidth > el.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const table = el.firstElementChild;
    if (table) ro.observe(table);
    return () => ro.disconnect();
  }, [rows, columns]);

  const uid = React.useId();

  const pad = density === 'compact' ? 'px-3 py-1.5' : 'px-4 py-2.5';

  const handleRowKey = (e: React.KeyboardEvent<HTMLTableRowElement>, row: T) => {
    if (e.target !== e.currentTarget) return; // let inner controls keep their keys
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onRowClick?.(row);
    }
  };

  return (
    <div className={cn('rounded-xl border border-[var(--border-base)] bg-[var(--bg-card)] overflow-hidden', className)}>
      <div
        ref={scrollRef}
        className={cn('overflow-x-auto', FOCUS_RING)}
        tabIndex={overflows ? 0 : undefined}
        role="region"
        aria-label={caption ?? 'Data table'}
      >
        <table className="w-full text-[12px] border-collapse">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr className="border-b border-[var(--border-base)] bg-[var(--bg-card-deep,transparent)]">
              {columns.map((col) => {
                const sortable = col.sortable ?? !!col.sortAccessor;
                const active = current?.key === col.key;
                const dir = active ? current.dir : null;
                return (
                  <th
                    key={col.key}
                    scope="col"
                    aria-sort={sortable ? (dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none') : undefined}
                    style={{ width: col.width, color: active ? 'var(--amber)' : 'var(--text-secondary)' }}
                    className={cn('font-mono text-[10px] uppercase tracking-[0.12em] font-normal select-none', ALIGN[col.align ?? 'left'], !sortable && pad)}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        onClick={() => toggle(col)}
                        className={cn(
                          'inline-flex w-full items-center gap-1 uppercase tracking-[0.12em] hover:text-[var(--text-primary)]',
                          pad, FOCUS_RING,
                          col.align === 'right' && 'flex-row-reverse',
                          col.align === 'center' && 'justify-center',
                        )}
                      >
                        {col.header}
                        <SortIcon dir={dir} />
                      </button>
                    ) : (
                      col.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && empty && (
              <tr><td colSpan={columns.length} className="px-4 py-6 text-center text-[var(--text-tertiary)]">{empty}</td></tr>
            )}
            {sorted.map((row, ri) => {
              const sev = rowSeverity?.(row) ?? undefined;
              return (
                <tr
                  key={getRowKey(row)}
                  data-severity={sev}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={onRowClick ? (e) => handleRowKey(e, row) : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  role={onRowClick ? 'button' : undefined}
                  // Custom label wins; otherwise the first cell's text names the row.
                  aria-label={onRowClick && rowLabel ? rowLabel(row) : undefined}
                  aria-labelledby={onRowClick && !rowLabel ? `${uid}-r${ri}` : undefined}
                  className={cn(
                    'border-b border-[var(--border-base)] last:border-b-0',
                    ROW_BASE,
                    onRowClick && cn('cursor-pointer', FOCUS_RING),
                  )}
                >
                  {columns.map((col, ci) => (
                    <td
                      key={col.key}
                      id={ci === 0 && onRowClick && !rowLabel ? `${uid}-r${ri}` : undefined}
                      className={cn('align-middle text-[var(--text-primary)]', pad, ALIGN[col.align ?? 'left'], col.cellClassName)}
                    >
                      {col.render(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
