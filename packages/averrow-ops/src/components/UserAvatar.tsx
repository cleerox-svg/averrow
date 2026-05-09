import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { User, Bell, Building2, Key, LogOut, UserPlus } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useIsMobile } from '@/hooks/useWindowWidth';
import { parseInitials, SELF_AVATAR_COLOR } from '@/lib/avatar';
import { Dropdown } from './Dropdown';
import { BottomSheet } from './BottomSheet';

interface MenuItem {
  label: string;
  icon: typeof User;
  path?: string;
  onClick?: () => void;
  danger?: boolean;
}

function ProfileMenu({ onClose }: { onClose: () => void }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const initials = parseInitials(user?.name, user?.email);

  const roleName = user?.role === 'super_admin' ? 'Super Admin'
    : user?.role === 'admin' ? 'Admin'
    : user?.role === 'analyst' ? 'Analyst'
    : 'Client';

  // Theme toggle lives in the sidebar header now (canonical
  // quick-access surface) + Profile → Preferences (canonical
  // explicit picker with Auto / Dark / Light). Removed from this
  // dropdown to keep one toggle per product, no duplication.
  const menuItems: MenuItem[] = [
    { label: 'Profile & Settings', icon: User, path: '/profile' },
    { label: 'Notification Preferences', icon: Bell, path: '/notifications/preferences' },
    { label: 'Organization', icon: Building2, path: '/admin' },
    { label: 'API Keys', icon: Key, path: '/admin' },
  ];

  const handleNav = (path: string) => {
    navigate(path);
    onClose();
  };

  return (
    <div>
      <div className="px-4 pt-4 pb-3 flex items-center gap-3 border-b border-white/5">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0"
          style={{
            background: SELF_AVATAR_COLOR,
            color: 'var(--text-on-amber, #0A0F1E)',
            border: '1px solid var(--border-strong)',
          }}
        >
          {initials}
        </div>
        <div className="min-w-0">
          <p className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>
            {user?.name ?? 'User'}
          </p>
          <p className="text-[11px] text-white/40 truncate">
            {user?.email}
          </p>
          <p className="text-[10px] font-mono uppercase tracking-wider mt-0.5" style={{ color: 'var(--text-secondary)' }}>
            {roleName}
          </p>
        </div>
      </div>

      <div className="py-1">
        {menuItems.map(item => (
          <button
            key={item.label}
            onClick={() => {
              if (item.onClick) item.onClick();
              else if (item.path) handleNav(item.path);
            }}
            className="w-full flex items-center gap-3 px-4 py-2.5 md:py-2.5 min-h-[52px] md:min-h-0 text-left hover:bg-white/5 transition-colors touch-target border-b border-white/[0.04] md:border-b-0"
          >
            <item.icon size={15} className="text-white/40 flex-shrink-0" />
            <span className="text-[14px] md:text-[12px]" style={{ color: 'var(--text-primary)' }}>{item.label}</span>
          </button>
        ))}
      </div>

      <div className="border-t border-white/5 py-1">
        <button
          onClick={() => { void logout(); onClose(); }}
          className="w-full flex items-center gap-3 px-4 py-2.5 md:py-2.5 min-h-[52px] md:min-h-0 text-left hover:bg-white/5 transition-colors touch-target"
          title="Sign out then sign in as a different user"
        >
          <UserPlus size={15} className="text-white/40 flex-shrink-0" />
          <span className="text-[14px] md:text-[12px]" style={{ color: 'var(--text-primary)' }}>Switch account</span>
        </button>
        <button
          onClick={() => { void logout(); onClose(); }}
          className="w-full flex items-center gap-3 px-4 py-2.5 md:py-2.5 min-h-[52px] md:min-h-0 text-left hover:bg-[#C83C3C]/10 transition-colors touch-target"
        >
          <LogOut size={15} className="text-[#C83C3C]/70 flex-shrink-0" />
          <span className="text-[14px] md:text-[12px] text-[#C83C3C]/80">Logout</span>
        </button>
      </div>
    </div>
  );
}

export function UserAvatar() {
  const [open, setOpen] = useState(false);
  const { user } = useAuth();
  const isMobile = useIsMobile();

  const initials = parseInitials(user?.name, user?.email);

  const handleClose = useCallback(() => setOpen(false), []);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all duration-150 touch-target"
        style={{
          background: SELF_AVATAR_COLOR,
          color: 'var(--text-on-amber, #0A0F1E)',
          border: '1px solid var(--border-strong)',
        }}
        aria-label="User menu"
      >
        {initials}
      </button>

      {isMobile ? (
        <BottomSheet open={open} onClose={handleClose}>
          <ProfileMenu onClose={handleClose} />
        </BottomSheet>
      ) : (
        <Dropdown open={open} onClose={handleClose} width={260}>
          <ProfileMenu onClose={handleClose} />
        </Dropdown>
      )}
    </div>
  );
}
