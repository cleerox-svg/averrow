/**
 * "Find on map": countries, brands, ASNs, operations, providers, actors and
 * campaigns over data already loaded on the page. An ARIA combobox: the input
 * owns focus, arrow keys move the active option, Enter picks, Esc closes.
 * Picking a result selects it (and switches lens if needed) via `onPick`.
 *
 * Narrow toolbars fold it to an icon button; the field then opens in a popover
 * under the button. Either way `openerRef` points at the stable control (the input,
 * or the icon button) so the drill drawer can hand focus back to it.
 *
 * Combobox contract: the listbox element is always rendered (hidden while closed)
 * so `aria-controls` never dangles; `aria-haspopup="listbox"`; a polite status
 * region announces the result count as you type.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { buildSearchIndex, runSearch, kindNoun, type SearchData, type SearchKind, type SearchResult } from '../lib/search';

export interface ObservatorySearchProps {
  data: SearchData;
  onPick: (result: SearchResult) => void;
  /** Called the first time the field gets focus (the page can load lens data for it). */
  onActivate?: () => void;
  className?: string;
  /** 44px field (phone). */
  touch?: boolean;
  /** Fold to an icon button; the field opens in a popover. */
  collapsed?: boolean;
  /** Set to the stable control (input, or the icon button when collapsed) for focus return. */
  openerRef?: MutableRefObject<HTMLElement | null>;
  /** Phone: the field is shown open in-flow (the page toggles it), no popover chrome. */
  inline?: boolean;
  /** Only offer results of these kinds (the brand filter picks `['brand']`). Default: every kind. */
  kinds?: readonly SearchKind[];
  /** Field label and placeholder (default "Find on map"): a second search on the page needs its own accessible name. */
  label?: string;
  placeholder?: string;
  /** Show the results in the flow of the page instead of floating over it (inside a scrolling popover a floating list is clipped). */
  flowList?: boolean;
}

export function ObservatorySearch({ data, onPick, onActivate, className, touch = false, collapsed = false, openerRef, inline = false, kinds, label = 'Find on map', placeholder, flowList = false }: ObservatorySearchProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [popover, setPopover] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const activated = useRef(false);
  const listId = useId();

  const index = useMemo(() => buildSearchIndex(data), [data]);
  const allResults = useMemo(() => runSearch(index, query), [index, query]);
  const results = useMemo(() => (kinds ? allResults.filter(r => kinds.includes(r.kind)) : allResults), [allResults, kinds]);

  useEffect(() => { setActive(0); }, [query]);

  // The stable control focus returns to.
  const setOpener = useCallback(() => {
    if (openerRef) openerRef.current = collapsed && !inline ? buttonRef.current : inputRef.current;
  }, [openerRef, collapsed, inline]);
  useEffect(() => {
    setOpener();
    return () => { if (openerRef) openerRef.current = null; };
  });

  const activate = useCallback(() => {
    if (!activated.current) { activated.current = true; onActivate?.(); }
  }, [onActivate]);

  // Close on an outside pointer.
  useEffect(() => {
    if (!open && !popover) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) { setOpen(false); setPopover(false); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [open, popover]);

  // The popover input takes focus as it opens.
  useEffect(() => { if (popover) inputRef.current?.focus(); }, [popover]);

  const pick = useCallback((r: SearchResult) => {
    onPick(r);
    setOpen(false);
    setQuery('');
    if (collapsed && !inline) {
      setPopover(false);
      buttonRef.current?.focus({ preventScroll: true });
    }
    // Wide layout: the input KEEPS focus, so the drawer that opens remembers it as its opener.
  }, [onPick, collapsed, inline]);

  const showList = open && query.trim().length >= 2;

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
      if (showList || query) {
        e.preventDefault();
        e.stopPropagation();
        if (showList) setOpen(false); else setQuery('');
      } else if (popover) {
        e.preventDefault();
        e.stopPropagation();
        setPopover(false);
        buttonRef.current?.focus({ preventScroll: true });
      }
    }
  };

  const optionId = (i: number) => `${listId}-opt-${i}`;
  const folded = collapsed && !inline;

  const field = (
    <div
      className="flex items-center gap-2 rounded-xl px-3"
      style={{
        background: 'var(--card-bg, var(--bg-card))',
        border: '1px solid var(--border-base)',
        backdropFilter: 'blur(20px)',
        minHeight: touch ? 44 : 36,
        boxShadow: folded ? 'var(--card-shadow-elevated)' : undefined,
      }}
    >
      <Search size={13} aria-hidden style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label={label}
        aria-expanded={showList}
        aria-controls={listId}
        aria-haspopup="listbox"
        aria-autocomplete="list"
        aria-activedescendant={showList && results[active] ? optionId(active) : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder ?? `${label}…`}
        value={query}
        onChange={e => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => { setOpen(true); activate(); }}
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
  );

  const list = (
    <>
      <ul
        id={listId}
        role="listbox"
        aria-label="Search results"
        hidden={!showList}
        className={cn('left-0 right-0 mt-1 rounded-xl overflow-hidden list-none p-1 m-0', flowList ? 'relative' : 'absolute')}
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
              className="font-mono text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5 shrink-0"
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
      <div role="status" aria-live="polite" className="sr-only">
        {showList ? (results.length === 0 ? 'No results' : `${results.length} result${results.length === 1 ? '' : 's'}`) : ''}
      </div>
    </>
  );

  if (folded) {
    return (
      <div ref={rootRef} className={cn('relative', className)}>
        <button
          ref={buttonRef}
          type="button"
          aria-label="Find on map"
          aria-expanded={popover}
          aria-haspopup="dialog"
          title="Find on map"
          onClick={() => { activate(); setPopover(p => !p); }}
          className="ds-focusable inline-flex items-center justify-center rounded-xl"
          style={{
            width: touch ? 44 : 40, height: touch ? 44 : 40,
            background: 'var(--bg-card)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
            border: '1px solid var(--border-base)', boxShadow: 'var(--card-shadow)',
            color: popover ? 'var(--amber-text)' : 'var(--text-secondary)', cursor: 'pointer',
          }}
        >
          <Search size={15} />
        </button>
        {popover && (
          <div className="absolute right-0 top-full mt-2 w-[min(340px,calc(100vw-24px))] z-40">
            <div className="relative">{field}{list}</div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      {field}
      {list}
    </div>
  );
}
