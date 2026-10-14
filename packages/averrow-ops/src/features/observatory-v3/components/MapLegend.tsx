/**
 * Legends for the global (severity / type colours) and heatmap map modes.
 * Styled to match BotDensityLegend. Swatches are generated from the same
 * colour tables the WebGL layers use, so legend and map cannot drift.
 */

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Card } from '@/design-system/components';
import {
  SEVERITY_COLORS, SEVERITY_ORDER, THREAT_TYPE_COLORS, TYPE_ORDER, HEATMAP_COLOR_RANGE, rgbCss, typeLabel,
  type ColorBy,
} from '../lib/map-colors';

interface MapLegendProps {
  mode: 'global' | 'heatmap';
  colorBy: ColorBy;
  /** Start collapsed (small screens). */
  defaultCollapsed?: boolean;
  /** Absolute positioning (the parent owns the layout). */
  style?: React.CSSProperties;
}

const label = 'font-mono text-[10px] uppercase tracking-wider';

function Swatch({ color }: { color: string }) {
  // The basemap is always dark, so swatches use the fixed layer colours (not theme tokens). The
  // literal black hairline ring is intentionally theme-independent: it keeps dim colours visible
  // against the light-theme card and has no visual role in dark mode.
  return (
    <span
      aria-hidden
      style={{ width: 8, height: 8, borderRadius: '50%', background: color, boxShadow: '0 0 0 1px rgba(0,0,0,0.35)', flexShrink: 0 }}
    />
  );
}

export function MapLegend({ mode, colorBy, defaultCollapsed = false, style }: MapLegendProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const title = mode === 'heatmap' ? 'Threat density' : colorBy === 'severity' ? 'Colour: severity' : 'Colour: threat type';

  const gradient = `linear-gradient(90deg, ${HEATMAP_COLOR_RANGE.map(c => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${Math.max(c[3], 40) / 255})`).join(', ')})`;

  return (
    <Card
      variant="base"
      padding="8px 12px"
      role="group"
      aria-label={mode === 'heatmap' ? 'Heatmap legend' : 'Map legend'}
      style={{ position: 'absolute', width: 232, ...style }}
    >
      <button
        type="button"
        onClick={() => setCollapsed(c => !c)}
        aria-expanded={!collapsed}
        className={`ds-focusable ${label} flex items-center justify-between w-full min-h-[24px] max-[899px]:min-h-[44px]`}
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-tertiary)' }}
      >
        <span>{title}</span>
        <ChevronDown
          size={12}
          className="transition-transform duration-150 motion-reduce:transition-none"
          style={{ transform: collapsed ? 'rotate(-90deg)' : undefined }}
        />
      </button>

      {!collapsed && mode === 'global' && (
        <>
          {colorBy === 'severity' ? (
            <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 list-none p-0 m-0">
              {SEVERITY_ORDER.map(s => (
                <li key={s} className="flex items-center gap-1.5 font-mono text-[10px] capitalize" style={{ color: 'var(--text-secondary)' }}>
                  <Swatch color={rgbCss(SEVERITY_COLORS[s])} />
                  {s}
                </li>
              ))}
            </ul>
          ) : (
            <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 list-none p-0 m-0">
              {TYPE_ORDER.map(t => (
                <li key={t} className="flex items-center gap-1.5 font-mono text-[10px] capitalize min-w-0" style={{ color: 'var(--text-secondary)' }}>
                  <Swatch color={rgbCss(THREAT_TYPE_COLORS[t])} />
                  <span className="truncate">{typeLabel(t)}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2 pt-2 font-mono text-[10px]" style={{ borderTop: '1px solid var(--border-base)', color: 'var(--text-tertiary)' }}>
            Nodes = where threats originate; size = threat count. Particles / beams run from origin to targeted brand.
          </div>
        </>
      )}

      {!collapsed && mode === 'heatmap' && (
        <>
          <div
            role="img"
            aria-label="Colour scale from low to high threat density"
            style={{ height: 8, borderRadius: 4, marginTop: 8, background: gradient, backgroundColor: '#0b1220' /* basemap-fixed: the always-dark map background the ramp's transparent end sits on */ }}
          />
          <div className="flex justify-between font-mono text-[10px] mt-1" style={{ color: 'var(--text-secondary)' }}>
            <span>Low</span>
            <span>High</span>
          </div>
          <div className="mt-2 pt-2 font-mono text-[10px]" style={{ borderTop: '1px solid var(--border-base)', color: 'var(--text-tertiary)' }}>
            Density of geolocated threats, weighted by severity.
          </div>
        </>
      )}
    </Card>
  );
}
