// Everything else, as one row of links. A chip only shows a count when one is
// already in the React Query cache; the digest makes no requests of its own.

import { Link } from 'react-router-dom';
import { skipToken, useQuery } from '@tanstack/react-query';
import { Card } from '@/design-system/components';
import { BRAND_MOVERS_QUERY_KEY, type BrandMoversData } from '@/hooks/useBrandMovers';
import { tabUrl } from '@/lib/workspaceRoutes';

interface DigestLink {
  key: string;
  label: string;
  to: string;
  count?: number;
}

export function Digest() {
  // skipToken: subscribe to the cache entry (Brands populates it) without ever fetching.
  const movers = useQuery<BrandMoversData>({ queryKey: BRAND_MOVERS_QUERY_KEY, queryFn: skipToken });
  const rising = movers.data?.rising.length;

  // Only destinations that actually show what the chip names.
  const links: DigestLink[] = [
    { key: 'brands', label: 'Brand movers', to: tabUrl('brands'), count: rising },
    { key: 'briefings', label: 'All briefings', to: tabUrl('trends') },
    { key: 'threats', label: 'Threats', to: tabUrl('threats') },
    { key: 'observatory', label: 'Observatory', to: '/observatory' },
  ];

  return (
    <Card padding="md" role="region" aria-labelledby="home-digest-title">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2
          id="home-digest-title"
          className="font-mono text-[10px] font-bold uppercase tracking-[0.18em]"
          style={{ color: 'var(--text-secondary)', margin: 0 }}
        >
          Everything else
        </h2>
        <span className="font-mono text-[10px]" style={{ color: 'var(--text-secondary)' }}>no action needed</span>
      </div>
      <nav aria-labelledby="home-digest-title" className="flex flex-wrap gap-2">
        {links.map((l) => (
          <Link
            key={l.key}
            to={l.to}
            className="rounded-full px-3 py-1.5 font-mono text-[11px] no-underline hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--amber-text)]"
            style={{ background: 'var(--border-base)', color: 'var(--text-primary)', border: '1px solid var(--border-strong)' }}
          >
            {l.label}
            {l.count !== undefined && <span style={{ color: 'var(--text-secondary)' }}> ↑ {l.count}</span>}
          </Link>
        ))}
      </nav>
    </Card>
  );
}
