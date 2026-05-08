import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, LogOut, UserCircle, Settings as SettingsIcon, UserPlus } from 'lucide-react';
import { useAuth } from '@/lib/auth';

// Tenant TopBar — header with org context + clickable user avatar.
//
// Avatar opens a dropdown with the user's identity, a Profile/Settings
// link, and a Logout button. Logout calls /api/auth/logout (revokes
// the refresh cookie + sessions row) before clearing local state and
// hard-navigating to '/'.
//
// Self-avatar is always SELF_AVATAR_COLOR (var(--amber)) per the
// SHARED_LOGIN_SPEC §3 rule. Initials only — never the Google
// profile picture.

export function TopBar() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const orgName  = user?.organization?.name ?? 'Your Organization';
  const initials = computeInitials(user?.display_name ?? user?.name ?? user?.email ?? null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const handleLogout = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await logout();
      // logout() already hard-navigates to '/'. Nothing else to do.
    } catch {
      setBusy(false);
    }
  };

  return (
    <header className="h-14 shrink-0 flex items-center justify-between px-6 border-b border-white/[0.05] bg-bg-page/80 backdrop-blur">
      <div>
        <div className="text-[10px] uppercase tracking-[0.18em] font-mono text-white/40">Organization</div>
        <div className="text-sm font-semibold text-white/90">{orgName}</div>
      </div>

      <div className="relative" ref={popoverRef}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 pl-1 pr-2 py-1 rounded-full hover:bg-white/[0.05] transition-colors"
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <span className="hidden md:inline text-[11px] font-mono text-white/55 max-w-[180px] truncate">
            {user?.email}
          </span>
          <span
            className="w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-bold"
            style={{
              background: 'var(--amber)',
              color: 'var(--text-on-amber, #0A0F1E)',
            }}
          >
            {initials || '?'}
          </span>
          <ChevronDown size={14} className="text-white/40" />
        </button>

        {open && (
          <div
            role="menu"
            className="absolute right-0 mt-2 w-64 rounded-xl border border-white/[0.08] bg-bg-card shadow-xl backdrop-blur z-30"
            style={{ background: 'var(--bg-card)' }}
          >
            <div className="px-3 py-3 border-b border-white/[0.06]">
              <div className="text-sm font-semibold text-white/95 truncate">
                {user?.display_name ?? user?.name ?? user?.email ?? 'Signed in'}
              </div>
              <div className="text-[11px] font-mono text-white/45 truncate mt-0.5">
                {user?.email}
              </div>
              {user?.organization && (
                <div className="text-[10px] font-mono uppercase tracking-[0.16em] text-amber/85 mt-1.5">
                  {user.organization.role} · {user.organization.plan}
                </div>
              )}
            </div>

            <div className="py-1">
              <Link
                to="/settings"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 px-3 py-2 text-[13px] text-white/85 hover:bg-white/[0.04]"
                role="menuitem"
              >
                <UserCircle size={15} />
                <span>Profile</span>
              </Link>
              <Link
                to="/settings/billing"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 px-3 py-2 text-[13px] text-white/85 hover:bg-white/[0.04]"
                role="menuitem"
              >
                <SettingsIcon size={15} />
                <span>Billing</span>
              </Link>
            </div>

            <div className="py-1 border-t border-white/[0.06]">
              <button
                type="button"
                onClick={handleLogout}
                disabled={busy}
                className="w-full flex items-center gap-2 px-3 py-2 text-[13px] text-white/85 hover:bg-white/[0.04] disabled:opacity-60"
                role="menuitem"
                title="Sign out then sign in as a different user"
              >
                <UserPlus size={15} />
                <span>Switch account</span>
              </button>
              <button
                type="button"
                onClick={handleLogout}
                disabled={busy}
                className="w-full flex items-center gap-2 px-3 py-2 text-[13px] text-accent hover:bg-accent/[0.08] disabled:opacity-60"
                role="menuitem"
              >
                <LogOut size={15} />
                <span>{busy ? 'Signing out…' : 'Log out'}</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}

function computeInitials(input: string | null): string {
  if (!input) return '';
  const parts = input.trim().split(/\s+/);
  if (parts.length === 0) return '';
  if (parts.length === 1) {
    // Email or single-word display name → first char.
    const first = parts[0]?.[0]?.toUpperCase() ?? '';
    return first;
  }
  // First + last word, drops middles (matches parseInitials in
  // averrow-ops/src/lib/avatar.ts).
  const first = parts[0]?.[0]?.toUpperCase() ?? '';
  const last  = parts[parts.length - 1]?.[0]?.toUpperCase() ?? '';
  return `${first}${last}`;
}
