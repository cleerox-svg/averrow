/**
 * Layer rail: every drawable layer as a keyboard-operable toggle with its colour
 * swatch, a count and a status. Shared by the desktop left column and the mobile
 * filter drawer (`touch` = 44px rows).
 *
 * Each row is a toggle button (aria-pressed) named exactly by its layer label;
 * the count / loading / error text sits in a described-by line so the accessible
 * name stays stable. Number keys 1-9 toggle layers while focus is on the map or
 * the rail (see useLayerShortcuts).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Card } from '@/design-system/components';
import { cn } from '@/lib/cn';
import { LAYER_DEFS, type LayerDef, type LayerId, type LayerToggles } from '../lib/lenses';

export type LayerStatus = 'idle' | 'loading' | 'error';

export interface LayerRailProps {
  layers: LayerToggles;
  onToggle: (id: LayerId, next: boolean) => void;
  /** Particles are paused by the map under reduced motion, whatever the URL says. */
  reducedMotion: boolean;
  /** How many objects each ON layer is drawing (null / undefined = unknown). */
  counts?: Partial<Record<LayerId, number | null>>;
  status?: Partial<Record<LayerId, LayerStatus>>;
  /** Start with the layer list folded away (narrow desktops, where the rail would crowd the map). */
  defaultCollapsed?: boolean;
  /** 44px rows, no shortcut hints, no card chrome (inside the mobile filter drawer). */
  touch?: boolean;
  className?: string;
}

const GROUP_LABEL: Record<LayerDef['group'], string> = { threats: 'Threats', lens: 'Lenses' };

function describe(def: LayerDef, count: number | null | undefined, status: LayerStatus | undefined): string {
  if (status === 'loading') return 'loading…';
  if (status === 'error') return 'failed to load';
  if (count === undefined || count === null) return '';
  return `${count.toLocaleString()} shown`;
}

function Row({
  def, active, paused, count, status, touch, onToggle,
}: {
  def: LayerDef;
  active: boolean;
  paused: boolean;
  count: number | null | undefined;
  status: LayerStatus | undefined;
  touch: boolean;
  onToggle: () => void;
}) {
  const note = active ? describe(def, count, status) : '';
  const noteId = `layer-note-${def.id}`;
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-disabled={paused || undefined}
      aria-describedby={noteId}
      title={paused ? 'Paused: reduced motion' : def.description}
      data-layer={def.id}
      onClick={() => { if (!paused) onToggle(); }}
      className={cn(
        'ds-focusable group w-full flex items-center gap-2.5 rounded-md px-2 text-left transition-colors motion-reduce:transition-none',
        touch ? 'min-h-[44px]' : 'min-h-[30px]',
      )}
      style={{
        background: active && !paused ? 'color-mix(in srgb, var(--amber) 10%, transparent)' : 'transparent',
        border: `1px solid ${active && !paused ? 'var(--amber-border)' : 'transparent'}`,
        color: paused ? 'var(--text-muted)' : active ? 'var(--text-primary)' : 'var(--text-tertiary)',
        opacity: paused ? 0.55 : 1,
        cursor: paused ? 'not-allowed' : 'pointer',
      }}
    >
      <span
        aria-hidden
        className="shrink-0 rounded-full"
        style={{
          width: 10, height: 10,
          background: active && !paused ? def.swatch : 'transparent',
          boxShadow: `inset 0 0 0 1.5px ${def.swatch}`,
          opacity: active && !paused ? 1 : 0.6,
        }}
      />
      <span className="flex-1 min-w-0">
        <span className="block font-mono text-[11px] uppercase tracking-wider truncate">
          {def.label}
          {paused && <span className="sr-only"> (Paused: reduced motion)</span>}
        </span>
      </span>
      <span id={noteId} aria-hidden className="font-mono text-[10px] tabular-nums shrink-0" style={{ color: status === 'error' ? 'var(--sev-critical-text)' : 'var(--text-muted)' }}>
        {note}
      </span>
      {!touch && (
        <kbd
          aria-hidden
          className="font-mono text-[9px] rounded px-1 shrink-0"
          style={{ border: '1px solid var(--border-base)', color: 'var(--text-muted)' }}
        >
          {def.key}
        </kbd>
      )}
    </button>
  );
}

export function LayerRail({ layers, onToggle, reducedMotion, counts = {}, status = {}, touch = false, defaultCollapsed = false, className }: LayerRailProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  const list = (
    <div role="group" aria-label="Map layers" className="flex flex-col gap-0.5">
      {(['threats', 'lens'] as const).map(group => (
        <div key={group} className="flex flex-col gap-0.5">
          <div className="font-mono text-[9px] uppercase tracking-[0.18em] px-2 pt-1.5 pb-0.5" style={{ color: 'var(--text-muted)' }}>
            {GROUP_LABEL[group]}
          </div>
          {LAYER_DEFS.filter(d => d.group === group).map(def => (
            <Row
              key={def.id}
              def={def}
              active={layers[def.id]}
              paused={def.id === 'particles' && reducedMotion}
              count={counts[def.id]}
              status={status[def.id]}
              touch={touch}
              onToggle={() => onToggle(def.id, !layers[def.id])}
            />
          ))}
        </div>
      ))}
    </div>
  );

  if (touch) return <div className={className}>{list}</div>;

  return (
    <Card variant="base" padding="6px" className={cn('shrink-0', className)}>
      <button
        type="button"
        onClick={() => setCollapsed(c => !c)}
        aria-expanded={!collapsed}
        aria-controls="observatory-layer-list"
        className="ds-focusable w-full flex items-center justify-between font-mono text-[10px] uppercase tracking-wider min-h-[24px] px-2"
        style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer' }}
      >
        <span>Layers</span>
        <ChevronDown size={12} className="transition-transform duration-150 motion-reduce:transition-none" style={{ transform: collapsed ? 'rotate(-90deg)' : undefined }} />
      </button>
      <div id="observatory-layer-list" hidden={collapsed}>{list}</div>
    </Card>
  );
}

// ─── Keyboard shortcuts ─────────────────────────────────────

const INTERACTIVE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="combobox"], [role="textbox"]';

/**
 * Number-key shortcuts for layers. Attach the returned handler to the element
 * that wraps the map and the rail (React onKeyDown): it ignores modified keys
 * and anything typed into a field.
 */
export function layerForKey(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'defaultPrevented'> & { target: EventTarget | null }): LayerId | null {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.target instanceof Element && e.target.closest(INTERACTIVE)) return null;
  return LAYER_DEFS.find(d => d.key === e.key)?.id ?? null;
}

export function useLayerShortcuts(onToggle: (id: LayerId) => void, enabled: boolean): (e: React.KeyboardEvent) => void {
  const ref = useRef(onToggle);
  useEffect(() => { ref.current = onToggle; }, [onToggle]);
  return useCallback((e: React.KeyboardEvent) => {
    if (!enabled) return;
    const id = layerForKey({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, defaultPrevented: e.defaultPrevented, target: e.target });
    if (id) ref.current(id);
  }, [enabled]);
}
