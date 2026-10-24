import { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
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
  const { pathname } = useLocation();
  const hamburgerRef = useRef<HTMLButtonElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);

  // Drawer (below md): close on route change, Escape, and when the viewport
  // widens to the static-sidebar breakpoint. Mirrors ops ShellV4.
  useEffect(() => { setNavOpen(false); }, [pathname]);
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);
  useEffect(() => {
    if (!navOpen || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(min-width: 768px)');
    const onChange = (e: MediaQueryListEvent) => { if (e.matches) setNavOpen(false); };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [navOpen]);

  // Modal behaviour while open: page content (TopBar + main) is inert and
  // body scroll is locked; both are restored on close/unmount.
  useEffect(() => {
    const content = contentRef.current;
    if (!navOpen || !content) return;
    content.inert = true;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      content.inert = false;
      document.body.style.overflow = prevOverflow;
    };
  }, [navOpen]);

  // Focus: into the drawer on open, back to the hamburger on every close path.
  // Declared after the inert effect so the hamburger is focusable again first.
  useEffect(() => {
    if (navOpen) closeBtnRef.current?.focus();
    else if (wasOpen.current) hamburgerRef.current?.focus();
    wasOpen.current = navOpen;
  }, [navOpen]);

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
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} closeRef={closeBtnRef} />
      {navOpen && (
        <div
          className="fixed inset-0 z-30 bg-[var(--scrim)] md:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden="true"
        />
      )}
      <div ref={contentRef} className="flex-1 flex flex-col min-w-0">
        <TopBar navOpen={navOpen} onOpenNav={() => setNavOpen(true)} hamburgerRef={hamburgerRef} />
        <main className="flex-1 min-w-0 overflow-y-auto px-4 py-5 md:px-6 md:py-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
