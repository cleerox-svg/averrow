import React from 'react';
import { Button } from './Button';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

// Matches the pattern used by browsers/bundlers for a failed dynamic
// `import()` of a route chunk — the class name Vite/webpack throw
// ("ChunkLoadError") plus the message variants Chromium/Firefox/Safari
// use for a 404'd or otherwise unloadable module script.
const CHUNK_ERROR_PATTERN =
  /failed to (fetch|load) dynamically imported module|importing a module script failed|loading chunk \d+ failed/i;

function isChunkLoadError(error: Error | null): boolean {
  if (!error) return false;
  return error.name === 'ChunkLoadError' || CHUNK_ERROR_PATTERN.test(error.message || '');
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error) {
    // Belt-and-suspenders for main.tsx's 'vite:preloadError' handler: some
    // stale-chunk failures surface here as a thrown render error rather than
    // (or in addition to) the window-level event — e.g. a lazy() import that
    // rejects during a Suspense boundary. Same fix, same one-time-reload
    // guard: a stale tab recovers via a single full reload (fresh index.html
    // → fresh chunk map); a genuinely broken chunk reloads once, fails again,
    // and falls through to the normal "Try Again" UI below instead of
    // reload-looping. Shares the SAME sessionStorage key as main.tsx so the
    // two mechanisms count against one shared cooldown budget.
    if (!isChunkLoadError(error)) return;

    const KEY = 'av:chunkReloadAt';
    const last = Number(sessionStorage.getItem(KEY) || 0);
    if (Date.now() - last > 10_000) {
      sessionStorage.setItem(KEY, String(Date.now()));
      window.location.reload();
    }
    // else: already tried a reload for this in the last 10s — leave hasError
    // true and show the normal fallback UI below instead of reloading again.
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center py-20 animate-fade-in">
          <div className="font-mono text-xs text-accent uppercase tracking-wider mb-3">System Error</div>
          <div style={{ color: 'var(--text-secondary)' }} className="text-sm mb-6 max-w-md text-center">
            Something went wrong loading this view. Please try again.
          </div>
          <Button variant="secondary" onClick={() => this.setState({ hasError: false, error: null })}>
            Try Again
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}
