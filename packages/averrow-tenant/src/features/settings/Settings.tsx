import { Link } from 'react-router-dom';
import { useAuth } from '@/lib/auth';

export function Settings() {
  const { user } = useAuth();
  return (
    <div className="max-w-4xl space-y-6">
      <header>
        <h1 className="text-[28px] font-bold text-white tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-white/55">{user?.organization?.name ?? 'Your organization'}</p>
      </header>

      <section className="rounded-xl border border-white/[0.06] bg-bg-card p-5 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-white/90">Takedown authorization</h2>
          <p className="text-[11px] text-white/55 mt-1 max-w-md">
            Sign once to let Averrow auto-submit takedown requests on your behalf. Coverage is per-module.
          </p>
        </div>
        <Link to="/settings/takedown-authorization" className="text-[11px] font-mono text-amber hover:underline">
          Manage →
        </Link>
      </section>

      <section className="rounded-xl border border-white/[0.06] bg-bg-card p-5 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-white/90">Billing</h2>
          <p className="text-[11px] text-white/55 mt-1 max-w-md">
            Plan, monthly total, active modules, and trial / billing status.
          </p>
        </div>
        <Link to="/settings/billing" className="text-[11px] font-mono text-amber hover:underline">
          View →
        </Link>
      </section>

      <section className="rounded-xl border border-white/[0.06] bg-bg-card p-5">
        <h2 className="text-sm font-semibold text-white/90 mb-2">More settings</h2>
        <p className="text-[12px] text-white/45 leading-relaxed">
          Members, API keys, webhooks, SSO, integrations — porting from{' '}
          <code className="text-white/55">/v2/admin/users</code> in Phase B. For now, those still live in averrow-ops.
        </p>
      </section>
    </div>
  );
}

export function TakedownAuthorizationPage() {
  return (
    <div className="max-w-3xl space-y-6">
      <Link to="/settings" className="text-[11px] font-mono text-white/40 hover:text-white/70">← BACK TO SETTINGS</Link>
      <header>
        <h1 className="text-[24px] font-bold text-white tracking-tight">Takedown Authorization</h1>
      </header>
      <section className="rounded-xl border border-white/[0.06] bg-bg-card p-6">
        <h2 className="text-sm font-semibold text-white/90 mb-2">Tenant-side signing flow lands in Phase B</h2>
        <p className="text-[12px] text-white/55 leading-relaxed">
          The MSA copy and the signing flow are scoped for v3 Phase B.
          Until then, a super-admin records authorizations on your behalf via{' '}
          <code className="text-white/55">/api/admin/orgs/:id/takedown-authorization</code>.
          Contact{' '}
          <a href="mailto:support@averrow.com" className="text-amber hover:underline">support@averrow.com</a>{' '}
          to request authorization for your organization.
        </p>
      </section>
    </div>
  );
}
