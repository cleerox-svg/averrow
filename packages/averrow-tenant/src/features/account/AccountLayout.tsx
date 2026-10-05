// /account/* — the account area shell for averrow-tenant (ACCOUNT_DESIGN_SPEC §2).
//
// Same shape as the ops SettingsLayout, mounted at /account (NOT /settings: the
// tenant's /settings/* is the organisation area). Differences from ops:
//   · Devices & App is omitted — the tenant app has no service worker yet
//     (CLAUDE.md §5, improvement-plan S12), so there is no install or push device
//     to manage. Re-add it when the tenant SW lands.
//   · The navigation guard has the same KNOWN GAP as ops (BrowserRouter, no
//     useBlocker): only the rail/back link, a page's own tabs and tab close are guarded.

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type MouseEvent, type ReactNode,
} from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { accountSectionIdFromPath, getAccountSections, SignOutRow, type AccountSectionId } from '@averrow/shared/account';
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
export function useAccountDirtyGuard(): ReportDirty {
  return useContext(SettingsDirtyContext).reportDirty;
}

/** For in-page navigation (sub-tabs): wraps an action so a dirty form asks before it runs. */
export function useAccountRunGuarded(): RunGuarded {
  return useContext(SettingsDirtyContext).runGuarded;
}

const DESKTOP_QUERY = '(min-width: 1024px)';

export const ACCOUNT_BASE_PATH = '/account';

/** Sections the tenant app offers. Devices & App needs a service worker (see header). */
export const TENANT_ACCOUNT_SECTIONS: readonly AccountSectionId[] = ['profile', 'security', 'notifications'];

/** /account on its own: desktop never shows a blank home, it lands on Profile; mobile shows the section list (rendered by the shell). */
export function AccountIndex(): ReactNode {
  const desktop = useMediaQuery(DESKTOP_QUERY, true);
  return desktop ? <Navigate to="/account/profile" replace /> : null;
}

function isPlainLeftClick(e: MouseEvent<HTMLElement>): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

export function AccountLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const activeId = accountSectionIdFromPath(location.pathname, ACCOUNT_BASE_PATH);

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
    basePath: ACCOUNT_BASE_PATH,
    descriptions: {
      security: typeof passkeys === 'number'
        ? (passkeys > 0 ? `${passkeys} ${passkeys === 1 ? 'passkey' : 'passkeys'} · Active sessions` : 'No passkey yet · Add one')
        : undefined,
    },
  }).filter((sec) => (TENANT_ACCOUNT_SECTIONS as readonly string[]).includes(sec.id)), [passkeys]);

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
            basePath={ACCOUNT_BASE_PATH}
            title="Account"
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
