// /settings/* — the account area shell for averrow-ops (ACCOUNT_DESIGN_SPEC §2).
//
// Mounts the shared <SettingsShell> (desktop rail + pane, mobile list -> detail)
// with react-router links, and provides the two things every settings page needs:
//   · a shared ToastProvider for the subtree (ops' own Toast context is a
//     different, simpler provider; the shared kit's toasts need theirs), and
//   · a dirty-form guard: pages call `useSettingsDirtyGuard()` and report
//     unsaved edits; navigating away through the settings rail / back link, a
//     page's own tabs (via `useGuardedNavigate`), or closing the tab, asks first.
//     KNOWN GAP: the app has no data router (BrowserRouter), so `useBlocker` is
//     unavailable. Navigation outside this subtree — the main sidebar, the user
//     menu, the browser Back/Forward buttons — is NOT intercepted (only
//     beforeunload covers tab close/reload).
//
// Routes (see App.tsx): /settings (index), /settings/profile, /settings/devices,
// and security + notifications (wired by the orchestrator).

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type MouseEvent, type ReactNode,
} from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { accountSectionIdFromPath, getAccountSections, SignOutRow } from '@averrow/shared/account';
import {
  AccountHero, Button, ConfirmDialog, SettingsShell, ToastProvider, describeAccountScope, useMediaQuery,
  type SettingsRenderLink,
} from '@averrow/shared/ui';
import { useAuth } from '@/lib/auth';
import { BUILD_SHA, VERSION_LABEL } from '@/lib/version';

// ── dirty-form guard ────────────────────────────────────────

type ReportDirty = (dirty: boolean) => void;
/** Runs `go` now when the page is clean, else after the user confirms "Discard changes?". */
type RunGuarded = (go: () => void) => void;
interface DirtyGuardValue { reportDirty: ReportDirty; runGuarded: RunGuarded }
const SettingsDirtyContext = createContext<DirtyGuardValue>({
  reportDirty: () => undefined,
  runGuarded: (go) => go(),
});

/** Settings pages report unsaved edits here; the layout guards navigation while dirty. Stable identity. */
export function useSettingsDirtyGuard(): ReportDirty {
  return useContext(SettingsDirtyContext).reportDirty;
}

/** For in-page navigation (sub-tabs): wraps an action so a dirty form asks before it runs. */
export function useSettingsRunGuarded(): RunGuarded {
  return useContext(SettingsDirtyContext).runGuarded;
}

const DESKTOP_QUERY = '(min-width: 1024px)';

/** /settings on its own: desktop never shows a blank home, it lands on Profile; mobile shows the section list (rendered by the shell). */
export function SettingsIndex(): ReactNode {
  const desktop = useMediaQuery(DESKTOP_QUERY, true);
  return desktop ? <Navigate to="/settings/profile" replace /> : null;
}

function isPlainLeftClick(e: MouseEvent<HTMLElement>): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

export function SettingsLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const activeId = accountSectionIdFromPath(location.pathname);

  // ── unsaved-changes guard ──
  const dirtyRef = useRef(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const reportDirty = useCallback<ReportDirty>((dirty) => { dirtyRef.current = dirty; }, []);
  const runGuarded = useCallback<RunGuarded>((go) => {
    if (dirtyRef.current) setPendingAction(() => go);
    else go();
  }, []);
  const guardValue = useMemo<DirtyGuardValue>(() => ({ reportDirty, runGuarded }), [reportDirty, runGuarded]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  const renderLink = useCallback<SettingsRenderLink>((p) => (
    <Link
      to={p.href}
      className={p.className}
      aria-current={p['aria-current']}
      aria-disabled={p['aria-disabled']}
      tabIndex={p.tabIndex}
      onClick={(e) => {
        if (dirtyRef.current && isPlainLeftClick(e) && !e.defaultPrevented) {
          e.preventDefault();
          setPendingAction(() => () => navigate(p.href));
          return;
        }
        p.onClick?.(e);
      }}
    >
      {p.children}
    </Link>
  ), [navigate]);

  const passkeys = user?.passkey_count;
  const sections = useMemo(() => getAccountSections({
    descriptions: {
      security: typeof passkeys === 'number'
        ? (passkeys > 0 ? `${passkeys} ${passkeys === 1 ? 'passkey' : 'passkeys'} · Active sessions` : 'No passkey yet · Add one')
        : undefined,
    },
  }), [passkeys]);

  const signOut = () => { void logout(); };

  const home = user ? (
    <AccountHero
      compact
      name={user.display_name ?? user.name}
      email={user.email}
      role={user.role}
      passkey={typeof user.passkey_count === 'number' ? user.passkey_count > 0 : null}
      scope={describeAccountScope({ role: user.role, orgName: user.organization?.name, orgRole: user.organization?.role })}
    />
  ) : <AccountHero compact loading />;

  return (
    <ToastProvider>
      <SettingsDirtyContext.Provider value={guardValue}>
        <div className="min-[1024px]:px-6 min-[1024px]:py-4">
          <SettingsShell
            sections={sections}
            activeId={activeId}
            basePath="/settings"
            title="Settings"
            subtitle="Your profile, security and notifications."
            home={home}
            homeFooter={(
              <>
                <SignOutRow onSignOut={signOut} />
                <p className="m-0 text-center text-[12px] text-[var(--text-muted)] [font-family:var(--font-mono,ui-monospace,monospace)]">
                  {VERSION_LABEL} · {BUILD_SHA}
                </p>
              </>
            )}
            railFooter={(
              <Button type="button" variant="ghost" className="w-full justify-start px-3 hover:text-[var(--sev-critical-text)]" onClick={signOut}>
                Sign out
              </Button>
            )}
            renderLink={renderLink}
            onNavigate={(href) => navigate(href)}
          >
            <Outlet />
          </SettingsShell>
        </div>

        <ConfirmDialog
          open={pendingAction !== null}
          onOpenChange={(o) => { if (!o) setPendingAction(null); }}
          title="Discard changes?"
          description="You have unsaved changes on this page."
          consequence="If you leave now, your edits won't be saved."
          confirmLabel="Discard changes"
          onConfirm={() => {
            const go = pendingAction;
            dirtyRef.current = false;
            setPendingAction(null);
            go?.();
          }}
        />
      </SettingsDirtyContext.Provider>
    </ToastProvider>
  );
}
