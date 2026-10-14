/**
 * Control rail: the console's secondary controls in a slim 44px column, replacing
 * the old nine-row layer list.
 *
 *   VIEW      the active lens's option  (Threats: Points | Heat | Fast,
 *                                         Baseline: Over-index | Raw | Bot share)
 *   TRAFFIC   threat traffic underneath: Off | Nodes | Nodes + Flow
 *   Beams     static attack corridors
 *   Colour    severity | threat type
 *
 * Every control is an icon button with a tooltip and, where one exists, its
 * keyboard hint (the 1-9 layer keys keep working; they just aren't a list any
 * more). Changes are announced through an aria-live region. On phones the same
 * controls render as labelled 44px rows inside the filters card (`layout="panel"`).
 */

import { useCallback, useId, useState, type ReactNode } from 'react';
import { Activity, BarChart3, Bot, CircleDot, EyeOff, Flame, Palette, Route, Scale, ScatterChart, Zap } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { LayerToggles, LensId } from '../lib/lenses';
import type { ColorBy, Measure, ThreatView } from '../lib/url-state';
import { announceTraffic, trafficModeOf, trafficPatch, TRAFFIC_LABEL, type TrafficMode } from '../lib/controls';

export interface ControlRailProps {
  lens: LensId;
  layers: LayerToggles;
  view: ThreatView;
  measure: Measure;
  colorBy: ColorBy;
  reducedMotion: boolean;
  onLayers: (patch: Partial<LayerToggles>) => void;
  onView: (view: ThreatView) => void;
  onMeasure: (measure: Measure) => void;
  onColorBy: (colorBy: ColorBy) => void;
  /** `rail`: 44px icon column (tablet / desktop). `panel`: labelled 44px rows (phone filters card). */
  layout?: 'rail' | 'panel';
  className?: string;
}

interface Item {
  id: string;
  label: string;
  /** Longer description (tooltip body). */
  hint: string;
  key?: string;
  icon: ReactNode;
  pressed: boolean;
  onPress: () => void;
}

function RailButton({ item, layout }: { item: Item; layout: 'rail' | 'panel' }) {
  const tipId = useId();
  const panel = layout === 'panel';
  return (
    <div className={cn('group relative', panel && 'flex-1 min-w-0')}>
      <button
        type="button"
        aria-pressed={item.pressed}
        aria-label={item.label}
        aria-describedby={panel ? undefined : tipId}
        data-control={item.id}
        onClick={item.onPress}
        className={cn(
          'ds-focusable inline-flex items-center justify-center rounded-lg transition-colors motion-reduce:transition-none cursor-pointer',
          panel ? 'w-full min-h-[44px] gap-1.5 px-2 py-1 font-mono text-[11px]' : 'w-9 h-9',
        )}
        style={{
          background: item.pressed ? 'color-mix(in srgb, var(--amber) 14%, transparent)' : 'transparent',
          border: `1px solid ${item.pressed ? 'var(--amber-border)' : panel ? 'var(--border-base)' : 'transparent'}`,
          color: item.pressed ? 'var(--amber-text)' : 'var(--text-secondary)',
        }}
      >
        {item.icon}
        {panel && <span className="min-w-0 text-left leading-tight">{item.label}</span>}
      </button>
      {!panel && (
        <span
          id={tipId}
          role="tooltip"
          className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2 z-40 w-max max-w-[220px] rounded-lg px-2.5 py-1.5 font-mono text-[11px] opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none"
          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-base)', color: 'var(--text-primary)', boxShadow: 'var(--card-shadow)' }}
        >
          <span className="flex items-center gap-2">
            <span>{item.label}</span>
            {item.key && (
              <kbd className="font-mono text-[10px] rounded px-1" style={{ border: '1px solid var(--border-base)', color: 'var(--text-tertiary)' }}>{item.key}</kbd>
            )}
          </span>
          <span className="block mt-0.5 text-[10px] leading-snug" style={{ color: 'var(--text-tertiary)' }}>{item.hint}</span>
        </span>
      )}
    </div>
  );
}

function Group({ label, items, layout }: { label: string; items: Item[]; layout: 'rail' | 'panel' }) {
  return (
    <div role="group" aria-label={label} className={cn(layout === 'panel' ? 'flex gap-1.5' : 'flex flex-col gap-0.5')}>
      {items.map(item => <RailButton key={item.id} item={item} layout={layout} />)}
    </div>
  );
}

export function ControlRail({
  lens, layers, view, measure, colorBy, reducedMotion, onLayers, onView, onMeasure, onColorBy, layout = 'rail', className,
}: ControlRailProps) {
  const [announcement, setAnnouncement] = useState('');
  const say = useCallback((msg: string) => setAnnouncement(prev => (prev === msg ? `${msg}​` : msg)), []);
  const traffic = trafficModeOf(layers);
  const icon = (node: ReactNode) => node;

  const setTraffic = (mode: TrafficMode) => () => { onLayers(trafficPatch(mode)); say(announceTraffic(mode, reducedMotion)); };

  const trafficItems: Item[] = [
    { id: 'traffic-off', label: TRAFFIC_LABEL.off, hint: 'No threat traffic under the lens', icon: icon(<EyeOff size={16} />), pressed: traffic === 'off', onPress: setTraffic('off') },
    { id: 'traffic-nodes', label: TRAFFIC_LABEL.nodes, key: '1', hint: 'Threat origins, sized by count', icon: icon(<CircleDot size={16} />), pressed: traffic === 'nodes', onPress: setTraffic('nodes') },
    {
      id: 'traffic-flow',
      label: reducedMotion ? 'Nodes + Static beams' : TRAFFIC_LABEL.flow,
      key: '2',
      hint: reducedMotion ? 'Reduced motion: attack corridors are drawn as static beams' : 'Attacks in flight toward their targets',
      icon: icon(<Activity size={16} />), pressed: traffic === 'flow', onPress: setTraffic('flow'),
    },
  ];

  const extras: Item[] = [
    {
      id: 'beams', label: 'Beams', key: '3', hint: 'Static attack corridors', icon: icon(<Route size={16} />), pressed: layers.beams,
      onPress: () => { onLayers({ beams: !layers.beams }); say(`Beams ${layers.beams ? 'off' : 'on'}`); },
    },
    {
      id: 'color', label: colorBy === 'severity' ? 'Colour: severity' : 'Colour: type',
      hint: 'Switch the colour key between severity and threat type', icon: icon(<Palette size={16} />), pressed: colorBy === 'type',
      onPress: () => { const next: ColorBy = colorBy === 'severity' ? 'type' : 'severity'; onColorBy(next); say(`Colour by ${next === 'severity' ? 'severity' : 'threat type'}`); },
    },
  ];

  const viewItems: Item[] =
    lens === 'threats'
      ? [
        { id: 'view-points', label: 'Points', hint: 'Origin nodes, one per place', icon: icon(<ScatterChart size={16} />), pressed: view === 'points', onPress: () => { onView('points'); say('Threats view: points'); } },
        { id: 'view-heat', label: 'Heat', hint: 'Density of geolocated threats', icon: icon(<Flame size={16} />), pressed: view === 'heat', onPress: () => { onView('heat'); say('Threats view: heat'); } },
        { id: 'view-fast', label: 'Fast weaponization', hint: 'Countries where domains went live within days of registration (all sources)', icon: icon(<Zap size={16} />), pressed: view === 'fast', onPress: () => { onView('fast'); say('Threats view: fast weaponization'); } },
      ]
      : lens === 'baseline'
        ? [
          { id: 'measure-index', label: 'Over-index', hint: 'Our share of threats vs Cloudflare Radar\'s share of attack origin', icon: icon(<Scale size={16} />), pressed: measure === 'index', onPress: () => { onMeasure('index'); say('Baseline: over-index'); } },
          { id: 'measure-raw', label: 'Raw', hint: 'Raw count of threats per country', icon: icon(<BarChart3 size={16} />), pressed: measure === 'raw', onPress: () => { onMeasure('raw'); say('Baseline: raw volume'); } },
          { id: 'measure-bot', label: 'Bot share', hint: 'Radar: bot share of each country\'s traffic', icon: icon(<Bot size={16} />), pressed: measure === 'bot', onPress: () => { onMeasure('bot'); say('Baseline: bot share'); } },
        ]
        : [];

  // The heat and fast views and the bot-share scene are their own pictures: traffic context does not apply.
  const traffickable = !(lens === 'threats' && (view === 'heat' || view === 'fast')) && !(lens === 'baseline' && measure === 'bot');

  const panel = layout === 'panel';
  return (
    <div
      className={cn(panel ? 'flex flex-col gap-3' : 'flex flex-col items-center gap-1.5 rounded-xl p-[3px]', className)}
      style={panel ? undefined : {
        width: 44,
        background: 'var(--bg-card)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border: '1px solid var(--border-base)',
        boxShadow: 'var(--card-shadow)',
      }}
      data-layout={layout}
    >
      {viewItems.length > 0 && (
        <>
          {panel && <div className="font-mono text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>View</div>}
          <Group label={lens === 'threats' ? 'Threats view' : 'Baseline measure'} items={viewItems} layout={layout} />
          {!panel && traffickable && <div aria-hidden className="w-6 h-px my-0.5" style={{ background: 'var(--border-base)' }} />}
        </>
      )}
      {traffickable && (
        <>
          {panel && <div className="font-mono text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>Threat traffic underneath</div>}
          <Group label="Threat traffic underneath" items={trafficItems} layout={layout} />
          {!panel && <div aria-hidden className="w-6 h-px my-0.5" style={{ background: 'var(--border-base)' }} />}
          <Group label="Map options" items={extras} layout={layout} />
        </>
      )}
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
    </div>
  );
}
