import * as React from 'react';
import { cn } from '../cn';
import { Dialog } from './Dialog';
import { useIsCompact } from './useMediaQuery';

// Searchable IANA time zone picker (ACCOUNT_DESIGN_SPEC §4.8). Native <select>
// would be unusable with ~420 zones, so this is the one custom combobox: the
// trigger looks like a Select, the list opens in a bottom Sheet on narrow/coarse
// screens and a 360px Dialog on desktop.

const FALLBACK_ZONES = [
  'UTC', 'Africa/Cairo', 'Africa/Johannesburg', 'Africa/Lagos', 'Africa/Nairobi',
  'America/Anchorage', 'America/Argentina/Buenos_Aires', 'America/Bogota', 'America/Chicago',
  'America/Denver', 'America/Halifax', 'America/Los_Angeles', 'America/Mexico_City',
  'America/New_York', 'America/Phoenix', 'America/Sao_Paulo', 'America/St_Johns', 'America/Toronto',
  'America/Vancouver', 'America/Winnipeg', 'Asia/Bangkok', 'Asia/Dhaka', 'Asia/Dubai',
  'Asia/Hong_Kong', 'Asia/Jakarta', 'Asia/Jerusalem', 'Asia/Karachi', 'Asia/Kolkata',
  'Asia/Manila', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Tehran', 'Asia/Tokyo',
  'Atlantic/Azores', 'Atlantic/Reykjavik', 'Australia/Adelaide', 'Australia/Brisbane',
  'Australia/Perth', 'Australia/Sydney', 'Europe/Amsterdam', 'Europe/Athens', 'Europe/Berlin',
  'Europe/Dublin', 'Europe/Istanbul', 'Europe/Lisbon', 'Europe/London', 'Europe/Madrid',
  'Europe/Moscow', 'Europe/Paris', 'Europe/Rome', 'Europe/Stockholm', 'Europe/Zurich',
  'Pacific/Auckland', 'Pacific/Fiji', 'Pacific/Honolulu',
];

/** All IANA zones the runtime knows, plus UTC. Static fallback when `Intl.supportedValuesOf` is missing. */
export function listTimeZones(): string[] {
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    const zones = intl.supportedValuesOf?.('timeZone');
    if (zones && zones.length > 0) return zones.includes('UTC') ? zones : ['UTC', ...zones];
  } catch {
    /* fall through to the static list */
  }
  return FALLBACK_ZONES;
}

/** The browser's current IANA zone, or null when it can't be resolved. */
export function detectTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** Offset of `tz` from UTC at `date`, in minutes (east positive). Null for an invalid zone. */
function offsetMinutes(tz: string, date: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(date);
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    const base = Math.floor(date.getTime() / 1000) * 1000;
    return Math.round((asUtc - base) / 60000);
  } catch {
    return null;
  }
}

function formatOffset(minutes: number): string {
  if (minutes === 0) return 'UTC';
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

function cityOf(tz: string): string {
  const last = tz.split('/').pop() ?? tz;
  return last.replace(/_/g, ' ');
}

/**
 * "Toronto (UTC-5)" — city + the offset in effect at `date` (DST-aware).
 * UTC itself reads "UTC". An unknown zone is returned unchanged.
 */
export function formatTimeZoneLabel(tz: string, date: Date = new Date()): string {
  const off = offsetMinutes(tz, date);
  if (off === null) return tz;
  if (tz === 'UTC' || tz === 'Etc/UTC') return 'UTC';
  return `${cityOf(tz)} (${formatOffset(off)})`;
}

function regionOf(tz: string): string {
  const first = tz.split('/')[0] ?? tz;
  if (!tz.includes('/')) return 'Other';
  if (first === 'America') return 'Americas';
  if (first === 'Etc') return 'Other';
  return first;
}

interface ZoneRow {
  tz: string;
  label: string;
  region: string;
}

function matches(row: ZoneRow, q: string): boolean {
  if (!q) return true;
  const hay = `${row.label} ${row.tz.replace(/_/g, ' ')} ${row.region}`.toLowerCase();
  return q.split(/\s+/).every((tok) => hay.includes(tok));
}

export interface TimezoneSelectProps {
  /** IANA zone id, e.g. `America/Toronto`. */
  value: string;
  onChange: (tz: string) => void;
  id?: string;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
  /** Sheet/dialog heading. */
  title?: string;
  /** Test/SSR override of the detected zone. */
  detectedZone?: string | null;
  /** Override the zone list (tests). */
  zones?: string[];
  /** Fixed "now" for offset labels (tests). */
  now?: Date;
}

export function TimezoneSelect({
  value, onChange, id, disabled, className, title = 'Time zone', detectedZone, zones, now, ...rest
}: TimezoneSelectProps): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [active, setActive] = React.useState(0);
  const listId = React.useId();
  const compact = useIsCompact();
  const date = React.useMemo(() => now ?? new Date(), [now, open]);
  const detected = detectedZone === undefined ? detectTimeZone() : detectedZone;

  const rows = React.useMemo<ZoneRow[]>(() => {
    const ids = new Set(zones ?? listTimeZones());
    if (value) ids.add(value);
    return [...ids].map((tz) => ({ tz, label: formatTimeZoneLabel(tz, date), region: regionOf(tz) }));
  }, [zones, value, date]);

  const q = query.trim().toLowerCase();
  const detectedRow = React.useMemo<ZoneRow | null>(() => {
    if (!detected) return null;
    const row = { tz: detected, label: formatTimeZoneLabel(detected, date), region: regionOf(detected) };
    return matches(row, q) ? row : null;
  }, [detected, date, q]);

  const groups = React.useMemo(() => {
    const byRegion = new Map<string, ZoneRow[]>();
    for (const r of rows) {
      if (!matches(r, q)) continue;
      if (detectedRow && r.tz === detectedRow.tz) continue; // pinned above
      const list = byRegion.get(r.region) ?? [];
      list.push(r);
      byRegion.set(r.region, list);
    }
    return [...byRegion.entries()]
      .sort(([a], [b]) => (a === 'Other' ? 1 : b === 'Other' ? -1 : a.localeCompare(b)))
      .map(([region, list]) => ({ region, rows: list.sort((a, b) => a.label.localeCompare(b.label)) }));
  }, [rows, q, detectedRow]);

  // One flat, ordered list drives arrow-key navigation (aria-activedescendant).
  const flat = React.useMemo<ZoneRow[]>(
    () => [...(detectedRow ? [detectedRow] : []), ...groups.flatMap((g) => g.rows)],
    [detectedRow, groups],
  );

  React.useEffect(() => { setActive(0); }, [q]);

  const optionId = (tz: string) => `${listId}-${tz.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const activeRow = flat[Math.min(active, flat.length - 1)];

  React.useEffect(() => {
    if (!open || !activeRow) return;
    document.getElementById(optionId(activeRow.tz))?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeRow]);

  const choose = (tz: string) => {
    onChange(tz);
    setOpen(false);
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery('');
  };

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, flat.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeRow) choose(activeRow.tz);
    }
  };

  const renderOption = (row: ZoneRow, opts: { detected?: boolean }) => {
    const selected = row.tz === value;
    const isActive = activeRow?.tz === row.tz; // the pinned row and its list twin never coexist
    return (
      <div
        key={`${opts.detected ? 'detected:' : ''}${row.tz}`}
        id={optionId(row.tz)}
        role="option"
        aria-selected={selected}
        data-active={isActive || undefined}
        onClick={() => choose(row.tz)}
        onMouseMove={() => { const i = flat.findIndex((f) => f.tz === row.tz); if (i >= 0 && i !== active) setActive(i); }}
        className={cn(
          'flex min-h-[48px] cursor-pointer items-center gap-3 rounded-[10px] px-3 text-[15px] text-[var(--text-primary)]',
          'data-[active]:bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)]',
          selected && 'font-semibold',
        )}
      >
        <span className="min-w-0 flex-1 truncate">
          {opts.detected ? <span className="text-[13px] font-normal text-[var(--text-tertiary)]">Detected: </span> : null}
          {row.label}
        </span>
        {selected ? (
          <svg aria-hidden width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--amber-text)" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
            <path d="m5 12.5 4.5 4.5L19 7.5" />
          </svg>
        ) : opts.detected ? (
          <span className="shrink-0 text-[13px] font-semibold text-[var(--amber-text)]">Use this</span>
        ) : null}
      </div>
    );
  };

  return (
    <>
      <button
        type="button"
        id={id}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={rest['aria-label']}
        onClick={() => setOpen(true)}
        className={cn(
          'inline-flex h-11 w-full items-center justify-between gap-2 rounded-[10px] border border-[var(--border-base)] bg-[var(--bg-input,var(--bg-card-deep))] px-3.5 text-left text-[16px] text-[var(--text-primary)] md:text-[15px]',
          'outline-none transition-colors duration-[var(--dur-fast,120ms)] hover:border-[var(--border-strong)] motion-reduce:transition-none',
          'focus-visible:border-[var(--amber)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring,var(--amber))]',
          'disabled:pointer-events-none disabled:opacity-50',
          className,
        )}
      >
        <span className="min-w-0 truncate">{value ? formatTimeZoneLabel(value, date) : 'Select a time zone'}</span>
        <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      <Dialog
        open={open}
        onOpenChange={handleOpenChange}
        title={title}
        width={360}
        presentation={compact ? 'sheet' : 'dialog'}
      >
        <input
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={activeRow ? optionId(activeRow.tz) : undefined}
          aria-label="Search time zones"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Search city or region"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKeyDown}
          className="mb-3 h-11 w-full rounded-[10px] border border-[var(--border-base)] bg-[var(--bg-input,var(--bg-card-deep))] px-3.5 text-[16px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] focus:border-[var(--amber)] focus:ring-2 focus:ring-[var(--focus-ring,var(--amber))] md:text-[15px]"
        />
        <div
          id={listId}
          role="listbox"
          aria-label={title}
          className="max-h-[min(56dvh,420px)] overflow-y-auto overscroll-contain"
        >
          {detectedRow ? renderOption(detectedRow, { detected: true }) : null}
          {groups.map((g) => (
            <div key={g.region} role="group" aria-label={g.region}>
              <div aria-hidden className="px-3 pb-1 pt-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-[var(--text-tertiary)]">
                {g.region}
              </div>
              {g.rows.map((r) => renderOption(r, {}))}
            </div>
          ))}
          {flat.length === 0 ? (
            <div role="status" className="px-3 py-8 text-center text-[14px] text-[var(--text-secondary)]">
              {`No time zone matches '${query.trim()}'`}
            </div>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}
