import { NotificationBell } from '@/components/NotificationBell';
import { UserAvatar } from '@/components/UserAvatar';

export function TopBar() {
  return (
    <header className="flex items-center justify-between h-14 px-4 md:px-6 border-b border-white/8 bg-[#040912]/95 backdrop-blur-md sticky top-0" style={{ zIndex: 'var(--z-sidebar-overlay)' }}>
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
