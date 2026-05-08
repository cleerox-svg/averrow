import { useEffect, useRef } from 'react';

interface DropdownProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
  className?: string;
}

export function Dropdown({ open, onClose, children, width = 380, className = '' }: DropdownProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent | KeyboardEvent) {
      if (e instanceof KeyboardEvent && e.key === 'Escape') {
        onClose();
      } else if (
        e instanceof MouseEvent &&
        ref.current &&
        !ref.current.contains(e.target as Node)
      ) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handle);
    document.addEventListener('keydown', handle);
    return () => {
      document.removeEventListener('mousedown', handle);
      document.removeEventListener('keydown', handle);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      className={`absolute top-full right-0 mt-2 rounded-xl overflow-hidden animate-fade-in ${className}`}
      style={{
        width,
        zIndex: 'var(--z-dropdown)',
        // Was rgba(15,23,42,0.50) + backdrop-filter blur — but
        // backdrop-filter renders inconsistently and 50% opacity
        // let the content underneath bleed through (operator
        // screenshot 2026-04-30: agents grid visible through bell
        // dropdown). Solid card background fixes it everywhere.
        background: 'var(--bg-card)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: '1px solid rgba(255,255,255,0.07)',
        borderRadius: '0.75rem',
        boxShadow: '0 4px 24px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.05)',
      }}
    >
      {children}
    </div>
  );
}
