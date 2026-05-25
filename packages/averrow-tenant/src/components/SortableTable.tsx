// Reusable sortable, polished data table for tenant surfaces.
//
// Column-driven: each column supplies a header, a cell renderer, and an
// optional sortAccessor (so severity/status columns can sort by rank, not
// alphabetically). Click a header to sort; click again to flip direction.
// Styling matches the tenant design system (bg-card, mono headers, subtle
// row hover) and is denser + more finished than a plain <table>.

import { useMemo, useState, type ReactNode } from 'react';
import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';

export interface Column<T> {
  key:           string;
  header:        string;
  align?:        'left' | 'right' | 'center';
  sortable?:     boolean;
  /** Value used for sorting. Defaults to undefined → column not sortable. */
  sortAccessor?: (row: T) => string | number | null | undefined;
  render:        (row: T) => ReactNode;
  /** Tailwind width/utility classes for the cell + header (e.g. 'w-32'). */
  cellClassName?: string;
  widthClassName?: string;
}

interface SortableTableProps<T> {
  columns:     Column<T>[];
  rows:        T[];
  getRowKey:   (row: T) => string;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  onRowClick?: (row: T) => void;
}

export function SortableTable<T>({
  columns, rows, getRowKey, initialSort, onRowClick,
}: SortableTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(initialSort?.key ?? null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(initialSort?.dir ?? 'desc');

  const sorted = useMemo(() => {
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.sortAccessor) return rows;
    const acc = col.sortAccessor;
    const factor = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = acc(a); const bv = acc(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;          // nulls always last
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * factor;
      return String(av).localeCompare(String(bv)) * factor;
    });
  }, [rows, columns, sortKey, sortDir]);

  const toggle = (col: Column<T>) => {
    if (!col.sortAccessor) return;
    if (sortKey === col.key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(col.key);
      setSortDir('desc');
    }
  };

  const alignCls = (a?: 'left' | 'right' | 'center') =>
    a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left';

  return (
    <div className="rounded-xl border border-white/[0.07] bg-bg-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-[12px] border-collapse">
          <thead>
            <tr className="border-b border-white/[0.08] bg-white/[0.025]">
              {columns.map((col) => {
                const active = sortKey === col.key;
                const sortable = !!col.sortAccessor;
                return (
                  <th
                    key={col.key}
                    onClick={() => toggle(col)}
                    className={[
                      'px-4 py-2.5 text-[10px] uppercase tracking-[0.12em] font-mono font-normal select-none',
                      alignCls(col.align),
                      col.widthClassName ?? '',
                      sortable ? 'cursor-pointer hover:text-white/80' : '',
                      active ? 'text-amber' : 'text-white/45',
                    ].join(' ')}
                  >
                    <span className={`inline-flex items-center gap-1 ${col.align === 'right' ? 'flex-row-reverse' : ''}`}>
                      {col.header}
                      {sortable && (
                        active
                          ? (sortDir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />)
                          : <ChevronsUpDown size={11} className="opacity-30" />
                      )}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr
                key={getRowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={[
                  'border-b border-white/[0.04] last:border-b-0 transition-colors',
                  onRowClick ? 'cursor-pointer hover:bg-white/[0.04]' : 'hover:bg-white/[0.02]',
                ].join(' ')}
              >
                {columns.map((col) => (
                  <td key={col.key} className={`px-4 py-2.5 align-middle ${alignCls(col.align)} ${col.cellClassName ?? ''}`}>
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Shared cell pills (consistent across tables) ──────────────────

export const SEVERITY_RANK: Record<string, number> = {
  critical: 4, high: 3, medium: 2, low: 1, info: 0,
};

export function SeverityPill({ severity }: { severity: string | null }) {
  const sev = (severity ?? '').toLowerCase();
  const tone =
    sev === 'critical' ? 'text-sev-critical bg-sev-critical/[0.12] border-sev-critical/[0.25]' :
    sev === 'high'     ? 'text-amber        bg-amber/[0.12]        border-amber/[0.25]'        :
    sev === 'medium'   ? 'text-amber/70     bg-amber/[0.07]        border-amber/[0.15]'        :
                         'text-white/55     bg-white/[0.04]        border-white/[0.10]';
  return (
    <span className={`inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${tone}`}>
      {sev || '—'}
    </span>
  );
}

export function Pill({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'crit' | 'warn' | 'ok' | 'info' }) {
  const cls =
    tone === 'crit' ? 'text-sev-critical bg-sev-critical/[0.10] border-sev-critical/[0.22]' :
    tone === 'warn' ? 'text-amber        bg-amber/[0.10]        border-amber/[0.22]'        :
    tone === 'ok'   ? 'text-green/80     bg-green/[0.10]        border-green/[0.22]'        :
    tone === 'info' ? 'text-blue/85      bg-blue/[0.08]         border-blue/[0.18]'         :
                      'text-white/60     bg-white/[0.04]        border-white/[0.10]';
  return (
    <span className={`inline-flex items-center text-[10px] uppercase tracking-widest font-mono border rounded px-1.5 py-0.5 ${cls}`}>
      {children}
    </span>
  );
}
