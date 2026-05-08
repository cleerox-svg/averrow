// /v2/notifications — full notification archive.
//
// Composition (matches the Profile page section style):
//   PageHeader (back button + "All Notifications" title)
//   Filters card  — type pills + severity pills + search input
//   Results card  — paginated list, mark-as-read inline, pagination row
//
// Cursor-based pagination so the list stays stable as new
// notifications arrive between page loads. Filter changes reset the
// cursor (you start from the newest matching row).

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Search, X, Clock, Check, Bell, ChevronDown, ChevronRight } from 'lucide-react';
import {
  USER_TOGGLEABLE_EVENTS,
  NOTIFICATION_EVENTS,
  type NotificationEventKey,
  type NotificationSeverity,
} from '@averrow/shared';
import { Card, Badge, SectionLabel, Button } from '@/design-system/components';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  useNotificationsArchive, useMarkRead, useMarkAllRead,
  useSnoozeNotification, useMarkDone,
  type Notification, type NotificationStateFilter,
} from '@/hooks/useNotifications';
import { relativeTime } from '@/lib/time';

type TypeFilter = 'all' | NotificationEventKey;
type SeverityFilter = 'all' | NotificationSeverity;

const SEVERITY_OPTIONS: readonly { key: SeverityFilter; label: string }[] = [
  { key: 'all',      label: 'All' },
  { key: 'critical', label: 'Critical' },
  { key: 'high',     label: 'High' },
  { key: 'medium',   label: 'Medium' },
  { key: 'low',      label: 'Low' },
  { key: 'info',     label: 'Info' },
];

// N4: state-machine tabs (Linear-style triage). Maps 1:1 to the
// backend ?state=... filter on the LIST endpoint.
const STATE_TABS: readonly { key: NotificationStateFilter; label: string }[] = [
  { key: 'inbox',   label: 'Inbox' },
  { key: 'snoozed', label: 'Snoozed' },
  { key: 'done',    label: 'Done' },
  { key: 'all',     label: 'All' },
];

function severityToBadge(s: string): NotificationSeverity {
  if (s === 'critical' || s === 'high' || s === 'medium' || s === 'low' || s === 'info') return s;
  return 'info';
}

// Resolve a notification type to its registry label so the UI shows
// "Brand Threats" instead of the raw `brand_threat` key.
function typeLabel(type: string): string {
  const def = NOTIFICATION_EVENTS.find((e) => e.key === type);
  return def?.label ?? type.replace(/_/g, ' ');
}

export function Notifications() {
  const navigate = useNavigate();
  const [stateFilter, setStateFilter] = useState<NotificationStateFilter>('inbox');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all');
  const [searchInput, setSearchInput] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);

  const currentCursor = cursorStack[cursorStack.length - 1];

  // Filter pills built from the registry (all 7 events — toggleable
  // + system — surface here, unlike the bell which only shows
  // user-toggleable). System events arrive in the feed; users should
  // be able to filter them.
  const typeOptions = useMemo(
    () => [
      { key: 'all' as const, label: 'All' },
      ...NOTIFICATION_EVENTS.map((e) => ({ key: e.key, label: e.label })),
    ],
    [],
  );

  const filters = {
    state: stateFilter,
    ...(typeFilter !== 'all' ? { type: typeFilter } : {}),
    ...(severityFilter !== 'all' ? { severity: severityFilter } : {}),
    ...(appliedSearch ? { q: appliedSearch } : {}),
    ...(currentCursor ? { cursor: currentCursor } : {}),
  };

  const { data, isLoading, isFetching } = useNotificationsArchive(filters);
  const markRead = useMarkRead();
  const markAllRead = useMarkAllRead();
  const snooze = useSnoozeNotification();
  const markDone = useMarkDone();

  // Filter changes reset pagination. Only re-runs when filter values
  // actually change — `appliedSearch` (debounced submit) instead of
  // raw `searchInput` (on every keystroke).
  const onChangeStateFilter = (next: NotificationStateFilter) => {
    setStateFilter(next);
    setCursorStack([null]);
  };
  const onChangeTypeFilter = (next: TypeFilter) => {
    setTypeFilter(next);
    setCursorStack([null]);
  };
  const onChangeSeverityFilter = (next: SeverityFilter) => {
    setSeverityFilter(next);
    setCursorStack([null]);
  };
  const submitSearch = () => {
    setAppliedSearch(searchInput.trim());
    setCursorStack([null]);
  };
  const clearSearch = () => {
    setSearchInput('');
    setAppliedSearch('');
    setCursorStack([null]);
  };

  const goNextPage = () => {
    if (data?.next_cursor) {
      setCursorStack([...cursorStack, data.next_cursor]);
    }
  };
  const goPrevPage = () => {
    if (cursorStack.length > 1) {
      setCursorStack(cursorStack.slice(0, -1));
    }
  };

  const notifications = data?.notifications ?? [];
  const isFirstPage = cursorStack.length === 1;
  const hasNextPage = data?.next_cursor != null;

  return (
    <div className="max-w-3xl mx-auto page-enter">
      <div className="flex items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate(-1)}
            className="p-2 rounded-lg touch-target"
            style={{
              background: 'transparent',
              border: '1px solid var(--border-base)',
              color: 'var(--text-secondary)',
              transition: 'var(--transition-fast)',
            }}
            aria-label="Back"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <h1 className="font-mono text-[10px] uppercase tracking-[0.15em] font-bold" style={{ color: 'var(--text-muted)' }}>
            Notifications
          </h1>
        </div>
        {(data?.unread_count ?? 0) > 0 && stateFilter === 'inbox' && (
          <Button variant="ghost" size="sm" onClick={() => markAllRead.mutate()}>
            Mark all read ({data?.unread_count})
          </Button>
        )}
      </div>

      {/* State tabs — Inbox / Snoozed / Done / All */}
      <div className="flex items-center gap-1 mb-4 border-b border-white/[0.06]">
        {STATE_TABS.map(({ key, label }) => {
          const active = stateFilter === key;
          return (
            <button
              key={key}
              onClick={() => onChangeStateFilter(key)}
              className="px-3 py-2 font-mono text-[11px] uppercase tracking-wider transition-all touch-target"
              style={{
                color: active ? 'var(--amber)' : 'var(--text-secondary)',
                borderBottom: active
                  ? '2px solid var(--amber)'
                  : '2px solid transparent',
                fontWeight: active ? 700 : 400,
                marginBottom: -1,
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Filters */}
      <Card className="mb-4">
        <SectionLabel className="mb-3">Filters</SectionLabel>

        <div className="space-y-3">
          {/* Type pills */}
          <div>
            <div className="font-mono text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-tertiary)' }}>
              Type
            </div>
            <div className="flex flex-wrap gap-1.5">
              {typeOptions.map(({ key, label }) => (
                <FilterPill
                  key={key}
                  active={typeFilter === key}
                  onClick={() => onChangeTypeFilter(key)}
                >
                  {label}
                </FilterPill>
              ))}
            </div>
          </div>

          {/* Severity pills */}
          <div>
            <div className="font-mono text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-tertiary)' }}>
              Severity
            </div>
            <div className="flex flex-wrap gap-1.5">
              {SEVERITY_OPTIONS.map(({ key, label }) => (
                <FilterPill
                  key={key}
                  active={severityFilter === key}
                  onClick={() => onChangeSeverityFilter(key)}
                >
                  {label}
                </FilterPill>
              ))}
            </div>
          </div>

          {/* Search */}
          <div>
            <div className="font-mono text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-tertiary)' }}>
              Search
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative flex-1">
                <Search
                  className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                  style={{ color: 'var(--text-tertiary)' }}
                />
                <Input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitSearch();
                    if (e.key === 'Escape') clearSearch();
                  }}
                  placeholder="Search title or message…"
                  style={{ paddingLeft: 36 }}
                />
                {appliedSearch && (
                  <button
                    onClick={clearSearch}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded touch-target"
                    style={{ color: 'var(--text-tertiary)' }}
                    aria-label="Clear search"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <Button variant="secondary" size="sm" onClick={submitSearch}>
                Search
              </Button>
            </div>
          </div>
        </div>
      </Card>

      {/* Results */}
      {isLoading ? (
        <Card>
          <p className="font-mono text-[12px] py-8 text-center" style={{ color: 'var(--text-tertiary)' }}>
            Loading…
          </p>
        </Card>
      ) : notifications.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Bell className="w-10 h-10" />}
            title={
              appliedSearch || typeFilter !== 'all' || severityFilter !== 'all'
                ? 'No notifications match these filters'
                : stateFilter === 'inbox'
                  ? 'Inbox zero'
                  : stateFilter === 'snoozed'
                    ? 'Nothing snoozed'
                    : stateFilter === 'done'
                      ? 'Nothing done yet'
                      : 'No notifications yet'
            }
            subtitle={
              appliedSearch || typeFilter !== 'all' || severityFilter !== 'all'
                ? 'Try a different filter or clear the search.'
                : stateFilter === 'inbox'
                  ? 'You\'re all caught up.'
                  : 'Items move here as you triage them.'
            }
          />
        </Card>
      ) : (
        <Card>
          <NotificationGroupedList
            notifications={notifications}
            onActivate={(n) => {
              if (n.state === 'unread') markRead.mutate(n.id);
              if (n.link) navigate(n.link);
            }}
            onSnooze={(id) => {
              const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
              snooze.mutate({ id, until });
            }}
            onDone={(id) => markDone.mutate(id)}
          />

          {/* Pagination */}
          <div className="mt-4 pt-4 border-t border-white/[0.06] flex items-center justify-between">
            <Button
              variant="ghost"
              size="sm"
              onClick={goPrevPage}
              disabled={isFirstPage || isFetching}
            >
              ← Newer
            </Button>
            <span className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
              {isFetching ? 'Loading…' : `Page ${cursorStack.length}`}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={goNextPage}
              disabled={!hasNextPage || isFetching}
            >
              Older →
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

// ─── B3: Group-by-entity collapse ──────────────────────────────────
//
// 3 notifications about Acme within an hour shouldn't render as 3 rows.
// `group_key` (set by createNotification — e.g. `brand_threat:acme`)
// drives the collapse: if a group has ≥2 members, render a head row
// with a count badge and an expand toggle. Solo rows (no group_key, or
// group_key with one member) render exactly like before.
//
// Per-row actions still operate on individual rows when expanded;
// bulk actions on the whole group are §14 backlog.

function NotificationGroupedList({
  notifications, onActivate, onSnooze, onDone,
}: {
  notifications: Notification[];
  onActivate: (n: Notification) => void;
  onSnooze: (id: string) => void;
  onDone: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Build groups in order — preserve the original list ordering by
  // anchoring each group at its FIRST occurrence. A group with 1
  // member is rendered as a plain row.
  const groups = useMemo(() => {
    const map = new Map<string, { key: string | null; members: Notification[] }>();
    const order: string[] = [];
    for (const n of notifications) {
      const k = n.group_key ?? `__solo__:${n.id}`;
      const existing = map.get(k);
      if (existing) {
        existing.members.push(n);
      } else {
        map.set(k, { key: n.group_key, members: [n] });
        order.push(k);
      }
    }
    return order.map((k) => ({ ...map.get(k)!, mapKey: k }));
  }, [notifications]);

  return (
    <div className="space-y-1 -mx-2">
      {groups.map((g) => {
        const isCollapsedGroup = g.members.length >= 2;
        const isOpen = expanded.has(g.mapKey);
        const head = g.members[0]!;

        if (!isCollapsedGroup) {
          return (
            <NotificationRow
              key={head.id}
              notification={head}
              onActivate={() => onActivate(head)}
              onSnooze={() => onSnooze(head.id)}
              onDone={() => onDone(head.id)}
            />
          );
        }

        return (
          <div key={g.mapKey}>
            <div className="flex items-center gap-2 px-3 -mb-1 mt-2">
              <button
                onClick={() => {
                  const next = new Set(expanded);
                  if (next.has(g.mapKey)) next.delete(g.mapKey); else next.add(g.mapKey);
                  setExpanded(next);
                }}
                className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider touch-target"
                style={{ color: 'var(--text-tertiary)' }}
                aria-expanded={isOpen}
                aria-controls={`group-${g.mapKey}`}
              >
                {isOpen
                  ? <ChevronDown className="w-3 h-3" />
                  : <ChevronRight className="w-3 h-3" />}
                {g.key ?? 'Group'} · {g.members.length}
              </button>
            </div>
            {isOpen ? (
              g.members.map((n) => (
                <NotificationRow
                  key={n.id}
                  notification={n}
                  onActivate={() => onActivate(n)}
                  onSnooze={() => onSnooze(n.id)}
                  onDone={() => onDone(n.id)}
                />
              ))
            ) : (
              <NotificationRow
                key={head.id}
                notification={head}
                onActivate={() => onActivate(head)}
                onSnooze={() => onSnooze(head.id)}
                onDone={() => onDone(head.id)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="px-2.5 py-1 rounded-md text-[10px] font-mono uppercase tracking-wider transition-all touch-target"
      style={{
        background: active
          ? 'linear-gradient(135deg, var(--amber), var(--amber-dim))'
          : 'transparent',
        border: active
          ? '1px solid rgba(229, 168, 50, 0.60)'
          : '1px solid var(--border-base)',
        color: active ? 'var(--text-on-amber, #0A0F1E)' : 'var(--text-secondary)',
        fontWeight: 800,
      }}
    >
      {children}
    </button>
  );
}

function NotificationRow({
  notification,
  onActivate,
  onSnooze,
  onDone,
}: {
  notification: Notification;
  onActivate: () => void;
  onSnooze: () => void;
  onDone: () => void;
}) {
  const isUnread = notification.state === 'unread';
  const isSnoozed = notification.state === 'snoozed';
  const isDone = notification.state === 'done';
  const hasLink = !!notification.link;
  const sev = severityToBadge(notification.severity);

  return (
    <div
      className="group relative w-full px-3 py-3 rounded transition-colors hover:bg-white/[0.03]"
      style={{
        borderLeft: isUnread
          ? `2px solid var(--sev-${sev}-border, var(--sev-info-border))`
          : '2px solid transparent',
        background: isUnread ? 'rgba(255,255,255,0.02)' : 'transparent',
        opacity: isDone ? 0.55 : isSnoozed ? 0.75 : 1,
      }}
    >
      <div className="flex items-start gap-3">
        <Badge severity={sev} size="xs" />

        {/* Title + message + reason + recommended_action + meta */}
        <button
          onClick={onActivate}
          className="flex-1 min-w-0 text-left touch-target"
          style={{ cursor: hasLink ? 'pointer' : 'default' }}
          aria-label={hasLink ? `Open "${notification.title}"` : notification.title}
        >
          <p className="text-[13px] leading-snug" style={{ color: 'var(--text-primary)' }}>
            {notification.title}
          </p>
          <p className="text-[11px] mt-1 line-clamp-2" style={{ color: 'var(--text-tertiary)' }}>
            {notification.message}
          </p>

          {/* Static template fields (Q5) — render only when populated */}
          {notification.reason_text && (
            <p className="text-[10px] mt-1.5 italic" style={{ color: 'var(--text-tertiary)' }}>
              {notification.reason_text}
            </p>
          )}
          {notification.recommended_action && (
            <p className="text-[11px] mt-1.5 font-mono" style={{ color: 'var(--amber)' }}>
              {'→ '}{notification.recommended_action}
            </p>
          )}

          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <span className="text-[10px] font-mono uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
              {typeLabel(notification.type)}
            </span>
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>·</span>
            <span className="text-[10px] font-mono" style={{ color: 'var(--text-tertiary)' }}>
              {relativeTime(notification.created_at)}
            </span>
            {isSnoozed && notification.snoozed_until && (
              <>
                <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>·</span>
                <span className="text-[10px] font-mono inline-flex items-center gap-1" style={{ color: 'var(--sev-medium)' }}>
                  <Clock className="w-3 h-3" />
                  until {relativeTime(notification.snoozed_until)}
                </span>
              </>
            )}
            {isDone && (
              <>
                <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>·</span>
                <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>done</span>
              </>
            )}
          </div>
        </button>

        {/* Action buttons (§7.7) — Snooze 1h + Done. Hidden when
            already done. Visible always on touch; on hover for
            mouse users. */}
        {!isDone && (
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            {!isSnoozed && (
              <button
                onClick={onSnooze}
                className="p-1.5 rounded touch-target hover:bg-white/[0.05]"
                style={{ color: 'var(--text-tertiary)' }}
                aria-label="Snooze 1 hour"
                title="Snooze 1h"
              >
                <Clock className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              onClick={onDone}
              className="p-1.5 rounded touch-target hover:bg-white/[0.05]"
              style={{ color: 'var(--text-tertiary)' }}
              aria-label="Mark done"
              title="Done"
            >
              <Check className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
