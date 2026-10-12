// Authenticated binary access for page-capture evidence. Capture URLs are
// staff-API paths that need the Bearer token, so they can never be used as
// <img src> / <a href> directly: fetch → blob → object URL (revoked on cleanup).
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

/** Only same-origin API paths are ever fetched with the session token. */
export function isApiPath(path: string | null | undefined): path is string {
  return !!path && path.startsWith('/api/') && !path.startsWith('//') && !path.includes('://');
}

export interface BlobUrlState { url: string | null; loading: boolean; error: boolean }

export function useAuthedBlobUrl(path: string | null | undefined, enabled = true): BlobUrlState {
  const [state, setState] = useState<BlobUrlState>({ url: null, loading: false, error: false });
  useEffect(() => {
    if (!enabled || !isApiPath(path)) {
      setState({ url: null, loading: false, error: false });
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ url: null, loading: true, error: false });
    api.getBlob(path).then(
      (blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ url: objectUrl, loading: false, error: false });
      },
      () => { if (!cancelled) setState({ url: null, loading: false, error: true }); },
    );
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, enabled]);
  return state;
}

/** Fetch with auth and save through a temporary same-document blob anchor. */
export async function downloadAuthedFile(path: string, filename: string): Promise<void> {
  if (!isApiPath(path)) throw new Error('Refusing to download from a non-API path');
  const blob = await api.getBlob(path);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Defer so the browser has started the download before the URL dies.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
