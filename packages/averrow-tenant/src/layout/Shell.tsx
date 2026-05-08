import { useEffect } from 'react';
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
        <div className="text-[12px] font-mono uppercase tracking-[0.18em] text-white/40">
          {loading ? 'Loading…' : 'Redirecting to sign in…'}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex bg-bg-page">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar />
        <main className="flex-1 overflow-y-auto px-6 py-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
