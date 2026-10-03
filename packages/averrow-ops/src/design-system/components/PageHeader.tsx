// Ops PageHeader adapter.
//
// Thin wrapper over the shared kit PageHeader (`@averrow/shared/ui`), which has
// no router dependency. It keeps the ops `back.to` contract by mapping it to a
// `navigate()` call; everything else (embedded-in-workspace h1 suppression,
// badge / meta / actions) is the shared component's behaviour.

import { useNavigate } from 'react-router-dom';
import { PageHeader as SharedPageHeader, type PageHeaderProps as SharedPageHeaderProps } from '@averrow/shared/ui';

export interface PageHeaderProps extends Omit<SharedPageHeaderProps, 'back'> {
  back?: {
    label: string;
    /** In-app path to navigate to. `onClick` wins when both are given. */
    to?: string;
    onClick?: () => void;
  };
}

export function PageHeader({ back, ...rest }: PageHeaderProps) {
  const navigate = useNavigate();
  const to = back?.to;
  const onClick = back?.onClick ?? (to ? () => navigate(to) : undefined);
  return <SharedPageHeader {...rest} back={back ? { label: back.label, onClick } : undefined} />;
}
