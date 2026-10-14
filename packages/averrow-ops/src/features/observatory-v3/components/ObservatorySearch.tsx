/**
 * Observatory search: countries, brands, ASNs, operations, providers, actors and
 * campaigns over data already loaded on the page. An ARIA combobox: the input
 * owns focus, arrow keys move the active option, Enter picks, Esc closes.
 * Picking a result selects it (and switches lens if needed) via `onPick`.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { buildSearchIndex, runSearch, kindNoun, type SearchData, type SearchResult } from '../lib/search';

export interface ObservatorySearchProps {
  data: SearchData;
  onPick: (result: SearchResult) => void;
  /** Called the first time the field gets focus (the page can load lens data for it). */
  onActivate?: () => void;
  className?: string;
  /** Full-width, 44px (mobile). */
  touch?: boolean;
}

export function ObservatorySearch({ data, onPick, onActivate, className, touch = false }: ObservatorySearchProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const activated = useRef(false);
  const listId = useId();

  const index = useMemo(() => buildSearchIndex(data), [data]);
  const results = useMemo(() => runSearch(index, query), [index, query]);

  useEffect(() => { setActive(0); }, [query]);

  // Close on an outside pointer.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [open]);

  const pick = useCallback((r: SearchResult) => {
    onPick(r);
    setOpen(false);
    setQuery('');
    inputRef.current?.blur();
  }, [onPick]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive(i => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(i => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      const r = results[active];
      if (open && r) { e.preventDefault(); pick(r); }
    } else if (e.key === 'Escape') {
      if (open || query) {
        e.preventDefault();
        e.stopPropagation();
        if (open) setOpen(false); else setQuery('');
      }
    }
  };

  const showList = open && query.trim().length >= 2;
  const optionId = (i: number) => `${listId}-opt-${i}`;

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <div
        className="flex items-center gap-2 rounded-xl px-3"
        style={{
          background: 'var(--card-bg, var(--bg-card))',
          border: '1px solid var(--border-base)',
          backdropFilter: 'blur(20px)',
          minHeight: touch ? 44 : 36,
        }}
      >
        <Search size={13} aria-hidden style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label="Search the map"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && results[active] ? optionId(active) : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder="Search brand, ASN, country, operation…"
          value={query}
          onChange={e => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => {
            setOpen(true);
            if (!activated.current) { activated.current = true; onActivate?.(); }
          }}
          onKeyDown={onKeyDown}
          className="flex-1 min-w-0 bg-transparent outline-none font-mono text-[11px] ds-focusable"
          style={{ color: 'var(--text-primary)', border: 'none' }}
        />
        {query && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => { setQuery(''); inputRef.current?.focus(); }}
            className="ds-focusable inline-flex items-center justify-center shrink-0"
            style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', minWidth: touch ? 32 : 20, minHeight: touch ? 32 : 20 }}
          >
            <X size={12} />
          </button>
        )}
      </div>

      {showList && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Search results"
          className="absolute left-0 right-0 mt-1 rounded-xl overflow-hidden list-none p-1 m-0"
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-base)',
            boxShadow: 'var(--card-shadow)',
            zIndex: 60,
            maxHeight: 320,
            overflowY: 'auto',
          }}
        >
          {results.length === 0 ? (
            <li role="presentation" className="px-3 py-2 font-mono text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
              Nothing loaded matches &ldquo;{query.trim()}&rdquo;
            </li>
          ) : results.map((r, i) => (
            <li
              key={r.key}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onMouseDown={e => e.preventDefault()}
              onClick={() => pick(r)}
              className="flex items-center gap-2 rounded-lg px-2.5 cursor-pointer"
              style={{
                minHeight: touch ? 44 : 34,
                background: i === active ? 'color-mix(in srgb, var(--amber) 12%, transparent)' : 'transparent',
              }}
            >
              <span
                className="font-mono text-[9px] uppercase tracking-wider rounded px-1.5 py-0.5 shrink-0"
                style={{ border: '1px solid var(--border-base)', color: 'var(--text-tertiary)' }}
              >
                {kindNoun(r.kind)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs truncate" style={{ color: 'var(--text-primary)' }}>{r.label}</span>
                {r.sublabel && <span className="block font-mono text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>{r.sublabel}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
