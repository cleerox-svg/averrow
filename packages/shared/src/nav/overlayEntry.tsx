import { createContext, useCallback, useContext, type ReactNode } from 'react';
import { Link, NavLink, useNavigate, type LinkProps, type NavLinkProps, type NavigateOptions, type To } from 'react-router-dom';

/**
 * True inside an overlay that owns a history entry (a `dismissOnBack` sheet or
 * dialog, an open nav drawer, the palette). Navigation that leaves the overlay
 * must REPLACE that entry, otherwise Back from the next page lands on a dead
 * same-page entry. Use `useOverlayNavigate`, `OverlayLink` or `OverlayNavLink`.
 */
const OverlayEntryContext = createContext(false);

export function OverlayEntry({ active, children }: { active: boolean; children: ReactNode }) {
  const outer = useContext(OverlayEntryContext);
  return <OverlayEntryContext.Provider value={active || outer}>{children}</OverlayEntryContext.Provider>;
}

export function useInOverlayEntry(): boolean {
  return useContext(OverlayEntryContext);
}

/** `navigate` that replaces while inside an overlay entry (an explicit `replace` option wins). */
export function useOverlayNavigate(): (to: To, options?: NavigateOptions) => void {
  const navigate = useNavigate();
  const inOverlay = useInOverlayEntry();
  return useCallback((to, options) => {
    if (inOverlay) navigate(to, { ...options, replace: options?.replace ?? true });
    else if (options) navigate(to, options);
    else navigate(to);
  }, [navigate, inOverlay]);
}

export function OverlayLink(props: LinkProps) {
  const inOverlay = useInOverlayEntry();
  return <Link {...props} replace={props.replace ?? (inOverlay || undefined)} />;
}

/** The one NavLink for drawer / palette destinations (never passes `replace={false}`: that would stop same-URL clicks replacing). */
export function OverlayNavLink(props: NavLinkProps) {
  const inOverlay = useInOverlayEntry();
  return <NavLink {...props} replace={props.replace ?? (inOverlay || undefined)} />;
}
