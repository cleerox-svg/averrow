// v4 command palette (⌘K). Hand-rolled, no new dependency.
//
// Opens on ⌘K / Ctrl-K, on clicking the topbar search box, or the mobile
// search icon. Two result sources are combined into one flat,
// keyboard-navigable list:
//   1. Static nav commands (unchanged, instant, client-side filtered) — a
//      flat list of navigation destinations supplied by ShellV4.
//   2. Live data search (T3/T4) — brands / threat actors / providers /
//      campaigns from GET /api/search, rendered below the nav matches once
//      the query is >=2 chars, via useGlobalSearch.
//
// Fully keyboard driven: ↑/↓ to move across BOTH sources, Enter to go
// (or jump to "View all results" for a data group), Esc to close.
//
// The nav command list is supplied by ShellV4 so it inherits the same
// role-gating the sidebar applies — nothing here re-derives permissions.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, CornerDownLeft, Loader2, Building2, Network, Server, Megaphone, ArrowRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useGlobalSearch, type SearchResultType } from '@/hooks/useGlobalSearch';

export interface PaletteCommand {
  label: string;
  to: string;
  /** Group heading shown in the list (e.g. "SOC Console"). */
  group: string;
  icon?: LucideIcon;
  /** Extra search terms that should match this command but aren't in the label. */
  keywords?: string;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: PaletteCommand[];
}

function scoreMatch(cmd: PaletteCommand, q: string): boolean {
  if (!q) return true;
  const haystack = `${cmd.label} ${cmd.group} ${cmd.keywords ?? ''} ${cmd.to}`.toLowerCase();
  // every whitespace-separated token must appear somewhere
  return q.split(/\s+/).filter(Boolean).every(tok => haystack.includes(tok));
}

// Data-group display config, in the fixed render order BRANDS → THREAT
// ACTORS → PROVIDERS → CAMPAIGNS. `routeFor` is the destination for
// selecting an individual row; `viewAllTo` is the "view all" row target.
//
// NONE of /brands, /threat-actors, /providers, /campaigns currently read a
// `?q=` search param (verified against Brands.tsx / ThreatActors.tsx /
// Providers.tsx / Campaigns.tsx — only `?focus=` is wired, for
// deep-linking a single entity). "View all" therefore routes to the bare
// list rather than a `?q=` that would silently do nothing. Wiring those
// list pages to read `?q=` is later-tier work.
const DATA_GROUPS: Array<{
  type: SearchResultType;
  heading: string;
  icon: LucideIcon;
  routeFor: (id: string) => string;
  viewAllTo: string;
}> = [
  { type: 'brand', heading: 'BRANDS', icon: Building2, routeFor: id => `/brands/${id}`, viewAllTo: '/brands' },
  { type: 'threat_actor', heading: 'THREAT ACTORS', icon: Network, routeFor: id => `/threat-actors?focus=${id}`, viewAllTo: '/threat-actors' },
  { type: 'provider', heading: 'PROVIDERS', icon: Server, routeFor: id => `/providers?focus=${id}`, viewAllTo: '/providers' },
  { type: 'campaign', heading: 'CAMPAIGNS', icon: Megaphone, routeFor: id => `/campaigns/${id}`, viewAllTo: '/campaigns' },
];

const MAX_ROWS_PER_GROUP = 5;

// One flattened, keyboard-navigable + renderable entry. Every row — a
// static nav command, a live data result, or a "view all" trailer —
// normalizes to this shape so the list is a single map() with one active
// index shared across both sources.
interface FlatEntry {
  key: string;
  heading: string;
  icon?: LucideIcon;
  label: string;
  sublabel?: string | null;
  to: string;
  viewAll?: boolean;
}

export function CommandPalette({ open, onClose, commands }: CommandPaletteProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const { brands, threatActors, providers, campaigns, isLoading } = useGlobalSearch(query);

  // reset state each time the palette opens
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      // focus after the element is painted
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  const trimmedQuery = query.trim();
  const dataSectionActive = trimmedQuery.length >= 2;

  const groupResults: Record<SearchResultType, typeof brands> = {
    brand: brands,
    threat_actor: threatActors,
    provider: providers,
    campaign: campaigns,
  };
  // The single combined, ordered list that keyboard nav + rendering both
  // walk: nav matches first (unchanged mechanism), then each data group's
  // rows + trailing "view all" row, in BRANDS / THREAT ACTORS / PROVIDERS /
  // CAMPAIGNS order.
  const flat: FlatEntry[] = useMemo(() => {
    const navFiltered = commands.filter(c => scoreMatch(c, trimmedQuery.toLowerCase()));
    const entries: FlatEntry[] = navFiltered.map(cmd => ({
      key: `nav:${cmd.to}`,
      heading: cmd.group,
      icon: cmd.icon,
      label: cmd.label,
      to: cmd.to,
    }));
    if (!dataSectionActive) return entries;
    for (const group of DATA_GROUPS) {
      const rows = groupResults[group.type].slice(0, MAX_ROWS_PER_GROUP);
      if (rows.length === 0) continue;
      for (const result of rows) {
        entries.push({
          key: `${group.type}:${result.id}`,
          heading: group.heading,
          icon: group.icon,
          label: result.label,
          sublabel: result.sublabel,
          to: group.routeFor(result.id),
        });
      }
      entries.push({
        key: `viewall:${group.type}`,
        heading: group.heading,
        icon: ArrowRight,
        label: `View all results for “${trimmedQuery}”`,
        to: group.viewAllTo,
        viewAll: true,
      });
    }
    return entries;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commands, trimmedQuery, dataSectionActive, brands, threatActors, providers, campaigns]);

  // keep the active index in range: reset to top on every new query, then
  // clamp down (never up) as the data-driven tail streams in/out.
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    setActive(i => Math.min(i, Math.max(flat.length - 1, 0)));
  }, [flat.length]);

  // scroll the active row into view
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  if (!open) return null;

  const go = (entry: FlatEntry | undefined) => {
    if (!entry) return;
    onClose();
    navigate(entry.to);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(i => Math.min(i + 1, flat.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(flat[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  const showEmpty = flat.length === 0 && !(dataSectionActive && isLoading);

  // group consecutive rows under their heading
  let lastHeading: string | null = null;

  return (
    <div className="cmdk-overlay" onMouseDown={onClose} role="presentation">
      <div
        className="cmdk-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="cmdk-search">
          <Search size={16} strokeWidth={2} />
          <input
            ref={inputRef}
            className="cmdk-input"
            placeholder="Search pages — threats, brands, actors, agents…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoComplete="off"
          />
          {dataSectionActive && isLoading && (
            <Loader2 size={14} strokeWidth={2} className="cmdk-loading animate-spin" aria-label="Searching…" />
          )}
          <kbd className="cmdk-esc">ESC</kbd>
        </div>

        <div className="cmdk-list" ref={listRef}>
          {showEmpty && (
            <div className="cmdk-empty">No matches for “{query}”.</div>
          )}
          {flat.map((entry, i) => {
            const Icon = entry.icon;
            const showHeading = entry.heading !== lastHeading;
            lastHeading = entry.heading;
            return (
              <div key={entry.key}>
                {showHeading && <div className="cmdk-group">{entry.heading}</div>}
                <button
                  type="button"
                  data-idx={i}
                  className={'cmdk-item' + (entry.viewAll ? ' cmdk-viewall' : '') + (i === active ? ' active' : '')}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(entry)}
                >
                  {Icon && <Icon size={16} strokeWidth={2} className="cmdk-item-icon" />}
                  <span className="cmdk-item-text">
                    <span className="cmdk-item-label">{entry.label}</span>
                    {entry.sublabel && <span className="cmdk-item-sublabel">{entry.sublabel}</span>}
                  </span>
                  {i === active && <CornerDownLeft size={13} strokeWidth={2} className="cmdk-item-enter" />}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
