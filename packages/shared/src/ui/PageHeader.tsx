import * as React from 'react';
import { cn } from './cn';

// When a page renders inside a workspace (TabbedWorkspace) the workspace owns
// the view's single <h1>. Pages using this PageHeader read the context and
// drop their own title/subtitle, keeping badge/meta/actions.
const WorkspaceEmbedContext = React.createContext(false);
WorkspaceEmbedContext.displayName = 'WorkspaceEmbedContext';

export { WorkspaceEmbedContext };

export function WorkspaceEmbedProvider({ value = true, children }: { value?: boolean; children: React.ReactNode }) {
  return <WorkspaceEmbedContext.Provider value={value}>{children}</WorkspaceEmbedContext.Provider>;
}

export function useWorkspaceEmbed(): boolean {
  return React.useContext(WorkspaceEmbedContext);
}

export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  /** Back control: `<a>` when `href` is given, otherwise a `<button>`. */
  back?: { label: string; onClick?: () => void; href?: string };
  actions?: React.ReactNode;
  /** `mono` (default, dashboard pages) or `sans` 14px (settings/inbox, matches the "‹ Settings" back link). */
  backFont?: 'mono' | 'sans';
  /** Badge next to the title (e.g. BETA). */
  badge?: React.ReactNode;
  /** Status line below the title. */
  meta?: React.ReactNode;
  className?: string;
  /** Force embedded mode (no h1/subtitle). Context also enables it. */
  embedded?: boolean;
}

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--amber)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-page)]';

export function PageHeader({ title, subtitle, back, backFont = 'mono', actions, badge, meta, className, embedded }: PageHeaderProps) {
  const ctxEmbedded = useWorkspaceEmbed();
  const isEmbedded = embedded ?? ctxEmbedded;

  const backClass = cn(
    'mb-3 inline-flex items-center gap-1.5 rounded text-[var(--text-secondary)] hover:text-[var(--amber-text)] bg-transparent border-0 p-0 cursor-pointer no-underline',
    backFont === 'sans' ? 'font-sans text-[14px] font-medium' : 'font-mono text-[12px] tracking-[0.06em]',
    FOCUS_RING,
  );
  const backContent = <><span aria-hidden="true">←</span> {back?.label}</>;

  const hasTitleBlock = !isEmbedded || !!badge || !!meta;

  return (
    <div className={cn('mb-5', className)}>
      {back && (back.href
        ? <a href={back.href} onClick={back.onClick} className={backClass}>{backContent}</a>
        : <button type="button" onClick={back.onClick} className={backClass}>{backContent}</button>)}

      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2.5">
        {hasTitleBlock && (
          <div className="min-w-0 flex-[1_1_260px]">
            {(!isEmbedded || badge) && (
              <div className="flex flex-wrap items-center gap-2.5">
                {!isEmbedded && (
                  <h1 className="m-0 text-2xl font-black leading-[1.1] tracking-[-0.5px] text-[var(--text-primary)]">{title}</h1>
                )}
                {badge && <div className="shrink-0">{badge}</div>}
              </div>
            )}
            {!isEmbedded && subtitle && (
              <p className="mt-1.5 text-[13px] leading-normal text-[var(--text-secondary)]">{subtitle}</p>
            )}
            {meta && (
              <div className="mt-1.5 flex items-center gap-2 font-mono text-[12px] text-[var(--text-tertiary)]">{meta}</div>
            )}
          </div>
        )}
        {actions && (
          <div className={cn('flex max-w-full flex-wrap items-center gap-2 pt-0.5', !hasTitleBlock && 'ml-auto')}>{actions}</div>
        )}
      </div>
    </div>
  );
}
