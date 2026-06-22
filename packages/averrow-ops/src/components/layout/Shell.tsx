import { useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar }        from './Sidebar';
import { TopBar }         from './TopBar';
import { MobileNav }      from '@/layouts/MobileNav';
import { MobileSidebarDrawer } from '@/layouts/MobileSidebarDrawer';
import { DeepBackground } from '@/components/ui/DeepBackground';
import { PageTransition } from '@/components/ui/PageTransition';
import { useBreakpoint }  from '@/design-system/hooks';
import { useAuth }        from '@/lib/auth';
import { FirstSignInPasskeyPrompt } from '@/components/FirstSignInPasskeyPrompt';
import { PasskeyEnrollmentGate } from '@/components/PasskeyEnrollmentGate';
import { PlatformAlertBanner } from '@/components/PlatformAlertBanner';

export function Shell() {
  const location     = useLocation();
  const { user }     = useAuth();
  const { isMobile, isMobileVertical, isMobileHorizontal } = useBreakpoint();
  const isFullScreen = location.pathname.includes('/observatory');
  const isHome       = location.pathname === '/';
  // H-3: a privileged user on an enrollment-scoped session (signed in
  // without a passkey) must NOT mount the protected app surface. The routed
  // view would fetch protected endpoints, get `passkey_enrollment_required`
  // 403s, and crash its per-route ErrorBoundary — invisibly, underneath the
  // blocking gate, until the gate hydrates the full session in place and
  // reveals the dead view. Render nothing in the Outlet while locked;
  // PasskeyEnrollmentGate overlays the screen. Once the passkey upgrade flips
  // `passkey_required` false, the Outlet mounts FRESH with the full session
  // and fetches cleanly — no reload needed.
  const enrollmentLocked = !!user?.passkey_required;
  // Home renders its own header with bell + profile pill (HomeUnified),
  // so the global TopBar would just duplicate those affordances on
  // desktop and landscape phones. Mobile vertical is the exception —
  // the hamburger lives in TopBar, so Home needs it visible too.
  const hideTopBar   = isHome && !isMobileVertical;
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div
      className="flex"
      style={{
        height:   '100dvh',   // dvh = dynamic viewport height (handles mobile browser chrome)
        overflow: 'hidden',   // contain the layout
        background: 'var(--bg-page)',
        position: 'relative',
      }}
    >
      <DeepBackground />

      {!isMobile && <Sidebar />}

      <div style={{ display:'flex', flexDirection:'column', flex:1, overflow:'hidden', minWidth:0 }}>
        {!hideTopBar && (
          <TopBar onMenuClick={isMobileVertical ? () => setDrawerOpen(true) : undefined} />
        )}

        <main
          style={{
            flex:       1,
            overflowY:  isFullScreen ? 'hidden' : 'auto',
            overflowX:  'hidden',
            // Mobile vertical no longer has a bottom nav — drop the 80px
            // reservation. Mobile horizontal still uses the bottom tabs.
            paddingBottom: isMobileHorizontal && !isFullScreen ? 80 : 0,
            // Enable momentum scrolling on iOS
            WebkitOverflowScrolling: 'touch',
          }}
        >
          <div style={{
            padding: isFullScreen
              ? undefined
              // Home page on mobile renders its own full-bleed sections;
              // every other route gets a baseline horizontal pad so page
              // headings (e.g. Brands' h1) don't clip at 375px.
              : (isHome && isMobile)
                ? undefined
                : isMobile
                  ? '12px 16px'
                  : '16px 24px',
          }}>
            {/* Self-gates to /, /agents, /feeds and only renders when
                an unread platform_* notification exists that hasn't
                been dismissed on this device. */}
            <div style={{ padding: isMobile && (location.pathname === '/' || location.pathname === '/agents' || location.pathname === '/feeds') ? '8px 16px 0' : 0 }}>
              <PlatformAlertBanner />
            </div>
            <PageTransition>
              {enrollmentLocked ? null : <Outlet />}
            </PageTransition>
          </div>
        </main>
      </div>

      {isMobileHorizontal && <MobileNav />}
      {isMobileVertical && (
        <MobileSidebarDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      )}

      {/* Auto-prompts biometric setup on first login when the user has
          zero passkeys + WebAuthn is supported. Self-gates internally
          (localStorage flag + passkey_count check) so it can sit at
          the Shell root without any per-route logic. */}
      <FirstSignInPasskeyPrompt />
      {/* H-3: blocking gate for privileged users who signed in without a
          passkey. Self-gates on user.passkey_required, so it sits at the
          Shell root with no per-route logic. */}
      <PasskeyEnrollmentGate />
    </div>
  );
}
