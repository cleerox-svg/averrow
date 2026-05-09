// Generic V2 / V3 segmented toggle.
// Drop one onto a page header to A/B between the legacy and v3
// surface — the user's choice persists in localStorage and routes
// the next click to the matching path.

import { useNavigate } from 'react-router-dom';
import {
  useVersionToggle,
  pathForVersion,
} from '@/design-system/hooks';
import type { Surface, Version } from '@/design-system/hooks';

const OPTIONS: { id: Version; label: string }[] = [
  { id: 'v2', label: 'V2' },
  { id: 'v3', label: 'V3' },
];

interface VersionToggleProps {
  surface:    Surface;
  ariaLabel?: string;
}

export function VersionToggle({ surface, ariaLabel }: VersionToggleProps) {
  const { version, setVersion } = useVersionToggle(surface);
  const navigate = useNavigate();

  function handleSelect(next: Version) {
    if (next === version) return;
    setVersion(next);
    navigate(pathForVersion(surface, next), { replace: true });
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel ?? `${surface} version`}
      className="inline-flex rounded-md overflow-hidden"
      style={{
        border:     '1px solid var(--border-base)',
        background: 'var(--bg-input)',
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
              color:      active ? '#0A0F1C' : 'var(--text-secondary)',
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
