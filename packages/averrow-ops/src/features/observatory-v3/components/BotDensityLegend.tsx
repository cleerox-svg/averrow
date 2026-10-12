import { useEffect, useState } from 'react';
import { useTheme } from '@/design-system/hooks';
import { Link } from 'react-router-dom';
import { Card } from '@/design-system/components';
import { tabUrl } from '@/lib/workspaceRoutes';
import { resolveScaleStops, formatPct, type BotDensityDomain } from '../lib/bot-density';

interface BotDensityLegendProps {
  domain: BotDensityDomain;
  globalAvg: number | null;
  asOf: string | null;
  countries: number;
  /** Absolute positioning (the parent owns the layout). */
  style?: React.CSSProperties;
}

/** Compact legend: colour scale, size meaning, source/date and global average. */
export function BotDensityLegend({ domain, globalAvg, asOf, countries, style }: BotDensityLegendProps) {
  const { resolvedTheme } = useTheme();
  const [stops, setStops] = useState(resolveScaleStops);
  useEffect(() => { setStops(resolveScaleStops()); }, [resolvedTheme]);
  const css = (c: number[]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
  const gradient = `linear-gradient(90deg, ${css(stops[0])}, ${css(stops[1])}, ${css(stops[2])})`;

  const label = 'font-mono text-[10px] uppercase tracking-wider';

  return (
    <Card variant="base" padding="10px 12px" role="group" aria-label="Bot density legend" style={{ position: 'absolute', width: 232, ...style }}>
      <div className={label} style={{ color: 'var(--text-tertiary)' }}>
        Bot share of each country&apos;s traffic
      </div>
      <div
        role="img"
        aria-label={`Colour scale from ${formatPct(domain.minBot)} to ${formatPct(domain.maxBot)} bot share`}
        style={{ height: 8, borderRadius: 4, marginTop: 6, background: gradient }}
      />
      <div className="flex justify-between font-mono text-[10px] mt-1" style={{ color: 'var(--text-secondary)' }}>
        <span>{formatPct(domain.minBot)}</span>
        <span>{formatPct(domain.maxBot)}</span>
      </div>

      <div className="mt-2 font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
        Colour, circle size and ring each encode data:
      </div>
      <div className="flex items-center gap-2 mt-1 font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
        <span aria-hidden style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--text-muted)' }} />
          <span style={{ width: 12, height: 12, borderRadius: '50%', background: 'var(--text-muted)' }} />
        </span>
        <span>Size = share of global traffic</span>
      </div>
      <div className="flex items-center gap-2 mt-1 font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
        {/* Dark chip: the map basemap is always dark, so the white ring must sit on dark in both themes. */}
        <span
          aria-hidden
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: 4, background: '#0b1220' }}
        >
          <span style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid rgb(255, 255, 255)', boxSizing: 'border-box' }} />
        </span>
        <span>
          Ring = above global avg
          {globalAvg != null && <> ({formatPct(globalAvg)})</>}
        </span>
      </div>

      <div
        className="mt-2 pt-2 font-mono text-[10px]"
        style={{ borderTop: '1px solid var(--border-base)', color: 'var(--text-tertiary)' }}
      >
        Source: Cloudflare Radar{asOf ? <> &middot; as of {asOf}</> : null} &middot; {countries} countries
        <div className="mt-1">
          &ge; / &le; = estimate bound; country outside one of Radar&apos;s top-100 lists.
        </div>
        <div className="mt-1">
          <Link to={tabUrl('bot-traffic')} className="underline" style={{ color: 'var(--amber-text)' }}>
            View as table (Bot Traffic tab)
          </Link>
        </div>
      </div>
    </Card>
  );
}
