// @averrow/shared/ui/settings — CopyField (ACCOUNT_DESIGN_SPEC §4.14)
//
// Read-only mono value (IDs, versions) with a 44x44 copy button. Uses the async
// Clipboard API and falls back to a hidden-textarea `execCommand('copy')`; if
// both fail it says so in the live region (the value is `user-select: all`, so
// the user can still copy by hand).

import { useEffect, useRef, useState } from 'react';
import { cn } from '../cn';
import { CheckIcon, CopyIcon } from './icons';

export interface CopyFieldProps {
  value: string;
  /** What is being copied, used in the button name: "Copy {label}". Default "value". */
  label?: string;
  onCopied?: () => void;
  className?: string;
}

type CopyState = 'idle' | 'copied' | 'failed';

/** Copy text; resolves false when no mechanism is available / permitted. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    if (typeof document === 'undefined') return false;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  } catch {
    return false;
  }
}

export function CopyField({ value, label = 'value', onCopied, className }: CopyFieldProps) {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onCopy = async () => {
    const ok = await copyText(value);
    setState(ok ? 'copied' : 'failed');
    if (ok) onCopied?.();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), ok ? 1500 : 4000);
  };

  return (
    <div className={cn('ds-copy', className)}>
      <span className="ds-copy-value" title={value}>{value}</span>
      <button type="button" className="ds-iconbtn" onClick={onCopy} aria-label={`Copy ${label}`}>
        {state === 'copied'
          ? <CheckIcon width={18} height={18} style={{ color: 'var(--sev-info-text)' }} />
          : <CopyIcon width={18} height={18} />}
      </button>
      <span role="status" aria-live="polite" className={state === 'failed' ? 'text-[13px] text-[var(--sev-critical-text)]' : 'sr-only'}>
        {state === 'copied' ? 'Copied' : state === 'failed' ? "Couldn't copy. Select the text and copy it manually." : ''}
      </span>
    </div>
  );
}
