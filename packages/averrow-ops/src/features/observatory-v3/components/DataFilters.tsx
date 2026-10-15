/**
 * The data filters that do not fit the 44px rail: threat type (multi-select) and brand (picked with the console's own
 * search, restricted to brands), plus the row of removable chips that shows EVERY active filter (severity, type, brand).
 *
 *   TypeMultiSelect      checkboxes for the threat types the map colours; none checked = every type
 *   BrandFilter          the "Find on map" search, brands only: picking one sets the filter instead of selecting a place
 *   DataFiltersPopover   toolbar button ("Filter", with the count of active filters) that holds both, on wide desktops
 *                        where Period + Source sit inline; phones and narrow toolbars put the same body in their
 *                        existing filters card
 *   FilterChips          one chip per active value, each with its own remove button, and "Clear all"
 *
 * State lives in the URL (`sev`, `type`, `brand`, see lib/url-state.ts); this file only renders and reports changes.
 */

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ChevronDown, Filter as FilterIcon, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { ObservatorySearch } from './ObservatorySearch';
import { FILTER_LABEL } from './ToolbarControls';
import { TYPE_OPTIONS, toggleType, type FilterChip } from '../lib/filters';
import { rgbCss, sevText, THREAT_TYPE_COLORS } from '../lib/map-colors';
import type { SearchData, SearchKind, SearchResult } from '../lib/search';

const BRAND_ONLY: readonly SearchKind[] = ['brand'];

export function TypeMultiSelect({ types, onChange, touch = false }: { types: readonly string[]; onChange: (types: string[]) => void; touch?: boolean }) {
  return (
    <fieldset className="m-0 p-0 border-0 flex flex-col gap-1.5" data-filter="type">
      <legend className={cn(FILTER_LABEL, 'p-0 mb-1.5')} style={{ color: 'var(--text-tertiary)' }}>Threat type</legend>
      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
        {TYPE_OPTIONS.map(t => {
          const on = types.includes(t.id);
          return (
            <label
              key={t.id}
              className="ds-focusable flex items-center gap-2 rounded-md px-1.5 font-mono text-[11px] cursor-pointer"
              style={{ minHeight: touch ? 44 : 28, color: on ? 'var(--text-primary)' : 'var(--text-secondary)' }}
            >
              <input
                type="checkbox"
                checked={on}
                onChange={() => onChange(toggleType(types, t.id))}
                className="shrink-0"
                style={{ accentColor: 'var(--amber)', width: 14, height: 14 }}
              />
              <span aria-hidden className="shrink-0 rounded-full" style={{ width: 8, height: 8, background: rgbCss(THREAT_TYPE_COLORS[t.id] ?? [120, 130, 145, 255]) }} />
              <span className="min-w-0 truncate capitalize">{t.label}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export function BrandFilter({ brand, brandName, data, onChange, onActivate, touch = false }: {
  brand: string | null; brandName?: string | null; data: SearchData; onChange: (brandName: string) => void; onActivate?: () => void; touch?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5" data-filter="brand">
      <div className={FILTER_LABEL} style={{ color: 'var(--text-tertiary)' }}>Brand</div>
      <ObservatorySearch
        data={data}
        kinds={BRAND_ONLY}
        label="Filter by brand"
        placeholder="Search brands…"
        flowList
        touch={touch}
        onActivate={onActivate}
        onPick={(r: SearchResult) => onChange(r.label)}
      />
      <div className="font-mono text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
        {brand
          ? <>Showing <span style={{ color: 'var(--amber-text)' }}>{brandName || brand}</span> in arcs and stats (the node layer has no brand split).</>
          : 'Brands on the map are searchable here; pick one to follow it.'}
      </div>
    </div>
  );
}

/** Type + brand, as one block (the body of both the popover and the phone filters card). */
export function DataFiltersBody({ types, brand, brandName, onTypes, onBrand, searchData, onActivate, touch = false }: {
  types: readonly string[]; brand: string | null; brandName?: string | null; onTypes: (types: string[]) => void; onBrand: (brandName: string) => void;
  searchData: SearchData; onActivate?: () => void; touch?: boolean;
}) {
  return (
    <>
      <TypeMultiSelect types={types} onChange={onTypes} touch={touch} />
      <BrandFilter brand={brand} brandName={brandName} data={searchData} onChange={onBrand} onActivate={onActivate} touch={touch} />
    </>
  );
}

const GLASS: CSSProperties = {
  background: 'var(--bg-card)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
  border: '1px solid var(--border-base)', boxShadow: 'var(--card-shadow)',
};

/** Toolbar button + popover for the type / brand filters. `count` = how many filter values are on (all kinds). */
export function DataFiltersPopover({ count, children, touch = false, className }: { count: number; children: ReactNode; touch?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); btnRef.current?.focus(); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        ref={btnRef}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        aria-haspopup="dialog"
        aria-label={count > 0 ? `Data filters: ${count} active` : 'Data filters'}
        onClick={() => setOpen(o => !o)}
        className="ds-focusable inline-flex items-center gap-2 rounded-xl px-3 font-mono text-[11px] cursor-pointer"
        style={{ ...GLASS, height: touch ? 48 : 40, color: count > 0 ? 'var(--amber-text)' : 'var(--text-secondary)' }}
      >
        <FilterIcon size={13} aria-hidden />
        <span>Filter</span>
        {count > 0 && <span className="rounded-full px-1.5" style={{ background: 'color-mix(in srgb, var(--amber) 18%, transparent)', color: 'var(--amber-text)' }}>{count}</span>}
        <ChevronDown size={13} aria-hidden className={cn('shrink-0 transition-transform duration-200 motion-reduce:transition-none', open && 'rotate-180')} style={{ color: 'var(--text-tertiary)' }} />
      </button>
      <div
        id={id}
        role="dialog"
        aria-label="Data filters"
        hidden={!open}
        className="absolute top-full right-0 mt-2 z-40 w-[min(340px,calc(100vw-24px))] max-h-[calc(100dvh-140px)] overflow-y-auto rounded-xl p-3 flex flex-col gap-3 animate-sheet-in motion-reduce:animate-none [&[hidden]]:hidden"
        style={{ background: 'var(--bg-card-deep)', backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)', border: '1px solid var(--border-base)', boxShadow: 'var(--card-shadow-elevated)' }}
      >
        {children}
      </div>
    </div>
  );
}

/** Every active filter as a chip you can remove; "Clear all" once there are two or more. */
export function FilterChips({ chips, onRemove, onClear, touch = false, className, style }: {
  chips: readonly FilterChip[]; onRemove: (chip: FilterChip) => void; onClear: () => void; touch?: boolean; className?: string; style?: CSSProperties;
}) {
  if (chips.length === 0) return null;
  return (
    <div role="group" aria-label="Active filters" data-filter-chips className={cn('flex flex-wrap items-center gap-1.5', className)} style={style}>
      {chips.map(c => (
        <span
          key={c.key}
          data-chip={c.key}
          className="inline-flex items-center gap-1 rounded-full pl-2.5 pr-1 font-mono text-[11px]"
          style={{
            ...GLASS, minHeight: touch ? 36 : 26,
            color: c.kind === 'sev' ? sevText(c.value) : 'var(--text-primary)',
          }}
        >
          <span className="max-w-[160px] truncate">{c.label}</span>
          {c.note && <span className="hidden sm:inline" style={{ color: 'var(--text-tertiary)' }} title={`${c.label} ${c.note}`}>· {c.note}</span>}
          <button
            type="button"
            aria-label={c.removeLabel}
            onClick={() => onRemove(c)}
            className="ds-focusable inline-flex items-center justify-center rounded-full"
            style={{ width: touch ? 32 : 20, height: touch ? 32 : 20, background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer' }}
          >
            <X size={11} aria-hidden />
          </button>
        </span>
      ))}
      {chips.length > 1 && (
        <button
          type="button"
          onClick={onClear}
          className="ds-focusable rounded-full px-2.5 font-mono text-[11px]"
          style={{ ...GLASS, minHeight: touch ? 36 : 26, color: 'var(--text-secondary)', cursor: 'pointer' }}
        >
          Clear all
        </button>
      )}
    </div>
  );
}
