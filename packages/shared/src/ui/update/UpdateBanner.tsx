import * as React from 'react';
import { Button } from '../Button';
import { reloadToLatest } from './reloadToLatest';
import { useAppUpdateAvailable } from './useAppUpdateAvailable';

export interface UpdateBannerProps {
  /** Default: `reloadToLatest`. */
  onReload?: () => void | Promise<void>;
}

/**
 * The banner itself: in the shell flow (no positioning or z-index, so it never
 * paints over drawers or the command palette), primary-tinted, one "Reload"
 * action (no auto-reload). Edge padding honours the device safe-area insets;
 * while it is mounted `<html data-update-banner>` is set so the ops top bar
 * does not add the top inset a second time.
 */
export function UpdateBanner({ onReload }: UpdateBannerProps): React.ReactElement {
  React.useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-update-banner', '');
    return () => root.removeAttribute('data-update-banner');
  }, []);

  return (
    <div
      className="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 pb-2 text-[13px] font-semibold text-[var(--text-primary)]"
      style={{
        background: 'color-mix(in srgb, var(--primary) 16%, var(--bg-page))',
        borderBottom: '1px solid var(--primary-border)',
        paddingTop: 'max(8px, env(safe-area-inset-top))',
        paddingLeft: 'max(12px, env(safe-area-inset-left))',
        paddingRight: 'max(12px, env(safe-area-inset-right))',
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
 * Mount once per app, at the top of the shell's content column. The polite
 * live region is always mounted (so the insertion is announced) and empty
 * until a newer build is detected. `shellUrl`: `/ops/` (ops) or `/tenant/`.
 */
export function AppUpdateNotice({ shellUrl }: { shellUrl: string }): React.ReactElement {
  const available = useAppUpdateAvailable(shellUrl);
  return (
    <div role="status" aria-live="polite" data-testid="app-update-region">
      {available ? <UpdateBanner /> : null}
    </div>
  );
}
