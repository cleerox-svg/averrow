// /settings/* — the account area shell for averrow-ops (ACCOUNT_DESIGN_SPEC §2).
//
// Mounts the shared <SettingsShell> (desktop rail + pane, mobile list -> detail)
// with react-router links, and provides the two things every settings page needs:
//   · a shared ToastProvider for the subtree (ops' own Toast context is a
//     different, simpler provider; the shared kit's toasts need theirs), and
//   · a dirty-form guard: pages call `useSettingsDirtyGuard()` and report
//     unsaved edits; navigating away through the settings rail / back link, or
//     closing the tab, then asks first.
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
const SettingsDirtyContext = createContext<ReportDirty>(() => undefined);

/** Settings pages report unsaved edits here; the layout guards navigation while dirty. Stable identity. */
export function useSettingsDirtyGuard(): ReportDirty {
  return useContext(SettingsDirtyContext);
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
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const reportDirty = useCallback<ReportDirty>((dirty) => { dirtyRef.current = dirty; }, []);

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
          setPendingHref(p.href);
          return;
        }
        p.onClick?.(e);
      }}
    >
      {p.children}
    </Link>
  ), []);

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
      <SettingsDirtyContext.Provider value={reportDirty}>
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
          open={pendingHref !== null}
          onOpenChange={(o) => { if (!o) setPendingHref(null); }}
          title="Discard changes?"
          description="You have unsaved changes on this page."
          consequence="If you leave now, your edits won't be saved."
          confirmLabel="Discard changes"
          onConfirm={() => {
            const href = pendingHref;
            dirtyRef.current = false;
            setPendingHref(null);
            if (href) navigate(href);
          }}
        />
      </SettingsDirtyContext.Provider>
    </ToastProvider>
  );
}
