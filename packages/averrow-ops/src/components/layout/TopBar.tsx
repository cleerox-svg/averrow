import { NotificationBell } from '@/components/NotificationBell';
import { UserAvatar } from '@/components/UserAvatar';

export function TopBar() {
  return (
    <header
      className="flex items-center justify-between h-14 px-4 md:px-6 border-b backdrop-blur-md sticky top-0"
      style={{
        // Theme-aware: was bg-[#040912]/95 hardcoded which stayed
        // navy in light mode. Now reads from --bg-page so it flips.
        background:  'var(--bg-page)',
        borderColor: 'var(--border-base)',
        zIndex:      'var(--z-sidebar-overlay)',
      }}
    >
      <div className="flex items-center gap-3">
        <span className="text-xs font-mono font-bold tracking-[0.2em] text-white/40 uppercase">
          Threat Interceptor
        </span>
      </div>

      <div className="flex items-center gap-2">
        <NotificationBell />
        <UserAvatar />
      </div>
    </header>
  );
}
