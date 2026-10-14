/**
 * Detail card for a clicked/tapped node or arc. Positioned inside the map
 * container (not the window), kept clear of the open side panel, and dismissed
 * with Esc or the close button. Phase B's drill-in drawer can replace the body
 * while keeping this selection contract.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Card } from '@/design-system/components';
import { clampCardPosition, selectionKey, type CardBounds, type MapSelection } from '../lib/selection';
import { sevText, typeLabel } from '../lib/map-colors';

interface MapDetailCardProps {
  selection: MapSelection;
  anchor: { x: number; y: number };
  bounds: CardBounds;
  onClose: () => void;
}

const CARD_WIDTH = 300;

function Row({ children, style, className }: { children: React.ReactNode; style?: React.CSSProperties; className?: string }) {
  return <div className={className} style={style}>{children}</div>;
}

/** True when an Escape keydown is ours to handle: aimed at the map area / this card / nothing in particular. */
export function shouldHandleEscape(e: Pick<KeyboardEvent, 'key' | 'defaultPrevented' | 'target'>, card: HTMLElement | null): boolean {
  if (e.key !== 'Escape' || e.defaultPrevented) return false;
  const target = e.target;
  // Document / body target = nothing focused, so the card is the only thing to dismiss.
  if (!(target instanceof Element) || target === document.body) return true;
  if (card && card.contains(target)) return true;
  // Another dialog / menu / listbox owns this Escape (command palette, bottom sheet, dropdown).
  if (target.closest('[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[aria-modal="true"]')) return false;
  // Otherwise only the map area (the card's positioned parent) counts.
  const scope = card?.parentElement;
  return !!scope && scope.contains(target);
}

export function MapDetailCard({ selection, anchor, bounds, onClose }: MapDetailCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(180);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    if (ref.current) setHeight(ref.current.offsetHeight);
  }, [selection]);

  // Move focus into the card when it opens (keyboard / SR users land on it),
  // and give it back to whatever had it when the card goes away.
  const prevFocusRef = useRef<Element | null>(null);
  useEffect(() => {
    // Keep the FIRST opener: React StrictMode re-runs this effect after the card
    // has already taken focus, and "the card" must not become the restore target.
    const active = document.activeElement;
    if (!ref.current?.contains(active)) prevFocusRef.current = active;
    return () => {
      const prev = prevFocusRef.current;
      const current = document.activeElement;
      const focusLost = !current || current === document.body;
      if (focusLost && prev instanceof HTMLElement && prev !== document.body && prev.isConnected) {
        prev.focus({ preventScroll: true });
      }
    };
  }, []);
  const selKey = selectionKey(selection);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, [selKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!shouldHandleEscape(e, ref.current)) return;
      e.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const width = Math.min(CARD_WIDTH, Math.max(0, bounds.width - 16));
  const { left, top } = clampCardPosition(anchor, { width, height }, bounds);

  return (
    <Card
      ref={ref}
      variant="elevated"
      role="dialog"
      tabIndex={-1}
      className="outline-none"
      aria-label={selection.kind === 'node' ? 'Threat node details' : 'Threat corridor details'}
      padding="16px"
      style={{ position: 'absolute', left, top, width, zIndex: 40 }}
    >
      <div className="flex justify-between items-start mb-2 gap-2">
        <span className="font-mono text-xs font-bold capitalize" style={{ color: 'var(--text-primary)' }}>
          {selection.kind === 'node'
            ? `${selection.node.threat_count.toLocaleString()} threat${selection.node.threat_count === 1 ? '' : 's'}`
            : typeLabel(selection.arc.threat_type)}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="ds-focusable shrink-0 inline-flex items-center justify-center min-w-[28px] min-h-[28px] -m-1 max-[899px]:min-w-[44px] max-[899px]:min-h-[44px]"
          style={{ cursor: 'pointer', background: 'none', border: 'none', padding: 2, borderRadius: 6, color: 'var(--text-tertiary)', lineHeight: 0 }}
        >
          <X size={14} />
        </button>
      </div>

      {selection.kind === 'node' ? (
        <div className="space-y-1 text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>
          <Row>
            <span className="capitalize">{typeLabel(selection.node.top_threat_type) || 'Mixed'}</span>
            {selection.node.top_severity && (
              <>
                {' · '}
                <span className="uppercase" style={{ color: sevText(selection.node.top_severity) }}>{selection.node.top_severity}</span>
              </>
            )}
          </Row>
          {selection.node.country_code && <Row>Country: {selection.node.country_code}</Row>}
          <Row>
            <span style={{ color: sevText('critical') }}>C:{selection.node.critical}</span>{' '}
            <span style={{ color: sevText('high') }}>H:{selection.node.high}</span>{' '}
            <span style={{ color: sevText('medium') }}>M:{selection.node.medium}</span>{' '}
            <span style={{ color: sevText('low') }}>L:{selection.node.low}</span>
          </Row>
        </div>
      ) : (
        <div className="space-y-1 text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>
          <Row>{selection.arc.volume} threat{selection.arc.volume === 1 ? '' : 's'}</Row>
          {selection.arc.brand_name && <Row style={{ color: 'var(--amber-text)' }}>Target: {selection.arc.brand_name}</Row>}
          {selection.arc.target_precision === 'country' && (
            <Row>Target position is approximate (country level)</Row>
          )}
          {selection.arc.source_region && <Row>From: {selection.arc.source_region}</Row>}
          <Row className="uppercase" style={{ color: sevText(selection.arc.severity) }}>
            {selection.arc.severity}
          </Row>
        </div>
      )}
    </Card>
  );
}
