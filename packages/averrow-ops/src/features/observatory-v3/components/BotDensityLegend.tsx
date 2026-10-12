import { useMemo } from 'react';
import { Card } from '@/design-system/components';
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
  const gradient = useMemo(() => {
    const [lo, mid, hi] = resolveScaleStops();
    const css = (c: number[]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
    return `linear-gradient(90deg, ${css(lo)}, ${css(mid)}, ${css(hi)})`;
  }, []);

  const label = 'font-mono text-[9px] uppercase tracking-wider';

  return (
    <Card variant="base" padding="10px 12px" style={{ position: 'absolute', width: 232, ...style }}>
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

      <div className="flex items-center gap-2 mt-2 font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
        <span aria-hidden style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--text-muted)' }} />
          <span style={{ width: 12, height: 12, borderRadius: '50%', background: 'var(--text-muted)' }} />
        </span>
        <span>Size = share of global traffic</span>
      </div>
      <div className="flex items-center gap-2 mt-1 font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
        <span
          aria-hidden
          style={{ width: 12, height: 12, borderRadius: '50%', border: '2px solid var(--text-primary)', boxSizing: 'border-box' }}
        />
        <span>
          Ring = above global avg
          {globalAvg != null && <> ({formatPct(globalAvg)})</>}
        </span>
      </div>

      <div
        className="mt-2 pt-2 font-mono text-[9px]"
        style={{ borderTop: '1px solid var(--border-base)', color: 'var(--text-muted)' }}
      >
        Source: Cloudflare Radar{asOf ? <> &middot; as of {asOf}</> : null} &middot; {countries} countries
      </div>
    </Card>
  );
}
