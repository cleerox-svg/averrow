// Overview tile: quiet by design. Renders nothing while loading, on error, or
// when the endpoint is not deployed yet (404 -> query error).
import { Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { Card } from '@/design-system/components';
import { HOME_CARD_VARIANT } from '@/features/home/homeCard';
import { useIdentityThreats } from './useIdentityThreats';

export function IdentityThreatsTile() {
  const { data } = useIdentityThreats('7d');
  const n = data?.kpis?.detections;
  if (typeof n !== 'number') return null;

  return (
    <section className="home-section" aria-label="Identity Provider Impersonation">
      <Card variant={HOME_CARD_VARIANT} padding="none">
        <Link
          to="/identity-threats"
          className="identity-tile-link"
        >
          <span className="flex items-center gap-2 text-type-body">
            <ShieldCheck size={16} aria-hidden style={{ color: 'var(--primary-text)' }} />
            Identity Provider Impersonation — <strong>{n.toLocaleString('en-US')} {n === 1 ? 'detection' : 'detections'}</strong> (7d)
          </span>
          <span className="text-type-small" style={{ color: 'var(--text-secondary)' }}>View →</span>
        </Link>
      </Card>
    </section>
  );
}
