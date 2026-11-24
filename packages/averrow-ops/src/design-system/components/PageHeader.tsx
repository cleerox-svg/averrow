// Ops PageHeader adapter.
//
// Thin wrapper over the shared kit PageHeader (`@averrow/shared/ui`), which has
// no router dependency. It maps the ops `back` contract onto the kit's
// `onClick`; everything else (embedded-in-workspace h1 suppression,
// badge / meta / actions) is the shared component's behaviour.
//
// Prefer `back.fallback`: Back returns to the previous in-app screen and only
// goes to `fallback` when there is none (cold deep link, push open). `to` is the
// legacy fixed-target form and always navigates there.

import { useNavigate } from 'react-router-dom';
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
  const onClick = back?.onClick ?? (fallback ? go : to ? () => navigate(to) : undefined);
  return <SharedPageHeader {...rest} back={back ? { label: back.label, onClick } : undefined} />;
}
