import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar }        from './Sidebar';
import { TopBar }         from './TopBar';
import { MobileNav }      from '@/layouts/MobileNav';
import { DeepBackground } from '@/components/ui/DeepBackground';
import { PageTransition } from '@/components/ui/PageTransition';
import { useBreakpoint }  from '@/design-system/hooks';
import { FirstSignInPasskeyPrompt } from '@/components/FirstSignInPasskeyPrompt';
import { PlatformAlertBanner } from '@/components/PlatformAlertBanner';

export function Shell() {
  const location     = useLocation();
  const { isMobile } = useBreakpoint();
  const isFullScreen = location.pathname.includes('/observatory');
  const isHome       = location.pathname === '/';
  // Home renders its own header with bell + profile pill (HomeUnified),
  // so the global TopBar would just duplicate those affordances. Hide
  // it on Home for everyone, mobile or not.
  const hideTopBar   = isHome;

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
        {!hideTopBar && <TopBar />}

        <main
          style={{
            flex:       1,
            overflowY:  isFullScreen ? 'hidden' : 'auto',
            overflowX:  'hidden',
            paddingBottom: isMobile && !isFullScreen ? 80 : 0,
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
              <Outlet />
            </PageTransition>
          </div>
        </main>
      </div>

      {isMobile && <MobileNav />}

      {/* Auto-prompts biometric setup on first login when the user has
          zero passkeys + WebAuthn is supported. Self-gates internally
          (localStorage flag + passkey_count check) so it can sit at
          the Shell root without any per-route logic. */}
      <FirstSignInPasskeyPrompt />
    </div>
  );
}
