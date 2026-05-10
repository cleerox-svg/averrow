// Brands-detail v2/v3 toggle. Mirrors ObservatoryVersionToggle but
// substitutes :brandId so the toggle on /brands/abc routes to
// /brands-v3/abc and back.

import { useNavigate } from 'react-router-dom';
import { useVersionToggle } from '@/design-system/hooks';
import type { Version } from '@/design-system/hooks';

const OPTIONS: { id: Version; label: string }[] = [
  { id: 'v2', label: 'V2' },
  { id: 'v3', label: 'V3' },
];

interface BrandsVersionToggleProps {
  brandId: string;
}

export function BrandsVersionToggle({ brandId }: BrandsVersionToggleProps) {
  const { version, setVersion } = useVersionToggle('brands');
  const navigate = useNavigate();

  function handleSelect(next: Version) {
    if (next === version) return;
    setVersion(next);
    const base = next === 'v3' ? '/brands-v3' : '/brands';
    navigate(`${base}/${brandId}`, { replace: true });
  }

  return (
    <div
      role="radiogroup"
      aria-label="Brand detail version"
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
