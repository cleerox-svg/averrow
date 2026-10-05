// Per-control save feedback (ACCOUNT_DESIGN_SPEC §4.11): a control that
// autosaves shows a spinner while in flight, a 1.5s inline "Saved" on success,
// and on failure an error toast plus a message on the row. No toast spam on
// success. Keys are free-form ("push-floor", "event:brand_threat").

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { useToast } from '../../ui';
import { CheckSmallIcon } from './icons';

export type SaveStatus = 'saving' | 'saved' | 'error';
export interface SaveEntry { status: SaveStatus; message?: string }

export const SAVE_ERROR_MESSAGE = "Couldn't save. Check your connection and try again.";
const SAVED_MS = 1500;

export interface Autosave {
  /** Run `fn`; resolves true on success, false on failure (never throws). */
  run: (key: string, fn: () => Promise<unknown>, failMessage?: string | ((err: unknown) => string)) => Promise<boolean>;
  entry: (key: string) => SaveEntry | undefined;
  saving: (key: string) => boolean;
  error: (key: string) => string | undefined;
  clear: (key: string) => void;
}

export function useAutosave(): Autosave {
  const toast = useToast();
  const [entries, setEntries] = useState<Record<string, SaveEntry>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const t = timers.current;
    return () => {
      mounted.current = false;
      t.forEach((id) => clearTimeout(id));
      t.clear();
    };
  }, []);

  const set = useCallback((key: string, value: SaveEntry | null) => {
    if (!mounted.current) return;
    setEntries((prev) => {
      const next = { ...prev };
      if (value) next[key] = value; else delete next[key];
      return next;
    });
  }, []);

  const run = useCallback<Autosave['run']>(async (key, fn, failMessage = SAVE_ERROR_MESSAGE) => {
    const pending = timers.current.get(key);
    if (pending) { clearTimeout(pending); timers.current.delete(key); }
    set(key, { status: 'saving' });
    try {
      await fn();
      set(key, { status: 'saved' });
      timers.current.set(key, setTimeout(() => { timers.current.delete(key); set(key, null); }, SAVED_MS));
      return true;
    } catch (err) {
      const message = typeof failMessage === 'function' ? failMessage(err) : failMessage;
      set(key, { status: 'error', message });
      toast.error(message);
      return false;
    }
  }, [set, toast]);

  return {
    run,
    entry: (key) => entries[key],
    saving: (key) => entries[key]?.status === 'saving',
    error: (key) => (entries[key]?.status === 'error' ? entries[key]?.message : undefined),
    clear: (key) => set(key, null),
  };
}

/** The inline "Saved" tick beside a control; renders nothing unless the key just saved. */
export function SavedMark({ show }: { show: boolean }): ReactElement | null {
  if (!show) return <span aria-live="polite" className="sr-only" />;
  return (
    <span
      role="status"
      className="mr-2 inline-flex items-center gap-1 whitespace-nowrap text-[13px] font-semibold text-[var(--sev-info-text)]"
    >
      <CheckSmallIcon width={14} height={14} />
      Saved
    </span>
  );
}

/** True while the browser reports a connection. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  return online;
}
