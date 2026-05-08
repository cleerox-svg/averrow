import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { apiPatch } from '@/lib/api';
import { useTheme } from '@/lib/useTheme';

export function Settings() {
  const { user } = useAuth();
  return (
    <div className="max-w-4xl space-y-6">
      <header>
        <h1 className="text-[28px] font-bold text-white tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-white/55">{user?.organization?.name ?? 'Your organization'}</p>
      </header>

      <ProfileSection />

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

// ─── Profile section ──────────────────────────────────────────
//
// display_name editor (falls back to Google name when blank), read-
// only email, and the dark/light theme picker. PATCH /api/profile
// is the canonical endpoint already powering averrow-ops's profile
// page; the tenant just calls it with the same body shape.

function ProfileSection() {
  const { user } = useAuth();
  const { theme, setTheme } = useTheme();
  const [displayName, setDisplayName] = useState(user?.display_name ?? '');
  const [savingName, setSavingName] = useState(false);
  const [savedNameAt, setSavedNameAt] = useState<number | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  const initials = (() => {
    const src = (user?.display_name ?? user?.name ?? user?.email ?? '?').trim();
    const parts = src.split(/\s+/);
    if (parts.length === 1) return parts[0]?.[0]?.toUpperCase() ?? '?';
    return `${parts[0]?.[0] ?? ''}${parts[parts.length - 1]?.[0] ?? ''}`.toUpperCase();
  })();

  const saveDisplayName = async () => {
    setSavingName(true);
    setNameError(null);
    try {
      const trimmed = displayName.trim();
      await apiPatch('/api/profile', { display_name: trimmed.length === 0 ? null : trimmed });
      setSavedNameAt(Date.now());
    } catch (err) {
      setNameError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSavingName(false);
    }
  };

  const saveTheme = async (next: 'dark' | 'light') => {
    setTheme(next);
    try { await apiPatch('/api/profile', { theme_preference: next }); } catch { /* persisted locally; ignore network blip */ }
  };

  return (
    <section className="rounded-xl border border-white/[0.06] bg-bg-card p-5 space-y-4">
      <h2 className="text-sm font-semibold text-white/90">Profile</h2>

      <div className="flex items-center gap-3">
        <div
          className="w-12 h-12 rounded-full flex items-center justify-center text-[15px] font-bold"
          style={{ background: 'var(--amber)', color: 'var(--text-on-amber, #0A0F1E)' }}
        >
          {initials}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white/95 truncate">
            {user?.display_name ?? user?.name ?? 'Unnamed'}
          </div>
          <div className="text-[11px] font-mono text-white/45 truncate">{user?.email}</div>
          {user?.organization && (
            <div className="text-[10px] font-mono uppercase tracking-[0.16em] text-amber/85 mt-0.5">
              {user.organization.role} · {user.organization.plan}
            </div>
          )}
        </div>
      </div>

      <div>
        <label htmlFor="display-name" className="block text-[10px] uppercase tracking-[0.18em] font-mono text-white/45 mb-1">
          Display name
        </label>
        <div className="flex items-center gap-2">
          <input
            id="display-name"
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Leave blank to use your Google name"
            className="flex-1 bg-bg-input border border-white/[0.08] rounded-md px-3 py-2 text-sm text-white/90 focus:outline-none focus:border-amber/60"
            style={{ background: 'var(--bg-input)' }}
            disabled={savingName}
            maxLength={120}
          />
          <button
            type="button"
            onClick={saveDisplayName}
            disabled={savingName}
            className="px-3 py-2 rounded-md text-[11px] font-mono uppercase tracking-[0.10em] font-bold bg-amber text-black hover:bg-amber/90 disabled:opacity-60"
            style={{ background: 'var(--amber)', color: 'var(--text-on-amber, #0A0F1E)' }}
          >
            {savingName ? 'Saving…' : 'Save'}
          </button>
        </div>
        {nameError && <p className="mt-1 text-[11px] text-accent font-mono">{nameError}</p>}
        {savedNameAt && !nameError && (
          <p className="mt-1 text-[11px] text-green font-mono">Saved.</p>
        )}
        <p className="mt-1 text-[11px] text-white/40">
          Shown across the app instead of your Google name. Leave blank to use Google.
        </p>
      </div>

      <div>
        <label className="block text-[10px] uppercase tracking-[0.18em] font-mono text-white/45 mb-1">
          Theme
        </label>
        <div className="inline-flex rounded-md border border-white/[0.08] overflow-hidden">
          {(['dark', 'light'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => void saveTheme(value)}
              className={`px-4 py-1.5 text-[11px] font-mono uppercase tracking-[0.10em] transition-colors ${
                theme === value
                  ? 'bg-amber text-black'
                  : 'bg-transparent text-white/55 hover:text-white/85'
              }`}
              style={theme === value ? { background: 'var(--amber)', color: 'var(--text-on-amber, #0A0F1E)' } : undefined}
            >
              {value}
            </button>
          ))}
        </div>
      </div>
    </section>
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
