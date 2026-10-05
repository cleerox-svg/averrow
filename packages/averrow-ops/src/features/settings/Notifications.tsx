// /notifications — the full notification inbox (ACCOUNT_DESIGN_SPEC §5.6).
//
//   PageHeader        title + Mark all read + settings gear
//   Tabs              Inbox / Snoozed / Done / All (state machine tabs)
//   Filters           desktop: compact FilterBar row; mobile: "Filters" button
//                     opening a bottom Sheet (search, type, severity)
//   List              grouped by day (sticky headings), shared row component
//
// Cursor pagination, filter semantics and every data hook are unchanged:
// filter changes reset the cursor, rows from the previous filters stay on
// screen (keepPreviousData) while the next page loads.

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Bell, ChevronDown, ChevronRight, Settings, SlidersHorizontal } from 'lucide-react';
import { NOTIFICATION_EVENTS, type NotificationEventKey, type NotificationSeverity } from '@averrow/shared';
import {
  Button, Card, FilterBar, Input, PageHeader, PageState, Select, Sheet, SheetClose, SheetContent, Tabs,
  type Tab,
} from '@averrow/shared/ui';
import {
  useNotificationsArchive, useMarkRead, useMarkAllRead, OPS_AUDIENCE_FILTER,
  useSnoozeNotification, useMarkDone,
  type Notification, type NotificationStateFilter,
} from '@/hooks/useNotifications';
import { useIsMobile } from '@/hooks/useWindowWidth';
import { snoozeUntilIso } from '@/lib/snooze';
import { DayHeading, NotificationRow, NotificationRowSkeletons, typeLabel } from '@/components/notifications/NotificationRow';
import { groupByDay } from '@/components/notifications/groupByDay';

type TypeFilter = 'all' | NotificationEventKey;
type SeverityFilter = 'all' | NotificationSeverity;

const SEARCH_DEBOUNCE_MS = 350;

const SEVERITY_OPTIONS: readonly { value: SeverityFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
  { value: 'info', label: 'Info' },
];

// Maps 1:1 to the backend ?state=... filter on the list endpoint.
const STATE_LABEL: Record<NotificationStateFilter, string> = {
  inbox: 'Inbox',
  snoozed: 'Snoozed',
  done: 'Done',
  all: 'All',
};
const STATE_ORDER: readonly NotificationStateFilter[] = ['inbox', 'snoozed', 'done', 'all'];

const EMPTY_COPY: Record<NotificationStateFilter, { title: string; description: string }> = {
  inbox: { title: "You're all caught up", description: 'New notifications will show up here.' },
  snoozed: { title: 'Nothing snoozed', description: 'Snoozed notifications come back when their time is up.' },
  done: { title: 'Nothing marked done yet', description: 'Notifications you mark done move here.' },
  all: { title: 'No notifications yet', description: 'New notifications will show up here.' },
};

export function Notifications() {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [stateFilter, setStateFilter] = useState<NotificationStateFilter>('inbox');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all');
  const [searchInput, setSearchInput] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);

  const currentCursor = cursorStack[cursorStack.length - 1];

  const filters = {
    state: stateFilter,
    ...(typeFilter !== 'all' ? { type: typeFilter } : {}),
    ...(severityFilter !== 'all' ? { severity: severityFilter } : {}),
    ...(appliedSearch ? { q: appliedSearch } : {}),
    ...(currentCursor ? { cursor: currentCursor } : {}),
    // N1: scope to the same audience set as the bell so bell -> inbox never
    // reveals tenant brand events the operator opted not to see.
    audience: OPS_AUDIENCE_FILTER,
  };

  const { data, isLoading, isFetching, isError, isPlaceholderData, refetch } = useNotificationsArchive(filters);
  // A failed fetch is an error, never "all caught up". keepPreviousData rows
  // belong to the previous filters, so they don't count as data on failure.
  const failed = isError && (!data || isPlaceholderData);
  const markRead = useMarkRead();
  const markAllRead = useMarkAllRead();
  const snooze = useSnoozeNotification();
  const markDone = useMarkDone();

  // Debounced search: applying on every keystroke would fire a request per key.
  useEffect(() => {
    const next = searchInput.trim();
    if (next === appliedSearch) return;
    const t = window.setTimeout(() => {
      setAppliedSearch(next);
      setCursorStack([null]);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [searchInput, appliedSearch]);

  const resetCursor = () => setCursorStack([null]);
  const onChangeState = (next: NotificationStateFilter) => { setStateFilter(next); resetCursor(); };
  const onChangeType = (next: TypeFilter) => { setTypeFilter(next); resetCursor(); };
  const onChangeSeverity = (next: SeverityFilter) => { setSeverityFilter(next); resetCursor(); };
  const clearFilters = () => {
    setTypeFilter('all');
    setSeverityFilter('all');
    setSearchInput('');
    setAppliedSearch('');
    resetCursor();
  };

  const goNextPage = () => {
    if (data?.next_cursor) setCursorStack([...cursorStack, data.next_cursor]);
  };
  const goPrevPage = () => {
    if (cursorStack.length > 1) setCursorStack(cursorStack.slice(0, -1));
  };

  const notifications = data?.notifications ?? [];
  const unreadCount = data?.unread_count ?? 0;
  const isFirstPage = cursorStack.length === 1;
  const hasNextPage = data?.next_cursor != null;
  const activeFilterCount =
    (typeFilter !== 'all' ? 1 : 0) + (severityFilter !== 'all' ? 1 : 0) + (searchInput.trim() ? 1 : 0);
  const filtered = activeFilterCount > 0;

  const actionOpts = { onSuccess: () => setActionFailed(false), onError: () => setActionFailed(true) };
  const handleActivate = (n: Notification) => {
    if (n.state === 'unread') markRead.mutate(n.id, actionOpts);
    if (n.link) navigate(n.link);
  };
  const handleSnooze = (id: string, hours: number) =>
    snooze.mutate({ id, until: snoozeUntilIso(hours) }, actionOpts);
  const handleDone = (id: string) => markDone.mutate(id, actionOpts);

  const tabs: Tab[] = STATE_ORDER.map((id) => ({
    id,
    label: STATE_LABEL[id],
    // Only the inbox has a known count (unread); other states have no count endpoint.
    ...(id === 'inbox' && unreadCount > 0 ? { count: unreadCount } : {}),
  }));

  const typeOptions = useMemo(
    () => NOTIFICATION_EVENTS.map((e) => ({ value: e.key, label: e.label })),
    [],
  );

  const typeSelect = (id: string) => (
    <Select
      id={id}
      aria-label="Type"
      value={typeFilter}
      onChange={(e) => onChangeType(e.target.value as TypeFilter)}
    >
      <option value="all">All types</option>
      {typeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </Select>
  );

  const emptyCopy = EMPTY_COPY[stateFilter];

  return (
    <div className="page-enter mx-auto max-w-3xl pb-8">
      <PageHeader
        title="Notifications"
        back={{ label: 'Back', onClick: () => navigate(-1) }}
        actions={
          <>
            <Button
              variant="secondary"
              size="md"
              className="[@media(pointer:coarse)]:min-h-[44px]"
              disabled={unreadCount === 0 || markAllRead.isPending}
              onClick={() => markAllRead.mutate(undefined, actionOpts)}
            >
              Mark all read
            </Button>
            <Link
              to="/settings/notifications"
              aria-label="Notification settings"
              title="Notification settings"
              className="inline-flex h-11 w-11 items-center justify-center rounded-[10px] border border-[var(--border-base)] text-[var(--text-secondary)] no-underline transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
            >
              <Settings aria-hidden="true" className="h-[18px] w-[18px]" />
            </Link>
          </>
        }
      />

      <Tabs
        tabs={tabs}
        activeTab={stateFilter}
        onChange={(id) => onChangeState(id as NotificationStateFilter)}
        variant="underline"
        size="md"
        aria-label="Notification state"
        className="mb-4"
      />

      {/* Filters */}
      {isMobile ? (
        <div className="mb-4 flex items-center gap-2">
          <Button
            variant="secondary"
            size="md"
            className="min-h-[44px] gap-2"
            onClick={() => setFiltersOpen(true)}
            aria-haspopup="dialog"
          >
            <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
            Filters
            {activeFilterCount > 0 && (
              <span className="rounded-full bg-[var(--amber)] px-1.5 font-mono text-[12px] font-bold text-[var(--text-on-amber)]">
                {activeFilterCount}
              </span>
            )}
          </Button>
          {filtered && (
            <Button variant="ghost" size="md" className="min-h-[44px]" onClick={clearFilters}>Clear</Button>
          )}
        </div>
      ) : (
        <FilterBar<SeverityFilter>
          filters={SEVERITY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          active={severityFilter}
          onChange={onChangeSeverity}
          filterLabel="Severity"
          search={{
            value: searchInput,
            onChange: setSearchInput,
            placeholder: 'Search notifications',
            label: 'Search notifications',
          }}
          actions={
            filtered ? <Button variant="ghost" size="sm" onClick={clearFilters}>Clear filters</Button> : undefined
          }
          className="mb-4"
        >
          <div className="mt-2 max-w-[260px]">{typeSelect('notif-type-desktop')}</div>
        </FilterBar>
      )}

      <Sheet open={isMobile && filtersOpen} onOpenChange={setFiltersOpen}>
        <SheetContent
          title="Filters"
          footer={
            <>
              <SheetClose asChild><Button variant="primary" size="lg">Show results</Button></SheetClose>
              <Button variant="secondary" size="lg" onClick={clearFilters} disabled={!filtered}>Clear filters</Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-[14px] font-semibold text-[var(--text-primary)]">
              Search
              <Input
                type="search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Title or message"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-[14px] font-semibold text-[var(--text-primary)]">
              Type
              <Select value={typeFilter} onChange={(e) => onChangeType(e.target.value as TypeFilter)}>
                <option value="all">All types</option>
                {typeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            </label>
            <label className="flex flex-col gap-1.5 text-[14px] font-semibold text-[var(--text-primary)]">
              Severity
              <Select value={severityFilter} onChange={(e) => onChangeSeverity(e.target.value as SeverityFilter)}>
                {SEVERITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            </label>
          </div>
        </SheetContent>
      </Sheet>

      {/* Results */}
      {actionFailed && (
        <PageState
          kind="error"
          layout="inline"
          compact
          title="Couldn't update that notification"
          description="Check your connection and try again."
          className="mb-3"
        />
      )}
      {isError && !failed && (
        <PageState
          kind="error"
          layout="inline"
          compact
          title="Couldn't refresh notifications"
          description="Showing the last loaded list."
          onRetry={() => { void refetch(); }}
          className="mb-3"
        />
      )}

      {failed ? (
        <PageState
          kind="error"
          layout="card"
          title="Couldn't load notifications"
          description="Check your connection and try again."
          onRetry={() => { void refetch(); }}
        />
      ) : isLoading ? (
        <Card padding="none"><NotificationRowSkeletons /></Card>
      ) : notifications.length === 0 ? (
        filtered ? (
          <PageState
            kind="empty"
            layout="card"
            compact
            icon={<Bell />}
            title="No notifications match these filters"
            description="Try different filters or clear them."
            action={{ label: 'Clear filters', onClick: clearFilters, variant: 'secondary' }}
          />
        ) : (
          <PageState
            kind={stateFilter === 'inbox' ? 'clear' : 'empty'}
            layout="card"
            compact
            icon={<Bell />}
            title={emptyCopy.title}
            description={emptyCopy.description}
            action={
              <Link
                to="/settings/notifications"
                className="inline-flex min-h-[44px] items-center rounded-[10px] border border-[var(--border-base)] px-4 text-[14px] font-semibold text-[var(--text-primary)] no-underline hover:border-[var(--border-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
              >
                Notification settings
              </Link>
            }
          />
        )
      ) : (
        <div
          className="overflow-clip rounded-[var(--card-radius)] border border-[var(--border-base)] bg-[var(--bg-card)]"
          aria-busy={isFetching && isPlaceholderData}
        >
          {groupByDay(notifications).map((day) => (
            <section key={day.key} aria-labelledby={`notif-day-${day.key}`}>
              <DayHeading id={`notif-day-${day.key}`} label={day.label} />
              <GroupedRows
                notifications={day.items}
                onActivate={handleActivate}
                onSnooze={handleSnooze}
                onDone={handleDone}
              />
            </section>
          ))}

          <div className="flex items-center justify-between gap-2 border-t border-[var(--border-base)] px-2 py-2">
            <Button
              variant="ghost"
              size="md"
              className="[@media(pointer:coarse)]:min-h-[44px]"
              onClick={goPrevPage}
              disabled={isFirstPage || isFetching}
            >
              ← Newer
            </Button>
            <span className="font-mono text-[12px] text-[var(--text-tertiary)]" aria-live="polite">
              {isFetching ? 'Loading…' : `Page ${cursorStack.length}`}
            </span>
            <Button
              variant="ghost"
              size="md"
              className="[@media(pointer:coarse)]:min-h-[44px]"
              onClick={goNextPage}
              disabled={!hasNextPage || isFetching}
            >
              Older →
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Group-by-entity collapse ──────────────────────────────────────
//
// 3 notifications about Acme within a day shouldn't render as 3 rows.
// `group_key` (e.g. `brand_threat:acme`) drives the collapse inside each day
// section: a group with >=2 members shows its newest row plus a toggle. Solo
// rows render exactly like before. Per-row actions stay per notification.

function GroupedRows({
  notifications, onActivate, onSnooze, onDone,
}: {
  notifications: Notification[];
  onActivate: (n: Notification) => void;
  onSnooze: (id: string, hours: number) => void;
  onDone: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const map = new Map<string, Notification[]>();
    for (const n of notifications) {
      const k = n.group_key ?? `__solo__:${n.id}`;
      const list = map.get(k);
      if (list) list.push(n); else map.set(k, [n]);
    }
    return Array.from(map.entries()).map(([key, members]) => ({ key, members }));
  }, [notifications]);

  const row = (n: Notification) => (
    <NotificationRow
      key={n.id}
      notification={n}
      actions="inline"
      showType
      showDetail
      onActivate={() => onActivate(n)}
      onSnooze={(h) => onSnooze(n.id, h)}
      onDone={() => onDone(n.id)}
    />
  );

  return (
    <ul className="m-0 list-none p-0">
      {groups.map(({ key, members }) => {
        const head = members[0]!;
        if (members.length < 2) return row(head);
        const isOpen = expanded.has(key);
        const toggle = () => {
          const next = new Set(expanded);
          if (next.has(key)) next.delete(key); else next.add(key);
          setExpanded(next);
        };
        return (
          <li key={key} className="list-none">
            <ul className="m-0 list-none p-0">
              {isOpen ? members.map(row) : row(head)}
              <li className="border-b border-[var(--border-base)]">
                <button
                  type="button"
                  onClick={toggle}
                  aria-expanded={isOpen}
                  className="flex min-h-[44px] w-full cursor-pointer items-center gap-1.5 border-0 bg-transparent px-4 text-left text-[13px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--focus-ring)]"
                >
                  {isOpen ? <ChevronDown aria-hidden="true" className="h-4 w-4" /> : <ChevronRight aria-hidden="true" className="h-4 w-4" />}
                  {isOpen
                    ? `Hide ${members.length - 1} similar`
                    : `Show ${members.length - 1} more similar · ${typeLabel(head.type)}`}
                </button>
              </li>
            </ul>
          </li>
        );
      })}
    </ul>
  );
}
