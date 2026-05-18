// Averrow — MobileSidebarDrawer
// Slide-out left drawer for mobile vertical (portrait phones).
// Renders the real <Sidebar /> so nav stays consistent with desktop.
// Two width modes (expanded / rail) persisted to localStorage.
// Closes on backdrop tap, swipe-left, or NavLink click (auto-close on navigate).

import { useEffect, useRef, useState } from 'react';
import { Sidebar, type SidebarMode } from '@/components/layout/Sidebar';

const STORAGE_KEY = 'averrow:mobile-sidebar-mode';
const SWIPE_CLOSE_THRESHOLD = 60;

interface MobileSidebarDrawerProps {
  open: boolean;
  onClose: () => void;
}

function readStoredMode(): SidebarMode {
  if (typeof window === 'undefined') return 'expanded';
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === 'rail' ? 'rail' : 'expanded';
}

export function MobileSidebarDrawer({ open, onClose }: MobileSidebarDrawerProps) {
  const [mode, setMode] = useState<SidebarMode>(() => readStoredMode());
  const touchStartX = useRef<number | null>(null);
  const touchDeltaX = useRef<number>(0);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // localStorage unavailable — ignore, mode is still respected in-memory.
    }
  }, [mode]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  function toggleMode() {
    setMode(m => (m === 'expanded' ? 'rail' : 'expanded'));
  }

  function onTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0]?.clientX ?? null;
    touchDeltaX.current = 0;
  }

  function onTouchMove(e: React.TouchEvent) {
    if (touchStartX.current === null) return;
    const x = e.touches[0]?.clientX ?? touchStartX.current;
    touchDeltaX.current = x - touchStartX.current;
  }

  function onTouchEnd() {
    if (touchStartX.current !== null && touchDeltaX.current <= -SWIPE_CLOSE_THRESHOLD) {
      onClose();
    }
    touchStartX.current = null;
    touchDeltaX.current = 0;
  }

  return (
    <>
      <div
        onClick={onClose}
        aria-hidden={!open}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.55)',
          backdropFilter: 'blur(2px)',
          WebkitBackdropFilter: 'blur(2px)',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transition: 'opacity 0.18s ease',
          zIndex: 'var(--z-modal-backdrop, 90)' as unknown as number,
        }}
      />
      <div
        role="dialog"
        aria-label="Navigation"
        aria-hidden={!open}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          bottom: 0,
          transform: open ? 'translateX(0)' : 'translateX(-110%)',
          transition: 'transform 0.22s ease',
          zIndex: 'var(--z-modal, 100)' as unknown as number,
          boxShadow: '8px 0 32px rgba(0,0,0,0.45)',
        }}
      >
        <Sidebar mode={mode} onToggleMode={toggleMode} onNavigate={onClose} />
      </div>
    </>
  );
}
