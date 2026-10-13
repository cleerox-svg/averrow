import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { useTheme } from '@/lib/useTheme';
import { useAuth } from '@/lib/auth';

export function Shell() {
  // Mounting useTheme here applies the persisted theme on app boot
  // and keeps it synced with localStorage on toggle.
  useTheme();
  const { user, loading } = useAuth();
  const [navOpen, setNavOpen] = useState(false);

  // Logged-out guard. Without this the SPA renders the shell with
  // no user data — empty TopBar avatar, sidebar with no modules.
  // Hard-navigate to '/' so the parent worker's session-aware
  // login redirect runs (lands on /v2/login per the FarmTrack-aligned
  // SHARED_LOGIN_SPEC).
  useEffect(() => {
    if (!loading && !user) {
      window.location.href = '/';
    }
  }, [loading, user]);

  if (loading || !user) {
    return (
      <div className="h-full flex items-center justify-center bg-bg-page">
        <div className="text-[12px] font-mono uppercase tracking-[0.18em] text-white/55">
          {loading ? 'Loading…' : 'Redirecting to sign in…'}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex bg-bg-page">
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
      {navOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden="true"
        />
      )}
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar navOpen={navOpen} onToggleNav={() => setNavOpen((v) => !v)} />
        <main className="flex-1 min-w-0 overflow-y-auto px-4 py-5 md:px-6 md:py-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
