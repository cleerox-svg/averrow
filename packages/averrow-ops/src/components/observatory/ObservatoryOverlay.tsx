import { Globe } from 'lucide-react';

export type ObservatoryOverlayKind = 'clear' | 'ungeolocated';

interface ObservatoryOverlayProps {
  /** Which message to show (see features/observatory-v3/lib/overlay-visibility.ts for when). */
  kind: ObservatoryOverlayKind;
  /** Human label of the selected window, e.g. "7D". */
  timeWindow: string;
  /** All threats ingested in the window (including ones with no coordinates). */
  totalThreats: number;
  /** Optional source-filter label, e.g. "Spam Trap" (omit for all sources). */
  sourceLabel?: string | null;
}

export function ObservatoryOverlay({ kind, timeWindow, totalThreats, sourceLabel }: ObservatoryOverlayProps) {
  const scope = sourceLabel ? ` from ${sourceLabel}` : '';
  const isClear = kind === 'clear';

  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <div
        role="status"
        className="backdrop-blur-xl rounded-2xl px-8 py-6 text-center max-w-xs"
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border-base)',
          boxShadow: 'var(--card-shadow)',
        }}
      >
        {/* Pulsing globe icon */}
        <div className="relative mx-auto w-10 h-10 mb-4">
          <div
            className="absolute inset-0 rounded-full animate-ping motion-reduce:animate-none"
            style={{ background: 'var(--amber-glow)' }}
          />
          <div
            className="relative flex items-center justify-center w-10 h-10 rounded-full"
            style={{ background: 'color-mix(in srgb, var(--amber) 12%, transparent)' }}
          >
            <Globe className="w-5 h-5" style={{ color: 'var(--amber-text)' }} aria-hidden />
          </div>
        </div>

        <h3 className="font-semibold text-sm mb-1" style={{ color: 'var(--text-primary)' }}>
          {isClear ? 'Threat Landscape Clear' : 'No Geolocated Threats'}
        </h3>
        <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
          {isClear
            ? `No threats recorded${scope} in the ${timeWindow} window`
            : `${totalThreats.toLocaleString()} threat${totalThreats === 1 ? '' : 's'}${scope} in the ${timeWindow} window have no map position yet`}
        </p>
      </div>
    </div>
  );
}
