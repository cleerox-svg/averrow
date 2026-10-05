// Users & Access — the staff-side account admin page (route /admin/users).
//
// Replaces the customer-style "Organization" page. Staff are global with no
// tenant org (CLAUDE.md §7), so org plan / brands / SSO / SCIM / webhooks /
// integrations / org API keys don't belong here; those are tenant-app
// surfaces. What staff actually administer:
//
//   Staff   — staff accounts: role + status.   GET/PATCH /api/admin/users
//             (requireAdmin: admin, super_admin)
//   Invites — pending staff invites.           /api/admin/invites
//             (manage_invites: admin, super_admin, sales; org_id IS NULL)
//
// API keys are intentionally absent: the only key surface is the org-scoped
// /api/orgs/:orgId/api-keys, and a staff user has no org.
//
// Server rules mirrored client-side (the worker stays the source of truth):
//   - only super_admin may grant/change admin or super_admin accounts
//   - nobody changes their own role/status here
//   - invites: non-super_admins may only invite `analyst`

import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { roleLabel } from '@averrow/shared';
import {
  Badge, Button, Card, ConfirmDialog, DataTable, Field, InlineBanner, Input, PageHeader,
  PageState, Select, roleBadgeProps, SettingsGroup, SettingsRow, Tabs, ToastProvider, useMediaQuery, useToast,
  type Column, type Tab,
} from '@averrow/shared/ui';
import { useAuth } from '@/lib/auth';
import { roleHasPermission } from '@/lib/permissions';
import { parseInitials, colorForUserId, SELF_AVATAR_COLOR } from '@/lib/avatar';
import { parseUtc, relativeTime } from '@/lib/time';
import {
  useStaffUsers, useUpdatePlatformUser, useForceLogout,
  useStaffInvites, useCreateStaffInvite, useRevokeStaffInvite,
  type PlatformUser, type PlatformUserRole, type PlatformUserStatus, type StaffInvite,
} from '@/hooks/usePlatformUsers';

// ─── Roles, tabs, permissions ───────────────────────────────

type StaffRoleValue = 'super_admin' | 'admin' | 'analyst';
const ROLE_RANK: Record<string, number> = { analyst: 1, admin: 2, super_admin: 3 };
const ALL_STAFF_ROLES: StaffRoleValue[] = ['analyst', 'admin', 'super_admin'];
const STATUS_OPTIONS: Array<{ value: PlatformUserStatus; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'deactivated', label: 'Deactivated' },
];

type TabId = 'staff' | 'invites';

/** ?tab= values accepted for deep links, including the old Organization ids. */
const TAB_ALIASES: Record<string, TabId> = { staff: 'staff', members: 'staff', invites: 'invites' };

const isPrivilegedRole = (r: string) => r === 'admin' || r === 'super_admin';

/** Roles the caller may grant (server: only super_admin grants admin/super_admin). */
function grantableRoles(callerIsSuperAdmin: boolean): StaffRoleValue[] {
  return callerIsSuperAdmin ? ALL_STAFF_ROLES : ['analyst'];
}

function expiresIn(iso: string): string {
  const ms = parseUtc(iso).getTime() - Date.now();
  if (ms <= 0) return 'Expired';
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return 'Expires in under an hour';
  if (hours < 48) return `Expires in ${hours}h`;
  return `Expires in ${Math.floor(hours / 24)}d`;
}

function statusBadge(status: string) {
  const label = STATUS_OPTIONS.find((s) => s.value === status)?.label ?? status;
  const kind = status === 'active' ? 'active' : status === 'suspended' ? 'warning' : 'inactive';
  return <Badge status={kind} font="sans" size="md">{label}</Badge>;
}

// ─── Page ───────────────────────────────────────────────────

export function UsersAccess() {
  // The shared kit's toast context is separate from ops' own provider (same
  // arrangement as SettingsLayout).
  return (
    <ToastProvider>
      <UsersAccessInner />
    </ToastProvider>
  );
}

function UsersAccessInner() {
  const { user: me, isSuperAdmin } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const canManageStaff = isSuperAdmin || me?.role === 'admin';       // requireAdmin
  const canManageInvites = roleHasPermission(me?.role, 'manage_invites'); // requirePermission

  const visible: TabId[] = [
    ...(canManageStaff ? (['staff'] as const) : []),
    ...(canManageInvites ? (['invites'] as const) : []),
  ];

  if (visible.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="Users & Access" subtitle="Manage staff and invites." />
        <PageState
          kind="locked"
          title="Admin access required"
          description="Staff accounts and invites are managed by admins. Ask an admin if you need a change."
        />
      </div>
    );
  }

  const requested = TAB_ALIASES[searchParams.get('tab') ?? ''];
  const activeTab: TabId = requested && visible.includes(requested) ? requested : visible[0]!;

  const setActiveTab = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', id);
    setSearchParams(next, { replace: true });
  };

  const tabs: Tab[] = visible.map((id) => ({ id, label: id === 'staff' ? 'Staff' : 'Invites' }));

  return (
    <div className="space-y-6">
      <PageHeader title="Users & Access" subtitle="Manage staff and invites." />
      <Tabs tabs={tabs} activeTab={activeTab} onChange={setActiveTab} variant="underline" size="md" sticky aria-label="Users and access sections" />
      {activeTab === 'staff' && canManageStaff && <StaffTab />}
      {activeTab === 'invites' && canManageInvites && <InvitesTab />}
    </div>
  );
}

// ─── Staff tab ──────────────────────────────────────────────

type PendingChange =
  | { kind: 'role'; user: PlatformUser; to: PlatformUserRole }
  | { kind: 'status'; user: PlatformUser; to: PlatformUserStatus };

function StaffTab() {
  const { user: me, isSuperAdmin } = useAuth();
  const { showToast } = useToast();
  const isMobile = useMediaQuery('(max-width: 639px)');

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const timer = useRef<number | undefined>(undefined);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [revocation, setRevocation] = useState<{ userId: string; email: string; warning: string } | null>(null);

  const q = useStaffUsers({ q: debounced, role: roleFilter, status: statusFilter });
  const update = useUpdatePlatformUser();
  const forceLogout = useForceLogout();

  const onSearch = (v: string) => {
    setSearch(v);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setDebounced(v.trim()), 300);
  };

  const grantable = grantableRoles(isSuperAdmin);
  const filtered = Boolean(debounced || roleFilter || statusFilter);

  const users = [...q.users].sort(
    (a, b) => (ROLE_RANK[b.role] ?? 0) - (ROLE_RANK[a.role] ?? 0) || (a.name ?? a.email).localeCompare(b.name ?? b.email),
  );

  const nameOf = (u: PlatformUser) => u.name ?? u.email;

  function requestRole(u: PlatformUser, to: PlatformUserRole) {
    if (to !== u.role) setPending({ kind: 'role', user: u, to });
  }
  function requestStatus(u: PlatformUser, to: PlatformUserStatus) {
    if (to === u.status) return;
    if (to === 'active') {
      // Restoring access needs no confirmation.
      update.mutate({ userId: u.id, status: 'active' }, {
        onSuccess: () => showToast(`${nameOf(u)} reactivated`, 'success'),
        onError: (e) => showToast((e as Error).message, 'error'),
      });
      return;
    }
    setPending({ kind: 'status', user: u, to });
  }

  async function confirmPending() {
    if (!pending) return;
    const { user: u } = pending;
    const res = await update.mutateAsync(
      pending.kind === 'role' ? { userId: u.id, role: pending.to } : { userId: u.id, status: pending.to },
    );
    if (res.revocationPending) {
      setRevocation({
        userId: u.id,
        email: u.email,
        warning: res.warning ?? 'Role updated, but existing sessions could not be revoked.',
      });
    }
    showToast(
      pending.kind === 'role'
        ? `${nameOf(u)} is now ${roleLabel(pending.to)}`
        : `${nameOf(u)} ${pending.to === 'suspended' ? 'suspended' : 'deactivated'}`,
      'success',
    );
  }

  const controlProps = (u: PlatformUser): ControlProps => ({
    user: u,
    touchable: u.id !== me?.id && (isSuperAdmin || !isPrivilegedRole(u.role)),
    grantable,
    busy: update.isPending,
    onRole: (r) => requestRole(u, r),
    onStatus: (s) => requestStatus(u, s),
  });

  const columns: Column<PlatformUser>[] = [
    { key: 'user', header: 'User', render: (u) => <UserCell user={u} isSelf={u.id === me?.id} /> },
    { key: 'role', header: 'Role', render: (u) => <RoleControl {...controlProps(u)} />, width: 190 },
    { key: 'status', header: 'Status', render: (u) => <StatusControl {...controlProps(u)} />, width: 190 },
    {
      key: 'last', header: 'Last active',
      render: (u) => (
        <span className="font-mono text-[12px] text-[var(--text-secondary)]">
          {relativeTime(u.last_active ?? u.last_login)}
        </span>
      ),
    },
  ];

  let body: React.ReactNode;
  if (q.isError) {
    body = <PageState kind="error" layout="card" title="Couldn't load staff" description={q.error?.message} onRetry={q.refetch} />;
  } else if (q.isLoading) {
    body = <PageState kind="loading" layout="card" title="Loading staff…" />;
  } else if (users.length === 0) {
    body = (
      <PageState
        kind="empty"
        layout="card"
        title={filtered ? 'No staff match' : 'No staff yet'}
        description={filtered ? 'Adjust the search or filters.' : 'Invite your first teammate from the Invites tab.'}
      />
    );
  } else if (isMobile) {
    body = (
      <ul className="space-y-3 list-none p-0 m-0" aria-label="Staff">
        {users.map((u) => (
          <li key={u.id}>
            <Card padding="md">
              <UserCell user={u} isSelf={u.id === me?.id} large />
              <div className="mt-2 font-mono text-[12px] text-[var(--text-secondary)]">
                Last active {relativeTime(u.last_active ?? u.last_login).toLowerCase()}
              </div>
              <div className="mt-3 grid grid-cols-1 gap-3">
                <div className="space-y-1.5">
                  <span className="block text-[13px] font-semibold text-[var(--text-secondary)]">Role</span>
                  <RoleControl {...controlProps(u)} />
                </div>
                <div className="space-y-1.5">
                  <span className="block text-[13px] font-semibold text-[var(--text-secondary)]">Status</span>
                  <StatusControl {...controlProps(u)} />
                </div>
              </div>
            </Card>
          </li>
        ))}
      </ul>
    );
  } else {
    body = (
      <Card padding="none" className="overflow-hidden">
        <DataTable columns={columns} rows={users} getRowKey={(u) => u.id} caption="Staff accounts" />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {revocation && (
        <InlineBanner
          tone="warn"
          title="Sessions not yet revoked"
          onDismiss={() => setRevocation(null)}
          action={
            <Button
              size="sm"
              variant="outline"
              disabled={forceLogout.isPending}
              onClick={() =>
                forceLogout.mutate(revocation.userId, {
                  onSuccess: () => { showToast(`Signed ${revocation.email} out everywhere`, 'success'); setRevocation(null); },
                  onError: (e) => showToast((e as Error).message, 'error'),
                })
              }
            >
              Sign out everywhere
            </Button>
          }
        >
          {revocation.warning}
        </InlineBanner>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_200px_200px]">
        <Input
          type="search"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search name or email"
          aria-label="Search staff"
        />
        <Select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} aria-label="Filter by role">
          <option value="">All roles</option>
          {ALL_STAFF_ROLES.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
        </Select>
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status">
          <option value="">Any status</option>
          {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </Select>
      </div>

      {body}

      {q.truncated && !q.isLoading && (
        <p className="m-0 text-[13px] text-[var(--text-tertiary)]">
          Showing the first {q.users.length} of {q.total} staff accounts. Narrow the search to find the rest.
        </p>
      )}

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => { if (!open) setPending(null); }}
        {...confirmCopy(pending)}
        onConfirm={confirmPending}
      />
    </div>
  );
}

function confirmCopy(p: PendingChange | null) {
  if (!p) return { title: '', confirmLabel: 'Confirm' };
  const name = p.user.name ?? p.user.email;
  if (p.kind === 'role') {
    const demotion = (ROLE_RANK[p.to] ?? 0) < (ROLE_RANK[p.user.role] ?? 0);
    return {
      title: `Change ${name} to ${roleLabel(p.to)}?`,
      description: `${name} goes from ${roleLabel(p.user.role)} to ${roleLabel(p.to)}.`,
      consequence: 'Their signed-in sessions end, so they will need to sign in again.',
      confirmLabel: `Make ${roleLabel(p.to)}`,
      tone: demotion ? ('danger' as const) : ('primary' as const),
    };
  }
  const suspend = p.to === 'suspended';
  return {
    title: `${suspend ? 'Suspend' : 'Deactivate'} ${name}?`,
    description: suspend
      ? `${name} loses access on their next request.`
      : `${name}'s account is closed and they can no longer sign in.`,
    consequence: 'You can reactivate the account later.',
    confirmLabel: suspend ? 'Suspend' : 'Deactivate',
    tone: 'danger' as const,
  };
}

function UserCell({ user: u, isSelf, large = false }: { user: PlatformUser; isSelf: boolean; large?: boolean }) {
  const size = large ? 40 : 32;
  return (
    <div className="flex items-center gap-3 min-w-0">
      <div
        aria-hidden="true"
        className="grid shrink-0 place-items-center rounded-lg text-[12px] font-extrabold"
        style={{ width: size, height: size, background: isSelf ? SELF_AVATAR_COLOR : colorForUserId(u.id), color: 'var(--text-on-amber)' }}
      >
        {parseInitials(u.name, u.email)}
      </div>
      <div className="min-w-0">
        <div className="truncate text-[14px] font-medium text-[var(--text-primary)]">
          {u.name ?? u.email}
          {isSelf && <span className="ml-1.5 text-[12px] font-normal text-[var(--text-tertiary)]">(you)</span>}
        </div>
        {u.name && <div className="truncate font-mono text-[12px] text-[var(--text-tertiary)]">{u.email}</div>}
      </div>
    </div>
  );
}

interface ControlProps {
  user: PlatformUser;
  /** False for self and for privileged accounts a non-super_admin may not touch. */
  touchable: boolean;
  grantable: StaffRoleValue[];
  busy: boolean;
  onRole: (r: PlatformUserRole) => void;
  onStatus: (s: PlatformUserStatus) => void;
}

/** Role select, or a static badge when the server would refuse the change. */
function RoleControl({ user: u, touchable, grantable, busy, onRole }: ControlProps) {
  const name = u.name ?? u.email;
  const editable = touchable && grantable.length > 1 && grantable.includes(u.role as StaffRoleValue);
  if (!editable) {
    const rb = roleBadgeProps(u.role);
    return <Badge {...rb.tone} font="sans" size="md">{rb.label}</Badge>;
  }
  return (
    <Select aria-label={`Role for ${name}`} value={u.role} disabled={busy} onChange={(e) => onRole(e.target.value as PlatformUserRole)}>
      {grantable.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
    </Select>
  );
}

function StatusControl({ user: u, touchable, busy, onStatus }: ControlProps) {
  if (!touchable) return statusBadge(u.status);
  return (
    <Select aria-label={`Status for ${u.name ?? u.email}`} value={u.status} disabled={busy} onChange={(e) => onStatus(e.target.value as PlatformUserStatus)}>
      {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </Select>
  );
}

// ─── Invites tab ────────────────────────────────────────────

function InvitesTab() {
  const { isSuperAdmin } = useAuth();
  const { showToast } = useToast();
  const q = useStaffInvites();
  const create = useCreateStaffInvite();
  const revoke = useRevokeStaffInvite();

  const roles = grantableRoles(isSuperAdmin);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<StaffRoleValue>('analyst');
  const [toRevoke, setToRevoke] = useState<StaffInvite | null>(null);

  const trimmed = email.trim();
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!emailValid) return;
    create.mutate({ email: trimmed, role }, {
      onSuccess: () => { showToast(`Invite sent to ${trimmed}. It expires in 72 hours.`, 'success'); setEmail(''); },
      onError: (err) => showToast((err as Error).message, 'error'),
    });
  }

  let list: React.ReactNode;
  if (q.isError) {
    list = <PageState kind="error" layout="card" title="Couldn't load invites" description={(q.error as Error).message} onRetry={() => { void q.refetch(); }} />;
  } else if (q.isLoading) {
    list = <PageState kind="loading" layout="card" title="Loading invites…" />;
  } else if ((q.data ?? []).length === 0) {
    list = <PageState kind="empty" layout="card" title="No pending invites" description="Invites you send show up here until they are accepted or expire." />;
  } else {
    list = (
      <SettingsGroup title="Pending invites">
        {(q.data ?? []).map((inv) => (
          <SettingsRow
            key={inv.id}
            title={inv.email}
            description={`${roleLabel(inv.role)}${inv.invited_by_email ? ` · invited by ${inv.invited_by_email}` : ''}`}
            meta={expiresIn(inv.expires_at)}
            stackTrailing
            trailing={
              <Button variant="outline" size="sm" aria-label={`Revoke invite for ${inv.email}`} onClick={() => setToRevoke(inv)}>
                Revoke
              </Button>
            }
          />
        ))}
      </SettingsGroup>
    );
  }

  return (
    <div className="space-y-6">
      <SettingsGroup
        title="Invite staff"
        footer={isSuperAdmin ? 'Invites expire after 72 hours.' : 'Invites expire after 72 hours. Only super admins can invite admins.'}
      >
        <form onSubmit={submit} className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_200px_auto] sm:items-end">
          <Field label="Email">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@averrow.com" autoComplete="off" />
          </Field>
          <Field label="Role">
            <Select value={role} onChange={(e) => setRole(e.target.value as StaffRoleValue)} disabled={roles.length === 1}>
              {roles.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
            </Select>
          </Field>
          <Button type="submit" size="lg" className="sm:h-11" disabled={!emailValid || create.isPending}>
            {create.isPending ? 'Sending…' : 'Send invite'}
          </Button>
        </form>
      </SettingsGroup>

      {list}

      <ConfirmDialog
        open={toRevoke !== null}
        onOpenChange={(open) => { if (!open) setToRevoke(null); }}
        title={`Revoke the invite for ${toRevoke?.email ?? ''}?`}
        description="The invite link stops working immediately."
        consequence="You can send a new invite any time."
        confirmLabel="Revoke invite"
        onConfirm={async () => {
          if (!toRevoke) return;
          await revoke.mutateAsync(toRevoke.id);
          showToast(`Invite for ${toRevoke.email} revoked`, 'success');
        }}
      />
    </div>
  );
}

export default UsersAccess;
