// Shared, failure-safe helpers for the theme hooks: localStorage access that
// never throws (private mode, blocked site data, SSR) and <html> attribute
// writes that no-op without a DOM.

export function safeGetItem(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try { return localStorage.getItem(key); } catch { return null; }
}

/** Write a value, or remove the key when `value` is null. */
export function safeSetItem(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* private mode / SSR */ }
}

/** Set (or, with null, remove) an attribute on <html>. */
export function setRootAttr(name: string, value: string | null): void {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;
  if (value === null) el.removeAttribute(name);
  else el.setAttribute(name, value);
}
