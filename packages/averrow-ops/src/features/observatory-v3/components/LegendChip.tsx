/**
 * Legend chip: ONE collapsible card, bottom-left, that expands upward and shows
 * the key for whatever the active lens is drawing. It replaces the stack of
 * separate legend cards (lens, severity / type, heatmap, bot density).
 *
 * The closed chip still tells the truth: it shows loading / failed / empty state
 * and a count, so a lens that drew nothing never looks like "all clear".
 */

import { useEffect, useId, useState, type ReactNode } from 'react';
import { ChevronUp } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { LensId, LayerToggles } from '../lib/lenses';
import type { Measure, ThreatView } from '../lib/url-state';
import { LENS_DEFS } from '../lib/lenses';
import type { ColorBy } from '../lib/map-colors';
import {
  SEVERITY_COLORS, SEVERITY_ORDER, THREAT_TYPE_COLORS, TYPE_ORDER, HEATMAP_COLOR_RANGE, rgbCss, typeLabel,
} from '../lib/map-colors';
import {
  ActorsSection, BaselineSection, CampaignsSection, HostingSection, MovementSection, OperationsSection, VelocitySection,
  TakedownCountrySection, TakedownProviderSection,
  type LegendSectionProps,
} from './LensLegend';

export interface LegendChipProps extends LegendSectionProps {
  lens: LensId;
  layers: LayerToggles;
  view: ThreatView;
  /** The lens's measure (Baseline / Hosting). */
  measure: Measure;
  colorBy: ColorBy;
  /** One-line state shown on the closed chip. */
  summary: { text: string; tone: 'ok' | 'loading' | 'error' | 'empty' };
  reducedMotion: boolean;
  /** Tallest the expanded panel may grow (px), so it never reaches the top chrome on a short viewport. */
  maxPanelHeight?: number;
  /** The panel opened / closed (the map holds the globe still while someone reads it). */
  onOpenChange?: (open: boolean) => void;
  className?: string;
  style?: React.CSSProperties;
}

const LABEL = 'font-mono text-[10px] uppercase tracking-wider';

function Swatch({ color }: { color: string }) {
  // The basemap is always dark, so swatches use the fixed layer colours (not theme tokens). The
  // black hairline ring is intentionally theme-independent: it keeps dim colours visible against
  // the light-theme card and has no visual role in dark mode.
  return <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: color, boxShadow: '0 0 0 1px rgba(0,0,0,0.35)', flexShrink: 0 }} />;
}

/** Severity / threat-type key for the nodes, particles and beams. */
export function ThreatKey({ colorBy, reducedMotion }: { colorBy: ColorBy; reducedMotion: boolean }) {
  return (
    <section className="flex flex-col gap-1.5" aria-label="Threat colours">
      <h3 className={LABEL} style={{ color: 'var(--text-tertiary)', margin: 0 }}>{colorBy === 'severity' ? 'Colour: severity' : 'Colour: threat type'}</h3>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1 list-none p-0 m-0">
        {colorBy === 'severity'
          ? SEVERITY_ORDER.map(s => (
            <li key={s} className="flex items-center gap-1.5 font-mono text-[10px] capitalize" style={{ color: 'var(--text-secondary)' }}>
              <Swatch color={rgbCss(SEVERITY_COLORS[s])} />{s}
            </li>
          ))
          : TYPE_ORDER.map(t => (
            <li key={t} className="flex items-center gap-1.5 font-mono text-[10px] capitalize min-w-0" style={{ color: 'var(--text-secondary)' }}>
              <Swatch color={rgbCss(THREAT_TYPE_COLORS[t])} /><span className="truncate">{typeLabel(t)}</span>
            </li>
          ))}
      </ul>
      <div className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
        Nodes = where threats originate; size = threat count.{' '}
        {reducedMotion ? 'Static beams run from origin to the targeted brand.' : 'Particles and beams run from origin to the targeted brand; critical and high nodes breathe.'}
      </div>
    </section>
  );
}

function HeatKey() {
  const gradient = `linear-gradient(90deg, ${HEATMAP_COLOR_RANGE.map(c => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${Math.max(c[3], 40) / 255})`).join(', ')})`;
  return (
    <section className="flex flex-col gap-1.5" aria-label="Threat density">
      <h3 className={LABEL} style={{ color: 'var(--text-tertiary)', margin: 0 }}>Threat density</h3>
      <div
        role="img"
        aria-label="Colour scale from low to high threat density"
        style={{ height: 8, borderRadius: 4, background: gradient, backgroundColor: '#0b1220' /* basemap-fixed: the always-dark map background the ramp's transparent end sits on */ }}
      />
      <div className="flex justify-between font-mono text-[10px]" style={{ color: 'var(--text-secondary)' }}>
        <span>Low</span><span>High</span>
      </div>
      <div className="font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>Density of geolocated threats, weighted by severity.</div>
    </section>
  );
}

export function LegendChip(props: LegendChipProps) {
  const { lens, layers, view, measure, colorBy, summary, reducedMotion, maxPanelHeight, onOpenChange, className, style } = props;
  const id = useId();
  // The Actors lens starts open: its legend holds the "choose an actor" control.
  const [open, setOpen] = useState(() => lens === 'actors' && !props.actors.selectedId);
  useEffect(() => { if (lens === 'actors' && !props.actors.selectedId) setOpen(true); }, [lens, props.actors.selectedId]);
  useEffect(() => {
    onOpenChange?.(open);
    return () => onOpenChange?.(false);
  }, [open, onOpenChange]);

  const threatTraffic = layers.nodes || layers.particles || layers.beams;
  const sections: ReactNode[] = [];
  if (lens === 'threats' && view === 'heat') sections.push(<HeatKey key="heat" />);
  else if (lens === 'threats' && view === 'fast') sections.push(<VelocitySection key="fast" s={props.velocity} />);
  else {
    if (threatTraffic) sections.push(<ThreatKey key="threat" colorBy={colorBy} reducedMotion={reducedMotion} />);
    if (layers.operations) sections.push(<OperationsSection key="ops" s={props.operations} />);
    if (layers.movement) sections.push(<MovementSection key="move" s={props.movement} />);
    if (layers.hosting) {
      sections.push(measure === 'takedowns'
        ? <TakedownProviderSection key="host" s={props.takedowns.providers} window={props.takedowns.window} />
        : <HostingSection key="host" s={props.hosting} />);
    }
    if (layers.baseline) {
      sections.push(measure === 'takedowns'
        ? <TakedownCountrySection key="base" s={props.takedowns.countries} window={props.takedowns.window} />
        : <BaselineSection key="base" s={props.baseline} />);
    }
    if (layers.campaigns) sections.push(<CampaignsSection key="camp" s={props.campaigns} />);
    if (layers.actors) sections.push(<ActorsSection key="actor" s={props.actors} onPickActor={props.onPickActor} />);
  }
  if (sections.length === 0) return null;

  const dot = summary.tone === 'error' ? 'var(--sev-critical)' : summary.tone === 'loading' ? 'var(--amber)' : summary.tone === 'empty' ? 'var(--text-muted)' : 'var(--sev-info)';
  return (
    <div className={cn('relative', className)} style={style}>
      <div
        id={id}
        role="group"
        aria-label={`${LENS_DEFS[lens].label} legend`}
        hidden={!open}
        className="absolute left-0 bottom-full mb-2 w-[272px] max-w-[calc(100vw-24px)] max-h-[min(58vh,440px)] overflow-y-auto rounded-xl p-3 flex flex-col gap-3 animate-sheet-in motion-reduce:animate-none [&[hidden]]:hidden"
        style={{
          background: 'var(--bg-card-deep)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          border: '1px solid var(--border-base)',
          boxShadow: 'var(--card-shadow-elevated)',
          ...(maxPanelHeight ? { maxHeight: `min(58vh, 440px, ${maxPanelHeight}px)` } : null),
        }}
      >
        {sections}
      </div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(o => !o)}
        className="ds-focusable inline-flex items-center gap-2 rounded-xl px-3 min-h-[36px] max-[899px]:min-h-[44px] font-mono text-[11px]"
        style={{
          background: 'var(--bg-card)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          border: '1px solid var(--border-base)',
          boxShadow: 'var(--card-shadow)',
          color: 'var(--text-secondary)',
          cursor: 'pointer',
        }}
      >
        <span aria-hidden className="rounded-full" style={{ width: 7, height: 7, background: dot }} />
        <span className="uppercase tracking-wider text-[10px]" style={{ color: 'var(--text-tertiary)' }}>Legend</span>
        <span className="truncate max-w-[170px]" role={summary.tone === 'error' ? 'alert' : undefined}>{summary.text}</span>
        <ChevronUp size={12} aria-hidden className="shrink-0 transition-transform duration-150 motion-reduce:transition-none" style={{ transform: open ? 'rotate(180deg)' : undefined }} />
      </button>
    </div>
  );
}
