import * as React from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../cn';
import { Card } from '../Card';
import { OverlayStyles } from './overlay-styles';

// Shared toast (ACCOUNT_DESIGN_SPEC §4.11). Ported from the ops Toast:
//   - `useToast().showToast(message, type?)` still works (same signature).
//   - NEW: `toast({ message, type, action, duration })`, `success/error/info`
//     shorthands, `dismiss(id)`.
// Differences from ops: one toast visible at a time (rest queue, ops stacked
// them), durations 3.5s / 6s (ops: flat 4s), pause on hover/focus, `Undo`
// action, role=status|alert, rendered in a body portal so Radix modal layers
// (which set pointer-events:none on <body>) cannot block the action button.
// `useToast()` throws outside a provider, as in ops.

export type ToastType = 'success' | 'error' | 'info';

export interface ToastAction {
  label: string;
  onAction: () => void;
}

export interface ToastOptions {
  message: string;
  type?: ToastType;
  action?: ToastAction;
  /** ms. Default 3500 (success/info), 6000 (error or with action). `0`/Infinity = sticky. */
  duration?: number;
}

interface ToastEntry extends ToastOptions {
  id: string;
  type: ToastType;
}

export interface ToastContextValue {
  /** Ops-compatible. */
  showToast: (message: string, type?: ToastType, options?: Omit<ToastOptions, 'message' | 'type'>) => string;
  toast: (options: ToastOptions) => string;
  success: (message: string, options?: Omit<ToastOptions, 'message' | 'type'>) => string;
  error: (message: string, options?: Omit<ToastOptions, 'message' | 'type'>) => string;
  info: (message: string, options?: Omit<ToastOptions, 'message' | 'type'>) => string;
  dismiss: (id?: string) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

export const TOAST_DURATION_MS = { default: 3500, long: 6000 } as const;

export function toastDuration(entry: Pick<ToastOptions, 'type' | 'action' | 'duration'>): number {
  if (entry.duration !== undefined) return entry.duration;
  return entry.type === 'error' || entry.action ? TOAST_DURATION_MS.long : TOAST_DURATION_MS.default;
}

let toastSeq = 0;
const nextId = () => `toast-${++toastSeq}`;

export function ToastProvider({ children }: { children?: React.ReactNode }): React.ReactElement {
  const [queue, setQueue] = React.useState<ToastEntry[]>([]);

  const toast = React.useCallback((options: ToastOptions) => {
    const id = nextId();
    setQueue((q) => [...q, { ...options, id, type: options.type ?? 'info' }]);
    return id;
  }, []);

  const dismiss = React.useCallback((id?: string) => {
    setQueue((q) => (id === undefined ? q.slice(1) : q.filter((t) => t.id !== id)));
  }, []);

  const value = React.useMemo<ToastContextValue>(
    () => ({
      toast,
      dismiss,
      showToast: (message, type = 'info', options) => toast({ ...options, message, type }),
      success: (message, options) => toast({ ...options, message, type: 'success' }),
      error: (message, options) => toast({ ...options, message, type: 'error' }),
      info: (message, options) => toast({ ...options, message, type: 'info' }),
    }),
    [toast, dismiss],
  );

  const current = queue[0];

  return (
    <ToastContext.Provider value={value}>
      {children}
      {typeof document !== 'undefined'
        ? createPortal(
            <div className="av-toast-viewport">
              <OverlayStyles />
              {current ? <ToastItem key={current.id} entry={current} onDismiss={() => dismiss(current.id)} /> : null}
            </div>,
            document.body,
          )
        : null}
    </ToastContext.Provider>
  );
}

const ICON_COLOR: Record<ToastType, string> = {
  success: 'var(--green)',
  error: 'var(--sev-critical-text)',
  info: 'var(--blue)',
};

function ToastGlyph({ type }: { type: ToastType }) {
  const common = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  if (type === 'success') return <svg {...common}><circle cx="12" cy="12" r="9.5" /><path d="m8 12.5 2.8 2.8L16 9.5" /></svg>;
  if (type === 'error') return <svg {...common}><circle cx="12" cy="12" r="9.5" /><path d="M12 7v6M12 16.5h.01" /></svg>;
  return <svg {...common}><circle cx="12" cy="12" r="9.5" /><path d="M12 11v5M12 8h.01" /></svg>;
}

function ToastItem({ entry, onDismiss }: { entry: ToastEntry; onDismiss: () => void }): React.ReactElement {
  const [paused, setPaused] = React.useState(false);
  const total = toastDuration(entry);
  const remaining = React.useRef(total);
  const onDismissRef = React.useRef(onDismiss);
  onDismissRef.current = onDismiss;

  React.useEffect(() => {
    if (paused || !Number.isFinite(remaining.current) || remaining.current <= 0) return;
    const startedAt = Date.now();
    const timer = setTimeout(() => onDismissRef.current(), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt));
    };
  }, [paused]);

  return (
    <Card
      variant="elevated"
      padding="12px 14px"
      className={cn('av-ov-toast')}
      role={entry.type === 'error' ? 'alert' : 'status'}
      aria-live={entry.type === 'error' ? 'assertive' : 'polite'}
      aria-atomic="true"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div className="flex items-center gap-3">
        <span className="inline-flex shrink-0" style={{ color: ICON_COLOR[entry.type] }}>
          <ToastGlyph type={entry.type} />
        </span>
        <span className="min-w-0 flex-1 text-[14px] leading-[1.45] text-[var(--text-primary)]">{entry.message}</span>
        {entry.action ? (
          <button
            type="button"
            onClick={() => {
              entry.action?.onAction();
              onDismiss();
            }}
            className="-my-2 -mr-2 inline-flex min-h-[44px] shrink-0 items-center rounded-[10px] px-3 text-[14px] font-bold text-[var(--amber-text)] outline-none hover:bg-[color-mix(in_srgb,var(--text-primary)_6%,transparent)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring,var(--amber))]"
          >
            {entry.action.label}
          </button>
        ) : null}
      </div>
    </Card>
  );
}
