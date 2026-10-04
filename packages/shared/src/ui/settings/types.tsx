import type { ReactElement, ReactNode, MouseEvent } from 'react';

/**
 * Props the settings kit hands to a consumer-supplied link renderer so a
 * router `<Link>` (react-router in ops, tenant's router) can be mounted
 * without the kit importing a router.
 *
 *   renderLink={(p) => <Link to={p.href} className={p.className} onClick={p.onClick}
 *                            aria-current={p['aria-current']}>{p.children}</Link>}
 */
export interface SettingsLinkRenderProps {
  href: string;
  className: string;
  children: ReactNode;
  'aria-current'?: 'page';
  'aria-disabled'?: boolean;
  tabIndex?: number;
  /** Must be forwarded (it also drives the mobile view transition). */
  onClick?: (e: MouseEvent<HTMLElement>) => void;
}

export type SettingsRenderLink = (props: SettingsLinkRenderProps) => ReactElement;

/** Default renderer: a plain anchor. */
export const defaultRenderLink: SettingsRenderLink = (p) => (
  <a
    href={p.href}
    className={p.className}
    aria-current={p['aria-current']}
    aria-disabled={p['aria-disabled']}
    tabIndex={p.tabIndex}
    onClick={p.onClick}
  >
    {p.children}
  </a>
);
