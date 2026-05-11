import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, ShieldOff, FileSignature, AlertTriangle, Users } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import {
  useTakedownAuthorization,
  useRevokeAuthorization,
  useSignAuthorization,
  canRevokeAuthorization,
  canSignAuthorization,
  ESCALATION_LABELS,
  type TakedownAuthorization,
  type AuthorizationScope,
  type EscalationMode,
} from '@/lib/takedownAuthorization';
import {
  AGREEMENT_VERSION,
  AGREEMENT_TITLE,
  AGREEMENT_SUMMARY,
  AGREEMENT_SECTIONS,
} from '@/lib/takedown-msa';
import { useOrgMembers, useOrgInvites, canManageMembers } from '@/lib/members';
import { MODULE_LABELS, type ModuleKey } from '@/lib/modules';

const ALL_MODULE_KEYS = Object.keys(MODULE_LABELS) as ModuleKey[];

// User profile (display name, theme, timezone, passkeys, sessions)
// lives at /profile per SHARED_LOGIN_SPEC §2 — rendered by the
// shared @averrow/shared/profile ProfilePage. This page hosts
// only the org-scoped settings: takedown authorization + billing.

export function Settings() {
  const { user } = useAuth();
  const { data } = useTakedownAuthorization();
  const auth = data?.authorization ?? null;
  const { data: members } = useOrgMembers();
  const { data: invites } = useOrgInvites();

  const userCanManageMembers = canManageMembers(user?.role, user?.organization?.role);
  const memberCount = members?.length ?? 0;
  const pendingCount = invites?.length ?? 0;

  return (
    <div className="max-w-4xl space-y-6">
      <header>
        <h1 className="text-[28px] font-bold text-white tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-white/55">{user?.organization?.name ?? 'Your organization'}</p>
      </header>

      <section className="rounded-xl border border-white/[0.06] bg-bg-card p-5 flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Users size={14} className="text-white/45" />
            <h2 className="text-sm font-semibold text-white/90">Members</h2>
          </div>
          <p className="text-[11px] text-white/55 mt-1 max-w-md">
            {userCanManageMembers ? (
              <>
                {memberCount} active member{memberCount === 1 ? '' : 's'}
                {pendingCount > 0 && ` · ${pendingCount} pending invite${pendingCount === 1 ? '' : 's'}`}
                {memberCount === 0 && pendingCount === 0 && 'Invite teammates, change roles, manage access.'}
              </>
            ) : (
              'Org admins can invite teammates and manage roles.'
            )}
          </p>
        </div>
        <Link to="/settings/members" className="text-[11px] font-mono text-amber hover:underline whitespace-nowrap">
          Manage →
        </Link>
      </section>

      <section className="rounded-xl border border-white/[0.06] bg-bg-card p-5 flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-white/90">Takedown authorization</h2>
            {auth ? (
              <span className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-green bg-green/[0.08] border border-green/[0.25] rounded px-1.5 py-0.5">
                <CheckCircle2 size={10} /> Signed
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-amber bg-amber/[0.08] border border-amber/[0.25] rounded px-1.5 py-0.5">
                <AlertTriangle size={10} /> Not signed
              </span>
            )}
          </div>
          <p className="text-[11px] text-white/55 mt-1 max-w-md">
            Sign once to let Averrow auto-submit takedown requests on your behalf. Coverage is per-module.
          </p>
        </div>
        <Link to="/settings/takedown-authorization" className="text-[11px] font-mono text-amber hover:underline whitespace-nowrap">
          Manage →
        </Link>
      </section>

      <section className="rounded-xl border border-white/[0.06] bg-bg-card p-5 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-white/90">Billing</h2>
          <p className="text-[11px] text-white/55 mt-1 max-w-md">
            Plan, monthly total, active modules, and trial / billing status.
          </p>
        </div>
        <Link to="/settings/billing" className="text-[11px] font-mono text-amber hover:underline whitespace-nowrap">
          View →
        </Link>
      </section>
    </div>
  );
}


export function TakedownAuthorizationPage() {
  const { user } = useAuth();
  const { data, isLoading, error } = useTakedownAuthorization();
  const revoke = useRevokeAuthorization();
  const auth = data?.authorization ?? null;

  const userCanRevoke = canRevokeAuthorization(user?.role, user?.organization?.role);

  const onRevoke = () => {
    if (!auth) return;
    const ok = window.confirm(
      'Revoke takedown authorization?\n\nAveraged auto-takedown submissions will stop. You can re-authorize at any time by contacting support.',
    );
    if (!ok) return;
    revoke.mutate();
  };

  return (
    <div className="max-w-3xl space-y-6">
      <Link
        to="/settings"
        className="inline-flex items-center gap-1.5 text-[11px] font-mono text-white/40 hover:text-white/70"
      >
        <ArrowLeft size={12} /> BACK TO SETTINGS
      </Link>

      <header>
        <div className="text-[11px] uppercase tracking-[0.18em] font-mono text-white/40">Settings</div>
        <h1 className="text-[24px] font-bold text-white tracking-tight">Takedown Authorization</h1>
        <p className="mt-1 text-sm text-white/55 max-w-2xl">
          One signed authorization lets Averrow submit takedown requests on your behalf — DNS, hosting, app stores, social. Scope and limits are recorded per-org.
        </p>
      </header>

      {isLoading && (
        <div className="text-white/40 text-sm font-mono py-12 text-center">Loading…</div>
      )}

      {error && (
        <section className="rounded-xl border border-sev-critical/[0.30] bg-sev-critical/[0.06] p-5">
          <h2 className="text-sm font-semibold text-white/90">Couldn't load authorization</h2>
          <p className="text-[12px] text-white/55 mt-1">{error instanceof Error ? error.message : 'Unknown error'}</p>
        </section>
      )}

      {!isLoading && !error && auth && (
        <AuthorizationDetails auth={auth} canRevoke={userCanRevoke} onRevoke={onRevoke} revoking={revoke.isPending} revokeError={revoke.error} />
      )}

      {!isLoading && !error && !auth && (
        userCanRevoke
          ? <SignAuthorizationForm />
          : <NotSignedYetReadOnly />
      )}
    </div>
  );
}

function AuthorizationDetails({
  auth,
  canRevoke,
  onRevoke,
  revoking,
  revokeError,
}: {
  auth:        TakedownAuthorization;
  canRevoke:   boolean;
  onRevoke:    () => void;
  revoking:    boolean;
  revokeError: unknown;
}) {
  return (
    <>
      <section className="rounded-xl border border-green/[0.25] bg-green/[0.04] p-5">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="text-green flex-shrink-0 mt-0.5" size={18} />
          <div className="flex-1">
            <h2 className="text-sm font-semibold text-green">Authorization is active</h2>
            <p className="text-[12px] text-white/65 mt-1">
              Signed {formatDate(auth.signed_at)} · Agreement {auth.agreement_version}
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-white/[0.06] bg-bg-card p-5">
        <h3 className="text-[11px] uppercase tracking-widest font-mono text-white/45 mb-3">Scope</h3>
        <dl className="space-y-3">
          <Row label="Modules covered">
            {auth.scope.modules.length === 0 ? (
              <span className="text-[12px] text-white/45">None — contact support to expand coverage.</span>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {auth.scope.modules.map((m) => (
                  <span
                    key={m}
                    className="text-[11px] font-mono text-white/75 bg-white/[0.04] border border-white/[0.08] rounded px-1.5 py-0.5"
                  >
                    {m}
                  </span>
                ))}
              </div>
            )}
          </Row>
          <Row label="Monthly cap">
            <span className="text-[13px] text-white/85 font-mono tabular-nums">
              {auth.scope.max_takedowns_per_month === null
                ? 'Unlimited'
                : `${auth.scope.max_takedowns_per_month.toLocaleString()} / month`}
            </span>
          </Row>
          <Row label="Escalation">
            <span className="text-[13px] text-white/85">
              {ESCALATION_LABELS[auth.scope.escalation] ?? auth.scope.escalation}
            </span>
          </Row>
          <Row label="Auto-followup">
            <span className="text-[13px] text-white/85">
              {auth.scope.auto_followup_breached_sla_hours === null
                ? 'Off'
                : `After ${auth.scope.auto_followup_breached_sla_hours}h SLA breach`}
            </span>
          </Row>
          <Row label="High-risk approval">
            <span className="text-[13px] text-white/85">
              {auth.scope.high_risk_requires_per_takedown_approval
                ? 'Per-takedown approval required'
                : 'Auto-submit'}
            </span>
          </Row>
        </dl>
      </section>

      <section className="rounded-xl border border-white/[0.06] bg-bg-card p-5">
        <h3 className="text-[11px] uppercase tracking-widest font-mono text-white/45 mb-3">Signing record</h3>
        <dl className="space-y-2">
          <Row label="Signed by"><span className="text-[12px] text-white/75 font-mono">{auth.signed_by_user_id}</span></Row>
          <Row label="Signed at"><span className="text-[12px] text-white/75 font-mono">{formatDateTime(auth.signed_at)}</span></Row>
          {auth.signed_ip && (
            <Row label="IP address"><span className="text-[12px] text-white/75 font-mono">{auth.signed_ip}</span></Row>
          )}
        </dl>
      </section>

      <section className="rounded-xl border border-sev-critical/[0.20] bg-sev-critical/[0.04] p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h3 className="text-sm font-semibold text-sev-critical flex items-center gap-2">
              <ShieldOff size={14} /> Revoke authorization
            </h3>
            <p className="text-[12px] text-white/65 mt-1 max-w-md">
              Stops all automated takedown submissions. In-flight requests already submitted to providers are not recalled. You can re-authorize at any time.
            </p>
          </div>
          {canRevoke ? (
            <button
              type="button"
              onClick={onRevoke}
              disabled={revoking}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-sev-critical/[0.15] hover:bg-sev-critical/[0.25] text-sev-critical border border-sev-critical/[0.40] rounded-lg font-semibold text-sm transition-colors disabled:opacity-55 disabled:cursor-not-allowed"
            >
              {revoking ? 'Revoking…' : 'Revoke'}
            </button>
          ) : (
            <span className="text-[11px] text-white/45 font-mono">Org admin or owner required</span>
          )}
        </div>
        {revokeError !== null && revokeError !== undefined && (
          <p className="text-[12px] text-sev-critical mt-3">
            {revokeError instanceof Error ? revokeError.message : String(revokeError)}
          </p>
        )}
      </section>
    </>
  );
}

// Shown to viewers / analysts who can't sign. Admins / owners
// see the SignAuthorizationForm below instead.
function NotSignedYetReadOnly() {
  return (
    <section className="rounded-xl border border-amber/[0.25] bg-amber/[0.04] p-6">
      <div className="flex items-start gap-3">
        <FileSignature className="text-amber flex-shrink-0 mt-0.5" size={20} />
        <div>
          <h2 className="text-sm font-semibold text-amber">No authorization on file yet</h2>
          <p className="text-[12px] text-white/65 mt-2 leading-relaxed max-w-2xl">
            Without a signed authorization, Averrow detects and ranks impersonations but won't submit takedowns automatically.
          </p>
          <p className="text-[12px] text-white/65 mt-3 leading-relaxed max-w-2xl">
            An org admin or owner can sign on behalf of {' '}
            <span className="text-white/85">this organization</span>.
          </p>
        </div>
      </div>
    </section>
  );
}

// Tenant-side signing flow. Admin/owner only.
function SignAuthorizationForm() {
  const sign = useSignAuthorization();
  const [selectedModules, setSelectedModules] = useState<Set<ModuleKey>>(
    () => new Set(ALL_MODULE_KEYS),
  );
  const [cap, setCap] = useState<string>(''); // empty = unlimited
  const [escalation, setEscalation] = useState<EscalationMode>('auto_resubmit_on_pivot');
  const [autoFollowup, setAutoFollowup] = useState<string>('72');
  const [highRiskApproval, setHighRiskApproval] = useState<boolean>(true);
  const [agreed, setAgreed] = useState<boolean>(false);
  const [expanded, setExpanded] = useState<boolean>(false);

  const toggleModule = (key: ModuleKey) => {
    setSelectedModules((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!agreed) return;

    const capNum = cap.trim() === '' ? null : Number(cap);
    const followupNum = autoFollowup.trim() === '' ? null : Number(autoFollowup);
    if (capNum !== null && (!Number.isFinite(capNum) || capNum < 0)) return;
    if (followupNum !== null && (!Number.isFinite(followupNum) || followupNum < 0)) return;

    const scope: AuthorizationScope = {
      modules: Array.from(selectedModules),
      max_takedowns_per_month: capNum,
      escalation,
      auto_followup_breached_sla_hours: followupNum,
      high_risk_requires_per_takedown_approval: highRiskApproval,
    };

    sign.mutate({ agreement_version: AGREEMENT_VERSION, scope });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <section className="rounded-xl border border-amber/[0.15] bg-amber/[0.03] p-5">
        <div className="flex items-start gap-3">
          <FileSignature className="text-amber flex-shrink-0 mt-0.5" size={18} />
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-amber">{AGREEMENT_TITLE}</h2>
            <p className="text-[12px] text-white/70 mt-1 leading-relaxed">{AGREEMENT_SUMMARY}</p>
            <p className="text-[10px] font-mono uppercase tracking-wider text-amber/70 mt-2">
              Agreement {AGREEMENT_VERSION}
            </p>
          </div>
        </div>
      </section>

      {/* Agreement copy — collapsible */}
      <section className="rounded-xl border border-white/[0.06] bg-bg-card p-5">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center justify-between text-left"
        >
          <h3 className="text-sm font-semibold text-white/90">Full agreement</h3>
          <span className="text-[11px] font-mono text-amber">{expanded ? 'Hide ▾' : 'Read ▸'}</span>
        </button>
        {expanded && (
          <div className="mt-4 space-y-4 max-h-[420px] overflow-y-auto pr-2">
            {AGREEMENT_SECTIONS.map((s) => (
              <div key={s.heading}>
                <h4 className="text-[12px] font-semibold text-white/85 mb-1">{s.heading}</h4>
                <p className="text-[12px] text-white/65 leading-relaxed">{s.body}</p>
              </div>
            ))}
            <p className="text-[10px] text-white/40 italic pt-2 border-t border-white/[0.06]">
              {AGREEMENT_VERSION.includes('draft')
                ? 'This is a working-draft version of the agreement. Final legal copy will replace it before general availability; existing signed authorizations retain their original version stamp in the audit trail.'
                : 'See your organization\'s MSA for the master agreement these terms incorporate.'}
            </p>
          </div>
        )}
      </section>

      {/* Scope */}
      <section className="rounded-xl border border-white/[0.06] bg-bg-card p-5 space-y-5">
        <h3 className="text-sm font-semibold text-white/90">Scope</h3>

        <div>
          <label className="block text-[11px] uppercase tracking-wider font-mono text-white/45 mb-2">
            Modules covered ({selectedModules.size} of {ALL_MODULE_KEYS.length})
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {ALL_MODULE_KEYS.map((m) => {
              const on = selectedModules.has(m);
              return (
                <label
                  key={m}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                    on
                      ? 'border-amber/[0.40] bg-amber/[0.06]'
                      : 'border-white/[0.08] bg-bg-page hover:border-white/[0.15]'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => toggleModule(m)}
                    className="accent-amber"
                  />
                  <span className="text-[12px] text-white/85">{MODULE_LABELS[m]}</span>
                </label>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-[11px] uppercase tracking-wider font-mono text-white/45 mb-1.5">
              Monthly cap
            </label>
            <input
              type="number"
              min="0"
              placeholder="Unlimited"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              className="w-full rounded-lg border border-white/[0.08] bg-bg-page px-3 py-2 text-sm text-white placeholder-white/30 focus:border-amber focus:outline-none"
            />
            <p className="text-[10px] text-white/40 mt-1">Leave blank for unlimited.</p>
          </div>

          <div>
            <label className="block text-[11px] uppercase tracking-wider font-mono text-white/45 mb-1.5">
              Auto-followup (h)
            </label>
            <input
              type="number"
              min="0"
              placeholder="Off"
              value={autoFollowup}
              onChange={(e) => setAutoFollowup(e.target.value)}
              className="w-full rounded-lg border border-white/[0.08] bg-bg-page px-3 py-2 text-sm text-white placeholder-white/30 focus:border-amber focus:outline-none"
            />
            <p className="text-[10px] text-white/40 mt-1">Re-submit after provider misses SLA.</p>
          </div>
        </div>

        <div>
          <label className="block text-[11px] uppercase tracking-wider font-mono text-white/45 mb-1.5">
            Escalation
          </label>
          <select
            value={escalation}
            onChange={(e) => setEscalation(e.target.value as EscalationMode)}
            className="w-full rounded-lg border border-white/[0.08] bg-bg-page px-3 py-2 text-sm text-white focus:border-amber focus:outline-none"
          >
            <option value="auto_resubmit_on_pivot">{ESCALATION_LABELS.auto_resubmit_on_pivot}</option>
            <option value="manual_only">{ESCALATION_LABELS.manual_only}</option>
          </select>
        </div>

        <label className="flex items-start gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={highRiskApproval}
            onChange={(e) => setHighRiskApproval(e.target.checked)}
            className="accent-amber mt-0.5"
          />
          <span className="text-[12px] text-white/75 leading-relaxed">
            Require per-takedown approval for high-risk targets (recommended).
          </span>
        </label>
      </section>

      {/* Consent + submit */}
      <section className="rounded-xl border border-amber/[0.25] bg-amber/[0.04] p-5 space-y-4">
        <label className="flex items-start gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="accent-amber mt-0.5"
          />
          <span className="text-[12px] text-white/85 leading-relaxed">
            I have authority to act on behalf of this organization and accept the terms of the Takedown Submission Authorization ({AGREEMENT_VERSION}) above.
          </span>
        </label>

        {sign.error && (
          <p className="text-[12px] text-sev-critical">
            {sign.error instanceof Error ? sign.error.message : 'Signing failed'}
          </p>
        )}

        <button
          type="submit"
          disabled={!agreed || sign.isPending || selectedModules.size === 0}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-amber text-[#0a0a0a] rounded-lg font-semibold text-sm hover:bg-amber-dim disabled:opacity-55 disabled:cursor-not-allowed transition-colors"
        >
          {sign.isPending ? 'Signing…' : <><FileSignature size={14} /> Sign authorization</>}
        </button>
        {selectedModules.size === 0 && (
          <p className="text-[11px] text-white/55">Select at least one module to enable signing.</p>
        )}
      </section>
    </form>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 flex-wrap">
      <dt className="text-[11px] uppercase tracking-wider font-mono text-white/40 min-w-[140px]">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

function formatDate(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
