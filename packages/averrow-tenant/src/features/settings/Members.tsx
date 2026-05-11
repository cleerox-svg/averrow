import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, UserPlus, Mail, Trash2, AlertTriangle, Copy, Check } from 'lucide-react';
import { parseInitials, colorForUserId } from '@averrow/shared/avatar';
import { useAuth } from '@/lib/auth';
import {
  useOrgMembers,
  useOrgInvites,
  useInviteMember,
  useRevokeInvite,
  useRemoveMember,
  useUpdateMemberRole,
  canManageMembers,
  ORG_ROLE_LABELS,
  INVITABLE_ROLES,
  type OrgMember,
  type OrgInvite,
  type OrgRole,
} from '@/lib/members';

export function Members() {
  const { user } = useAuth();
  const userCanManage = canManageMembers(user?.role, user?.organization?.role);
  const { data: members, isLoading: membersLoading, error: membersError } = useOrgMembers();
  const { data: invites, isLoading: invitesLoading } = useOrgInvites();

  return (
    <div className="max-w-3xl space-y-6">
      <Link
        to="/settings"
        className="inline-flex items-center gap-1.5 text-[11px] font-mono text-white/40 hover:text-white/70"
      >
        <ArrowLeft size={12} /> BACK TO SETTINGS
      </Link>

      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/40">Settings</div>
          <h1 className="text-[24px] font-bold text-white tracking-tight">Members</h1>
          <p className="mt-1 text-sm text-white/55 max-w-2xl">
            Anyone with access to {user?.organization?.name ?? 'this organization'}. Org admins and owners can invite, remove, and change roles.
          </p>
        </div>
      </header>

      {!userCanManage ? (
        <section className="rounded-xl border border-amber/[0.20] bg-amber/[0.04] p-6 flex items-start gap-3">
          <AlertTriangle className="text-amber flex-shrink-0 mt-0.5" size={18} />
          <div>
            <h2 className="text-sm font-semibold text-amber">Access restricted</h2>
            <p className="text-[12px] text-white/65 mt-1 max-w-2xl leading-relaxed">
              Only org admins and owners can view and manage the member list. If you need to add or remove someone, ask an admin in {user?.organization?.name ?? 'your organization'}.
            </p>
          </div>
        </section>
      ) : (
        <>
          <InviteForm />

          <section className="rounded-xl border border-white/[0.06] bg-bg-card p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-white/90">Active members</h2>
              <span className="text-[11px] font-mono text-white/45 tabular-nums">
                {members?.length ?? 0}
              </span>
            </div>

            {membersLoading && (
              <p className="text-[12px] text-white/40 font-mono py-6 text-center">Loading…</p>
            )}
            {membersError && (
              <p className="text-[12px] text-sev-critical py-2">
                {membersError instanceof Error ? membersError.message : 'Failed to load members'}
              </p>
            )}
            {!membersLoading && !membersError && (!members || members.length === 0) && (
              <p className="text-[12px] text-white/45 py-2">No members yet.</p>
            )}
            {!membersLoading && members && members.length > 0 && (
              <div className="space-y-1">
                {members.map((m) => (
                  <MemberRow
                    key={m.user_id}
                    member={m}
                    canManage={userCanManage}
                    isSelf={m.user_id === user?.id}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="rounded-xl border border-white/[0.06] bg-bg-card p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-white/90">Pending invitations</h2>
              <span className="text-[11px] font-mono text-white/45 tabular-nums">
                {invites?.length ?? 0}
              </span>
            </div>

            {invitesLoading && (
              <p className="text-[12px] text-white/40 font-mono py-6 text-center">Loading…</p>
            )}
            {!invitesLoading && (!invites || invites.length === 0) && (
              <p className="text-[12px] text-white/45 py-2">No pending invitations.</p>
            )}
            {!invitesLoading && invites && invites.length > 0 && (
              <div className="space-y-1">
                {invites.map((inv) => (
                  <InviteRow key={inv.id} invite={inv} canManage={userCanManage} />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

// ─── Invite form ───────────────────────────────────────────────

function InviteForm() {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>('viewer');
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const invite = useInviteMember();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    invite.mutate(
      { email: email.trim(), org_role: role },
      {
        onSuccess: (data) => {
          setEmail('');
          setRole('viewer');
          if (!data.email_sent) setCopiedUrl(data.invite_url);
        },
      },
    );
  };

  const copyToClipboard = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Clipboard may be unavailable in older browsers; the URL is
      // still displayed for manual copy.
    }
  };

  return (
    <section className="rounded-xl border border-white/[0.06] bg-bg-card p-5">
      <div className="flex items-center gap-2 mb-3">
        <UserPlus size={14} className="text-amber" />
        <h2 className="text-sm font-semibold text-white/90">Invite a teammate</h2>
      </div>
      <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-2">
        <input
          type="email"
          required
          placeholder="email@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="flex-1 min-w-0 rounded-lg border border-white/[0.08] bg-bg-page px-3 py-2 text-sm text-white placeholder-white/30 focus:border-amber focus:outline-none"
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as OrgRole)}
          className="rounded-lg border border-white/[0.08] bg-bg-page px-3 py-2 text-sm text-white focus:border-amber focus:outline-none"
        >
          {INVITABLE_ROLES.map((r) => (
            <option key={r} value={r}>{ORG_ROLE_LABELS[r] ?? r}</option>
          ))}
        </select>
        <button
          type="submit"
          disabled={invite.isPending || !email.trim()}
          className="inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-amber text-[#0a0a0a] rounded-lg font-semibold text-sm hover:bg-amber-dim disabled:opacity-55 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
        >
          {invite.isPending ? 'Sending…' : <><Mail size={14} /> Send invite</>}
        </button>
      </form>

      {invite.error && (
        <p className="text-[12px] text-sev-critical mt-2">
          {invite.error instanceof Error ? invite.error.message : 'Invite failed'}
        </p>
      )}

      {copiedUrl && (
        <div className="mt-3 rounded-lg border border-amber/[0.25] bg-amber/[0.04] p-3">
          <p className="text-[12px] text-amber/95 mb-2">
            Invite created. Email delivery is not configured — share this link directly:
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 text-[11px] font-mono text-white/75 bg-bg-page border border-white/[0.06] rounded px-2 py-1.5 truncate">
              {copiedUrl}
            </code>
            <button
              type="button"
              onClick={() => copyToClipboard(copiedUrl)}
              className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-1.5 text-[11px] font-mono text-white/65 hover:text-white border border-white/[0.08] rounded hover:border-white/[0.20] transition-colors"
            >
              <Copy size={12} /> Copy
            </button>
            <button
              type="button"
              onClick={() => setCopiedUrl(null)}
              className="flex-shrink-0 text-[11px] font-mono text-white/45 hover:text-white/70 px-1"
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// ─── Member row ────────────────────────────────────────────────

function MemberRow({
  member,
  canManage,
  isSelf,
}: {
  member:    OrgMember;
  canManage: boolean;
  isSelf:    boolean;
}) {
  const initials = parseInitials(member.user_name, member.email);
  const color = colorForUserId(member.user_id);
  const updateRole = useUpdateMemberRole();
  const removeMember = useRemoveMember();
  const [editingRole, setEditingRole] = useState(false);
  const error = updateRole.error ?? removeMember.error;

  // Owners can't be downgraded or removed from the tenant UI —
  // ownership transfer is a deliberate, manual operation.
  const canManageThis = canManage && !isSelf && member.role !== 'owner';

  const handleRoleChange = (role: OrgRole) => {
    setEditingRole(false);
    if (role === (member.role as OrgRole)) return;
    updateRole.mutate({ userId: member.user_id, role });
  };

  const handleRemove = () => {
    const ok = window.confirm(
      `Remove ${member.user_name || member.email} from this organization?`,
    );
    if (!ok) return;
    removeMember.mutate(member.user_id);
  };

  return (
    <div className="flex items-center gap-3 py-2 px-2 -mx-2 rounded-lg hover:bg-white/[0.02] transition-colors">
      <div
        className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold text-[#0a0a0a]"
        style={{ backgroundColor: color }}
      >
        {initials}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-white/90 font-medium truncate">{member.user_name || member.email}</span>
          {isSelf && (
            <span className="text-[10px] font-mono uppercase tracking-wider text-amber bg-amber/[0.08] border border-amber/[0.25] rounded px-1.5 py-0.5">
              You
            </span>
          )}
        </div>
        <div className="text-[11px] font-mono text-white/45 truncate">{member.email}</div>
      </div>
      <div className="flex-shrink-0 flex items-center gap-2">
        {editingRole && canManageThis ? (
          <select
            autoFocus
            defaultValue={member.role}
            onBlur={() => setEditingRole(false)}
            onChange={(e) => handleRoleChange(e.target.value as OrgRole)}
            className="rounded-md border border-white/[0.10] bg-bg-page px-2 py-1 text-[11px] font-mono text-white focus:border-amber focus:outline-none"
          >
            {INVITABLE_ROLES.map((r) => (
              <option key={r} value={r}>{ORG_ROLE_LABELS[r] ?? r}</option>
            ))}
          </select>
        ) : (
          <button
            type="button"
            disabled={!canManageThis || updateRole.isPending}
            onClick={() => setEditingRole(true)}
            className={`text-[11px] font-mono uppercase tracking-wider px-2 py-0.5 rounded border ${
              canManageThis
                ? 'border-white/[0.10] text-white/75 hover:text-white hover:border-white/[0.25] cursor-pointer'
                : 'border-white/[0.05] text-white/45 cursor-default'
            } transition-colors`}
            title={canManageThis ? 'Click to change role' : undefined}
          >
            {ORG_ROLE_LABELS[member.role] ?? member.role}
          </button>
        )}
        {canManageThis && (
          <button
            type="button"
            onClick={handleRemove}
            disabled={removeMember.isPending}
            className="inline-flex items-center justify-center w-7 h-7 rounded text-white/45 hover:text-sev-critical hover:bg-sev-critical/[0.10] disabled:opacity-55 disabled:cursor-not-allowed transition-colors"
            title="Remove member"
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
      {error !== null && error !== undefined && (
        <p className="text-[11px] text-sev-critical">
          {error instanceof Error ? error.message : 'Action failed'}
        </p>
      )}
    </div>
  );
}

// ─── Invite row ────────────────────────────────────────────────

function InviteRow({ invite, canManage }: { invite: OrgInvite; canManage: boolean }) {
  const revoke = useRevokeInvite();
  const initials = parseInitials(null, invite.email);
  const color = colorForUserId(invite.id);
  const expiresAt = new Date(invite.expires_at);
  const isExpired = !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() < Date.now();

  const handleRevoke = () => {
    const ok = window.confirm(`Revoke invitation to ${invite.email}?`);
    if (!ok) return;
    revoke.mutate(invite.id);
  };

  return (
    <div className="flex items-center gap-3 py-2 px-2 -mx-2 rounded-lg hover:bg-white/[0.02] transition-colors">
      <div
        className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold text-[#0a0a0a] opacity-60"
        style={{ backgroundColor: color }}
      >
        {initials}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-white/85 truncate">{invite.email}</span>
          {isExpired ? (
            <span className="text-[10px] font-mono uppercase tracking-wider text-sev-critical bg-sev-critical/[0.10] border border-sev-critical/[0.30] rounded px-1.5 py-0.5">
              Expired
            </span>
          ) : (
            <span className="text-[10px] font-mono uppercase tracking-wider text-white/55 bg-white/[0.04] border border-white/[0.08] rounded px-1.5 py-0.5">
              Pending
            </span>
          )}
        </div>
        <div className="text-[11px] font-mono text-white/45">
          Invited as {ORG_ROLE_LABELS[invite.org_role] ?? invite.org_role}
          {!isExpired && ' · expires '}
          {!isExpired && formatRelative(invite.expires_at)}
        </div>
      </div>
      {canManage && (
        <button
          type="button"
          onClick={handleRevoke}
          disabled={revoke.isPending}
          className="flex-shrink-0 inline-flex items-center justify-center w-7 h-7 rounded text-white/45 hover:text-sev-critical hover:bg-sev-critical/[0.10] disabled:opacity-55 disabled:cursor-not-allowed transition-colors"
          title="Revoke invitation"
        >
          {revoke.isPending ? <Check size={13} /> : <Trash2 size={13} />}
        </button>
      )}
    </div>
  );
}

function formatRelative(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const diff = d.getTime() - Date.now();
  if (diff <= 0) return 'expired';
  const hours = Math.round(diff / 3_600_000);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.round(hours / 24);
  return `in ${days}d`;
}
