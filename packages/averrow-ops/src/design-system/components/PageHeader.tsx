// Ops PageHeader adapter.
//
// Thin wrapper over the shared kit PageHeader (`@averrow/shared/ui`), which has
// no router dependency. It maps the ops `back` contract onto the kit's
// `href` / `onClick`; everything else (embedded-in-workspace h1 suppression,
// badge / meta / actions) is the shared component's behaviour.
//
// Prefer `back.fallback`: the control renders as a real link to `fallback`
// (open in new tab / copy link work), and a plain click goes Back to the
// previous in-app screen, only landing on `fallback` when there is none (cold
// deep link, push open). `to` is the legacy fixed-target form.

import type { MouseEvent } from 'react';
import { useHref, useNavigate } from 'react-router-dom';
import { useBack } from '@averrow/shared/nav';
import { PageHeader as SharedPageHeader, type PageHeaderProps as SharedPageHeaderProps } from '@averrow/shared/ui';

export interface PageHeaderProps extends Omit<SharedPageHeaderProps, 'back'> {
  back?: {
    label: string;
    /** Parent path used when there is no previous in-app screen. */
    fallback?: string;
    /** Legacy: fixed in-app path to navigate to. Prefer `fallback`. */
    to?: string;
    /** Wins over `fallback` and `to` when given. */
    onClick?: () => void;
  };
}

export function PageHeader({ back, ...rest }: PageHeaderProps) {
  const navigate = useNavigate();
  const fallback = back?.fallback;
  const to = back?.to;
  const { go } = useBack(fallback ?? to ?? '/');
  const href = useHref(fallback ?? '/');

  if (!back) return <SharedPageHeader {...rest} back={undefined} />;

  if (!back.onClick && fallback) {
    const onClick = (e: MouseEvent<HTMLElement>) => {
      // Let the browser handle modified clicks (new tab, copy link).
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      go();
    };
    // The kit types onClick as `() => void` but passes the click event through to the <a>.
    return <SharedPageHeader {...rest} back={{ label: back.label, href, onClick: onClick as unknown as () => void }} />;
  }

  const onClick = back.onClick ?? (to ? () => navigate(to) : undefined);
  return <SharedPageHeader {...rest} back={{ label: back.label, onClick }} />;
}
