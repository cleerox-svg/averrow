import * as React from 'react';
import { Button } from '../Button';
import { reloadToLatest } from './reloadToLatest';
import { useAppUpdateAvailable } from './useAppUpdateAvailable';

export interface UpdateBannerProps {
  /** Default: `reloadToLatest`. */
  onReload?: () => void | Promise<void>;
}

/** The banner itself: in the shell flow, primary-tinted, one "Reload" action (no auto-reload). */
export function UpdateBanner({ onReload }: UpdateBannerProps): React.ReactElement {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 px-3 py-2 text-[13px] font-semibold text-[var(--text-primary)]"
      style={{
        background: 'color-mix(in srgb, var(--primary) 16%, var(--bg-page))',
        borderBottom: '1px solid var(--primary-border)',
        position: 'relative',
        zIndex: 250,
      }}
      data-testid="app-update-banner"
    >
      <span>A new version of Averrow is available.</span>
      <Button
        type="button"
        size="sm"
        className="font-bold"
        onClick={() => { void (onReload ?? reloadToLatest)(); }}
        data-testid="app-update-reload"
      >
        Reload
      </Button>
    </div>
  );
}

/**
 * Mount once per app, at the top of the shell's content column. Renders
 * nothing until a newer build is detected. `shellUrl`: `/v2/` (ops) or
 * `/tenant/` (tenant).
 */
export function AppUpdateNotice({ shellUrl }: { shellUrl: string }): React.ReactElement | null {
  const available = useAppUpdateAvailable(shellUrl);
  return available ? <UpdateBanner /> : null;
}
