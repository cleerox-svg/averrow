// Platform Users — staff/user account admin (admin+).
//
// Closes the audit's biggest gap: the worker has had list/role/status/
// sessions/force-logout endpoints since Phase F with no UI consumer.
// Layout follows the conventional users-admin pattern (GitHub/Slack-style):
// search + role/status filters over a paginated table; inline role select
// and status actions with confirm; expandable per-user recent sessions;
// pending invitations with create/revoke.
//
// Guardrails mirrored from the server (handleAdminUpdateUser):
//   - only super_admin can assign admin / super_admin
//   - you cannot change your own role (self row renders a static badge)
// Roles offered are the CHECK-valid four; sales/support/billing are not
// assignable to stored users on prod (CLAUDE.md §7).

import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import {
  Card,
  Button,
  Badge,
  PageHeader,
  SectionLabel,
  Select,
  FilterBar,
  PageState,
  Table, Th, Td,
} from '@/design-system/components';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { relativeTime } from '@/lib/time';
import { parseInitials, colorForUserId, SELF_AVATAR_COLOR } from '@/lib/avatar';
import {
  usePlatformUsers, useUpdatePlatformUser, useForceLogout, useUserSessions,
  useStaffInvites, useCreateStaffInvite, useRevokeStaffInvite,
  USERS_PAGE_SIZE,
  type PlatformUser, type PlatformUserRole,
} from '@/hooks/usePlatformUsers';

const ROLE_OPTIONS: Array<{ value: PlatformUserRole; label: string }> = [
  { value: 'super_admin', label: 'Super Admin' },
  { value: 'admin',       label: 'Admin' },
  { value: 'analyst',     label: 'Analyst' },
  { value: 'client',      label: 'Client' },
];

function roleBadgeVariant(role: string): 'critical' | 'high' | 'info' | 'default' {
  switch (role) {
    case 'super_admin': return 'critical';
    case 'admin':       return 'high';
    case 'analyst':     return 'info';
    default:            return 'default';
  }
}

function statusBadgeVariant(status: string): 'success' | 'medium' | 'default' {
  switch (status) {
    case 'active':    return 'success';
    case 'suspended': return 'medium';
    default:          return 'default';
  }
}

export function PlatformUsers() {
  const { user: me, isSuperAdmin } = useAuth();
  const isAdmin = isSuperAdmin || me?.role === 'admin';
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const searchTimer = useRef<number | undefined>(undefined);

  const { data, isLoading, error, refetch } = usePlatformUsers({
    q: debounced,
    role: roleFilter,
    status: statusFilter === 'all' ? '' : statusFilter,
    page,
  });
  const update = useUpdatePlatformUser();
  const forceLogout = useForceLogout();

  // Gate: admin+ only (matches requireAdmin on every endpoint used here).
  if (!isAdmin) {
    navigate('/admin', { replace: true });
    return null;
  }

  const users = data?.users ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / USERS_PAGE_SIZE));

  function submitSearch(v: string) {
    setSearch(v);
    // Debounce: only hit the server when input settles for 300ms.
    window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      setDebounced(v.trim());
      setPage(1);
    }, 300);
  }

  function changeRole(u: PlatformUser, nextRole: PlatformUserRole) {
    if (!window.confirm(`Change ${u.name ?? u.email}'s platform role from ${u.role} to ${nextRole}?`)) return;
    update.mutate({ userId: u.id, role: nextRole }, {
      onSuccess: () => showToast(`Role updated to ${nextRole}`, 'success'),
      onError: (e) => showToast((e as Error).message, 'error'),
    });
  }

  function changeStatus(u: PlatformUser, nextStatus: 'active' | 'suspended') {
    const verb = nextStatus === 'suspended' ? 'Suspend' : 'Reactivate';
    if (!window.confirm(`${verb} ${u.name ?? u.email}? ${nextStatus === 'suspended' ? 'They will lose access on their next request.' : ''}`)) return;
    update.mutate({ userId: u.id, status: nextStatus }, {
      onSuccess: () => showToast(`${verb}d ${u.email}`, 'success'),
      onError: (e) => showToast((e as Error).message, 'error'),
    });
  }

  function doForceLogout(u: PlatformUser) {
    if (!window.confirm(`Sign ${u.name ?? u.email} out of all devices? All active sessions are revoked immediately.`)) return;
    forceLogout.mutate(u.id, {
      onSuccess: () => showToast(`All sessions revoked for ${u.email}`, 'success'),
      onError: (e) => showToast((e as Error).message, 'error'),
    });
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Platform Users"
        subtitle="Staff roles, access status, and sessions"
        meta={<span>{total} account{total === 1 ? '' : 's'}</span>}
        actions={
          <Button onClick={() => setShowInvite(s => !s)}>
            {showInvite ? 'Close invite' : 'Invite user'}
          </Button>
        }
      />

      {showInvite && <InvitePanel onDone={() => setShowInvite(false)} />}

      <FilterBar
        filters={[
          { value: '',            label: 'All roles' },
          { value: 'super_admin', label: 'Super Admin' },
          { value: 'admin',       label: 'Admin' },
          { value: 'analyst',     label: 'Analyst' },
          { value: 'client',      label: 'Client' },
        ]}
        active={roleFilter}
        onChange={(v) => { setRoleFilter(v); setPage(1); }}
        search={{ value: search, onChange: submitSearch, placeholder: 'Search name or email…' }}
        actions={
          <Select
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
            options={[
              { value: 'all',         label: 'Any status' },
              { value: 'active',      label: 'Active' },
              { value: 'suspended',   label: 'Suspended' },
              { value: 'deactivated', label: 'Deactivated' },
            ]}
          />
        }
      />

      <Card className="p-0 overflow-hidden">
        {isLoading ? (
          <PageState kind="loading" layout="table" title="Loading users…" />
        ) : error ? (
          <PageState
            kind="error"
            layout="table"
            title="Couldn't load users"
            description={(error as Error).message}
            onRetry={() => { void refetch(); }}
          />
        ) : users.length === 0 ? (
          <PageState kind="empty" layout="table" title="No users match" description="Adjust the search or filters." />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <thead>
                <tr>
                  <Th>User</Th>
                  <Th>Role</Th>
                  <Th>Status</Th>
                  <Th>Last active</Th>
                  <Th>Joined</Th>
                  <Th>Actions</Th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const isSelf = u.id === me?.id;
                  // Server rule: only super_admin can grant admin/super_admin.
                  // Non-SA admins get the two roles they can actually set.
                  const assignable = isSuperAdmin
                    ? ROLE_OPTIONS
                    : ROLE_OPTIONS.filter(r => r.value === 'analyst' || r.value === 'client');
                  const expanded = expandedUser === u.id;
                  return (
                    <UserRow
                      key={u.id}
                      user={u}
                      isSelf={isSelf}
                      assignable={assignable}
                      expanded={expanded}
                      busy={update.isPending || forceLogout.isPending}
                      onToggleSessions={() => setExpandedUser(expanded ? null : u.id)}
                      onChangeRole={(r) => changeRole(u, r)}
                      onChangeStatus={(s) => changeStatus(u, s)}
                      onForceLogout={() => doForceLogout(u)}
                    />
                  );
                })}
              </tbody>
            </Table>
          </div>
        )}

        {/* Pagination */}
        {total > USERS_PAGE_SIZE && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-white/[0.06]">
            <span className="font-mono text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
              Page {page} of {totalPages} · {total} users
            </span>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>← Prev</Button>
              <Button variant="ghost" size="sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next →</Button>
            </div>
          </div>
        )}
      </Card>

      <PendingInvites />
    </div>
  );
}

// ─── User row (+ expandable sessions) ───────────────────────────

function UserRow({
  user: u, isSelf, assignable, expanded, busy,
  onToggleSessions, onChangeRole, onChangeStatus, onForceLogout,
}: {
  user: PlatformUser;
  isSelf: boolean;
  assignable: Array<{ value: PlatformUserRole; label: string }>;
  expanded: boolean;
  busy: boolean;
  onToggleSessions: () => void;
  onChangeRole: (r: PlatformUserRole) => void;
  onChangeStatus: (s: 'active' | 'suspended') => void;
  onForceLogout: () => void;
}) {
  const initials = parseInitials(u.name, u.email);
  const avatarColor = isSelf ? SELF_AVATAR_COLOR : colorForUserId(u.id);
  // The select only offers roles this admin can assign; if the target's
  // current role isn't in that set (e.g. an analyst-admin looking at a
  // super_admin), render a static badge instead of a lying dropdown.
  const canEditRole = !isSelf && assignable.some(r => r.value === u.role);

  return (
    <>
      <tr className="data-row">
        <Td>
          <div className="flex items-center gap-3 min-w-[180px]">
            <div
              className="w-8 h-8 rounded-lg grid place-items-center text-[11px] font-extrabold shrink-0"
              style={{ background: avatarColor, color: '#0A0F1E' }}
            >
              {initials}
            </div>
            <div className="min-w-0">
              <div className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                {u.name ?? u.email}{isSelf && <span className="font-mono text-[10px] ml-1.5" style={{ color: 'var(--text-tertiary)' }}>(you)</span>}
              </div>
              <div className="font-mono text-[11px] truncate" style={{ color: 'var(--text-tertiary)' }}>{u.email}</div>
            </div>
          </div>
        </Td>
        <Td>
          {canEditRole ? (
            <Select
              value={u.role}
              onChange={(e) => {
                const next = e.target.value as PlatformUserRole;
                if (next !== u.role) onChangeRole(next);
              }}
              options={assignable}
              className="px-2 py-1 text-[11px]"
            />
          ) : (
            <Badge variant={roleBadgeVariant(u.role)}>{u.role}</Badge>
          )}
        </Td>
        <Td><Badge variant={statusBadgeVariant(u.status)}>{u.status}</Badge></Td>
        <Td>
          <span className="font-mono text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            {u.last_active ? relativeTime(u.last_active) : u.last_login ? relativeTime(u.last_login) : 'never'}
          </span>
        </Td>
        <Td>
          <span className="font-mono text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            {new Date(u.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
          </span>
        </Td>
        <Td>
          <div className="flex items-center gap-1.5 flex-wrap">
            <Button variant="ghost" size="sm" onClick={onToggleSessions}>
              {expanded ? 'Hide sessions' : 'Sessions'}
            </Button>
            {!isSelf && (
              <>
                <Button variant="ghost" size="sm" onClick={onForceLogout} disabled={busy}>
                  Sign out all
                </Button>
                {u.status === 'active' ? (
                  <Button variant="ghost" size="sm" className="text-accent/70" onClick={() => onChangeStatus('suspended')} disabled={busy}>
                    Suspend
                  </Button>
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => onChangeStatus('active')} disabled={busy}>
                    Reactivate
                  </Button>
                )}
              </>
            )}
          </div>
        </Td>
      </tr>
      {expanded && (
        <tr>
          <Td colSpan={6} className="px-5 pb-4 pt-1 border-b-0">
            <SessionsPanel userId={u.id} />
          </Td>
        </tr>
      )}
    </>
  );
}

function SessionsPanel({ userId }: { userId: string }) {
  const { data: sessions, isLoading } = useUserSessions(userId);

  if (isLoading) return <div className="text-white/40 text-[11px] font-mono py-2">Loading sessions…</div>;
  if (!sessions || sessions.length === 0) {
    return <div className="text-white/40 text-[11px] font-mono py-2">No sessions recorded.</div>;
  }
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 space-y-1.5">
      <div className="font-mono text-[10px] uppercase tracking-widest mb-1" style={{ color: 'var(--text-tertiary)' }}>
        Recent sessions
      </div>
      {sessions.map((s) => (
        <div key={s.id} className="flex items-center gap-3 font-mono text-[11px] flex-wrap">
          <span style={{ color: 'var(--text-secondary)' }}>{relativeTime(s.issued_at)}</span>
          <span style={{ color: 'var(--text-tertiary)' }}>{s.ip_address ?? 'ip unknown'}</span>
          <span className="truncate max-w-[320px]" style={{ color: 'var(--text-tertiary)' }}>
            {s.user_agent ? s.user_agent.slice(0, 60) : 'agent unknown'}
          </span>
          {s.revoked_at
            ? <Badge variant="default">revoked</Badge>
            : new Date(s.expires_at) > new Date()
              ? <Badge variant="success">active</Badge>
              : <Badge variant="default">expired</Badge>}
        </div>
      ))}
    </div>
  );
}

// ─── Invites ─────────────────────────────────────────────────────

function InvitePanel({ onDone }: { onDone: () => void }) {
  const { isSuperAdmin } = useAuth();
  const { showToast } = useToast();
  const create = useCreateStaffInvite();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<PlatformUserRole>('analyst');

  const options = isSuperAdmin
    ? ROLE_OPTIONS
    : ROLE_OPTIONS.filter(r => r.value === 'analyst' || r.value === 'client');

  function submit() {
    if (!email.trim()) return;
    create.mutate({ email: email.trim(), role }, {
      onSuccess: () => {
        showToast(`Invite sent to ${email.trim()} (expires in 72h)`, 'success');
        setEmail('');
        onDone();
      },
      onError: (e) => showToast((e as Error).message, 'error'),
    });
  }

  return (
    <Card>
      <SectionLabel className="mb-3">Invite a user</SectionLabel>
      <div className="grid grid-cols-1 sm:grid-cols-[2fr_max-content_max-content] gap-2 items-end">
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-widest mb-1" style={{ color: 'var(--text-tertiary)' }}>Email</label>
          <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" type="email" />
        </div>
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-widest mb-1" style={{ color: 'var(--text-tertiary)' }}>Role</label>
          <Select value={role} onChange={(e) => setRole(e.target.value as PlatformUserRole)} options={options} />
        </div>
        <Button onClick={submit} disabled={create.isPending || !email.trim()}>
          {create.isPending ? 'Sending…' : 'Send invite'}
        </Button>
      </div>
    </Card>
  );
}

function PendingInvites() {
  const { data: invites = [], isLoading } = useStaffInvites();
  const revoke = useRevokeStaffInvite();
  const { showToast } = useToast();

  if (isLoading || invites.length === 0) return null;

  return (
    <Card>
      <SectionLabel className="mb-3">Pending invitations</SectionLabel>
      <div className="space-y-2">
        {invites.map((inv) => (
          <div key={inv.id} className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[13px] truncate" style={{ color: 'var(--text-primary)' }}>{inv.email}</span>
              <Badge variant={roleBadgeVariant(inv.role)}>{inv.role}</Badge>
              <span className="font-mono text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                expires {relativeTime(inv.expires_at)}
                {inv.invited_by_email && <> · by {inv.invited_by_email}</>}
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                if (window.confirm(`Revoke the invite for ${inv.email}?`)) {
                  revoke.mutate(inv.id, {
                    onSuccess: () => showToast(`Invite revoked`, 'success'),
                    onError: (e) => showToast((e as Error).message, 'error'),
                  });
                }
              }}
              disabled={revoke.isPending}
            >
              Revoke
            </Button>
          </div>
        ))}
      </div>
    </Card>
  );
}
