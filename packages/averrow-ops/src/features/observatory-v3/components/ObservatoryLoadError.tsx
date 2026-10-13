// Load-error notice over the Observatory map. The positioning wrapper lives
// here (Banner itself is never absolutely positioned); the Banner surface is
// the near-opaque deep card so map tiles don't show through the text.
import { Banner, KitButton } from '@/design-system/components';

export interface ObservatoryLoadErrorProps {
  onRetry: () => void;
  /** Distance from the right edge: clears the open desktop side panel. */
  right: number;
  zIndex: number;
}

export function ObservatoryLoadError({ onRetry, right, zIndex }: ObservatoryLoadErrorProps) {
  return (
    <div
      // At <=640px the notice spans the screen with equal 16px gutters.
      className="[@media(max-width:640px)]:!left-4 [@media(max-width:640px)]:!w-auto"
      data-testid="observatory-load-error"
      style={{
        position: 'absolute',
        top: 56,
        right,
        zIndex,
        width: 320,
        maxWidth: 'calc(100% - 32px)',
        borderRadius: 'var(--radius-md)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
      }}
    >
      <Banner
        tone="critical"
        role="status"
        aria-label="Observatory load error"
        title="Couldn't load Observatory data"
        style={{ background: 'var(--bg-card-deep, var(--bg-card))' }}
        actions={<KitButton size="sm" variant="secondary" onClick={onRetry}>Retry</KitButton>}
      />
    </div>
  );
}
