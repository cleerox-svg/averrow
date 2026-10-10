// Overview tile: quiet by design. Renders nothing while loading, on error, or
// when the endpoint is not deployed yet (404 -> query error).
import { Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { Card } from '@/design-system/components';
import { useIdentityThreats } from './useIdentityThreats';

export function IdentityThreatsTile() {
  const { data } = useIdentityThreats('7d');
  const n = data?.kpis?.detections;
  if (typeof n !== 'number') return null;

  return (
    <section className="home-section" aria-label="Identity provider impersonation">
    <Card padding="md">
      <Link
        to="/identity-threats"
        className="flex items-center justify-between gap-3 no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--amber-text)]"
        style={{ color: 'var(--text-primary)' }}
      >
        <span className="flex items-center gap-2 text-sm">
          <ShieldCheck size={16} aria-hidden style={{ color: 'var(--amber-text)' }} />
          Identity provider impersonation — <strong>{n.toLocaleString('en-US')} {n === 1 ? 'detection' : 'detections'}</strong> (7d)
        </span>
        <span className="font-mono text-[11px]" style={{ color: 'var(--text-secondary)' }}>View →</span>
      </Link>
    </Card>
    </section>
  );
}
