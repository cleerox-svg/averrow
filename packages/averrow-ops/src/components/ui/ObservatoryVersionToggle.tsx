// Segmented v2 / v3 toggle for the Observatory page header.
// Stays narrow to fit alongside the period/mode controls — used by
// both /observatory and /observatory-v3 so users can hop between
// the engines without going through the sidebar.

import { useNavigate } from 'react-router-dom';
import {
  useObservatoryVersion,
  pathForObservatoryVersion,
} from '@/design-system/hooks';
import type { ObservatoryVersion } from '@/design-system/hooks';

const OPTIONS: { id: ObservatoryVersion; label: string }[] = [
  { id: 'v2', label: 'V2' },
  { id: 'v3', label: 'V3' },
];

export function ObservatoryVersionToggle() {
  const { version, setVersion } = useObservatoryVersion();
  const navigate = useNavigate();

  function handleSelect(next: ObservatoryVersion) {
    if (next === version) return;
    setVersion(next);
    navigate(pathForObservatoryVersion(next), { replace: true });
  }

  return (
    <div
      role="radiogroup"
      aria-label="Observatory engine"
      className="inline-flex rounded-md overflow-hidden"
      style={{
        border: '1px solid rgba(255,255,255,0.10)',
        background: 'rgba(0,0,0,0.30)',
      }}
    >
      {OPTIONS.map((opt) => {
        const active = opt.id === version;
        return (
          <button
            key={opt.id}
            role="radio"
            aria-checked={active}
            onClick={() => handleSelect(opt.id)}
            className="px-2.5 py-1 font-mono text-[10px] tracking-[0.18em] uppercase transition-colors"
            style={{
              background: active ? 'var(--amber)' : 'transparent',
              color: active ? '#0A0F1C' : 'var(--text-secondary)',
              fontWeight: active ? 600 : 500,
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
