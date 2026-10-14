/**
 * Detail card for a clicked/tapped node or arc. Positioned inside the map
 * container (not the window), kept clear of the open side panel, and dismissed
 * with Esc or the close button. Phase B's drill-in drawer can replace the body
 * while keeping this selection contract.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Card } from '@/design-system/components';
import { clampCardPosition, type CardBounds, type MapSelection } from '../lib/selection';
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

export function MapDetailCard({ selection, anchor, bounds, onClose }: MapDetailCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(180);

  useLayoutEffect(() => {
    if (ref.current) setHeight(ref.current.offsetHeight);
  }, [selection]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const width = Math.min(CARD_WIDTH, Math.max(0, bounds.width - 16));
  const { left, top } = clampCardPosition(anchor, { width, height }, bounds);

  return (
    <Card
      ref={ref}
      variant="elevated"
      role="dialog"
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
          className="ds-focusable shrink-0"
          style={{ cursor: 'pointer', background: 'none', border: 'none', padding: 2, borderRadius: 4, color: 'var(--text-tertiary)', lineHeight: 0 }}
        >
          <X size={14} />
        </button>
      </div>

      {selection.kind === 'node' ? (
        <div className="space-y-1 text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
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
        <div className="space-y-1 text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>
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
