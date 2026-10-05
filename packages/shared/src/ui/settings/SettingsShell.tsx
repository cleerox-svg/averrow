// @averrow/shared/ui/settings — SettingsShell (ACCOUNT_DESIGN_SPEC §2)
//
// One layout, two shapes, same routes:
//   >= 1024px  sticky 232px rail (sidebar-style active treatment + 3px amber
//              bar) beside the pane.
//   <  1024px  iOS-Settings list -> detail. Home (activeId === null) shows the
//              `home` slot + the grouped section list; a section shows a sticky
//              "‹ Settings" back header, a large title and the pane. Screen
//              changes run through the View Transition API when available
//              (slide; cross-fade under prefers-reduced-motion) with an
//              opacity/translate fallback.
//
// Router-agnostic: the shell only knows hrefs. Pass `renderLink` to mount a
// router <Link> (react-router in ops), or `onNavigate` to keep plain anchors but
// route in JS. `basePath` is wherever the host mounts it ("/settings", ...).
//
// View Transitions need the route change to happen INSIDE startViewTransition's
// callback (after the old snapshot, before the new one). So the slide only runs
// when `onNavigate` is supplied: the shell intercepts plain left-clicks
// (preventDefault, which router <Link>s honour), then calls onNavigate(href)
// inside the callback. `renderLink` WITHOUT `onNavigate` navigates by itself
// before we could snapshot, so that combination skips the transition and uses
// the CSS enter animation instead.
// Switching between home and a section is the host's job (it owns the URL and
// passes the resulting `activeId`).

import {
  useEffect, useId, useLayoutEffect, useRef, useState,
  type MouseEvent, type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import { Badge } from '../Badge';
import { cn } from '../cn';
import { PageHeader } from '../PageHeader';
import { SettingsGroup } from './SettingsGroup';
import { SettingsRow } from './SettingsRow';
import { IconTile, type IconTileTone } from './IconTile';
import { ChevronLeftIcon } from './icons';
import { defaultRenderLink, type SettingsRenderLink } from './types';
import { useMediaQuery } from './useMediaQuery';

export interface SettingsSection {
  id: string;
  label: string;
  /** One-line summary shown under the label in the mobile list. */
  description?: string;
  /** Inline `<svg>` glyph (rendered inside the tinted tile). */
  icon: ReactNode;
  tone?: IconTileTone;
  /** Group heading ("Account", "Preferences"). Sections sharing a value are grouped, in first-seen order. */
  group?: string;
  /** Count badge (rail + list). Hidden when 0/empty/undefined. */
  badge?: number | string;
  /** Override; default `${basePath}/${id}`. */
  href?: string;
}

export interface SettingsShellProps {
  sections: SettingsSection[];
  /** Current section id, or null for the home list (mobile). */
  activeId: string | null;
  basePath: string;
  /** Desktop page title / mobile home large title. Default "Settings". */
  title?: string;
  subtitle?: string;
  /** Back-link label on mobile detail. Default = `title`. */
  homeLabel?: string;
  /** Mobile home: rendered under the title, above the list (e.g. compact AccountHero). */
  home?: ReactNode;
  /** Mobile home: rendered under the list (Sign out row, version line). */
  homeFooter?: ReactNode;
  /** Desktop rail footer (e.g. ghost "Sign out"). */
  railFooter?: ReactNode;
  /** Mount a router Link. Default: plain `<a>`. */
  renderLink?: SettingsRenderLink;
  /** With the default anchor: called (and the click prevented) for plain left-clicks. */
  onNavigate?: (href: string) => void;
  /** Accessible name of the rail `<nav>`. Default "Settings sections". */
  navLabel?: string;
  /** `auto` follows the 1024px breakpoint; force a layout for tests/embeds. */
  layout?: 'auto' | 'desktop' | 'mobile';
  /** The active section's content. */
  children?: ReactNode;
  className?: string;
}

const DESKTOP_QUERY = '(min-width: 1024px)';

type ViewTransitionDoc = Document & {
  startViewTransition?: (cb: () => Promise<void> | void) => { finished: Promise<unknown> };
};

const hasBadge = (b: SettingsSection['badge']) => b !== undefined && b !== null && b !== 0 && b !== '';

function groupSections(sections: SettingsSection[]): Array<{ label: string | null; items: SettingsSection[] }> {
  const out: Array<{ label: string | null; items: SettingsSection[] }> = [];
  for (const s of sections) {
    const label = s.group ?? null;
    let g = out.find((x) => x.label === label);
    if (!g) { g = { label, items: [] }; out.push(g); }
    g.items.push(s);
  }
  return out;
}

export function SettingsShell({
  sections, activeId, basePath, title = 'Settings', subtitle, homeLabel, home, homeFooter, railFooter,
  renderLink, onNavigate, navLabel = 'Settings sections', layout = 'auto', children, className,
}: SettingsShellProps) {
  const uid = useId();
  const mqDesktop = useMediaQuery(DESKTOP_QUERY, true);
  const isDesktop = layout === 'auto' ? mqDesktop : layout === 'desktop';
  const root = basePath.replace(/\/+$/, '');
  const hrefFor = (s: SettingsSection) => s.href ?? `${root}/${s.id}`;
  const homeHref = root || '/';
  const groups = groupSections(sections);
  const active = sections.find((s) => s.id === activeId) ?? null;

  // ── mobile screen transitions (View Transition API; router-agnostic) ──
  const pending = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    // The host committed the new route: let the "new" snapshot be taken.
    pending.current?.();
    pending.current = null;
  }, [activeId]);

  const supportsVT = typeof document !== 'undefined' && typeof (document as ViewTransitionDoc).startViewTransition === 'function';
  // Only a host-controlled navigation can be placed inside the transition callback.
  const canTransition = supportsVT && !!onNavigate;

  const navigateWithTransition = (href: string, direction: 'forward' | 'back') => {
    const doc = document as ViewTransitionDoc;
    const html = document.documentElement;
    html.setAttribute('data-ds-nav', direction);
    const t = doc.startViewTransition!(() => new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => { if (timer) clearTimeout(timer); resolve(); };
      pending.current = done;
      timer = setTimeout(done, 600); // never hang the page if the route doesn't change
      // The route change happens here: the old snapshot is already taken.
      flushSync(() => onNavigate?.(href));
    }));
    void Promise.resolve(t.finished).catch(() => undefined).then(() => html.removeAttribute('data-ds-nav'));
  };

  const handleClick = (e: MouseEvent<HTMLElement>, href: string) => {
    if (e.defaultPrevented) return;
    const plain = e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
    if (!plain || !onNavigate) return;
    e.preventDefault(); // anchors and router Links both skip their own navigation
    if (!isDesktop && canTransition) navigateWithTransition(href, href === homeHref ? 'back' : 'forward');
    else onNavigate(href);
  };

  /** Single link factory: the host's renderer (or <a>) + our click handling. */
  const linkRenderer: SettingsRenderLink = (p) =>
    (renderLink ?? defaultRenderLink)({
      ...p,
      onClick: (e) => { p.onClick?.(e); handleClick(e, p.href); },
    });

  const largeRef = useRef<HTMLHeadingElement | null>(null);
  // New screen on mobile: move focus to its title so screen readers announce it.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    if (isDesktop) return;
    largeRef.current?.focus({ preventScroll: true });
  }, [activeId, isDesktop]);

  // Small bar title fades in once the large title scrolls under the bar.
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const el = largeRef.current;
    if (isDesktop || !el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      ([entry]) => setScrolled(!!entry && !entry.isIntersecting),
      { rootMargin: '-56px 0px 0px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [isDesktop, activeId]);

  // ── desktop: rail + pane ──
  if (isDesktop) {
    return (
      <div className={cn('ds-sshell', className)} data-layout="desktop">
        <PageHeader title={title} subtitle={subtitle} />
        <div className="ds-sshell--desktop">
          <div className="ds-rail">
            <nav aria-label={navLabel} className="flex flex-col gap-5">
              {groups.map((g, gi) => {
                const gid = `${uid}-g${gi}`;
                return (
                  <div key={g.label ?? `__${gi}`}>
                    {g.label && <p id={gid} className="ds-rail-grp">{g.label}</p>}
                    <ul className="ds-rail-list" aria-labelledby={g.label ? gid : undefined}>
                      {g.items.map((s) => (
                        <li key={s.id}>
                          {linkRenderer({
                            href: hrefFor(s),
                            className: 'ds-rail-item',
                            'aria-current': s.id === activeId ? 'page' : undefined,
                            children: (
                              <>
                                <IconTile size={28} tone={s.tone ?? 'neutral'}>{s.icon}</IconTile>
                                <span className="ds-rail-label">{s.label}</span>
                                {hasBadge(s.badge) && <Badge severity="medium" size="md" label={String(s.badge)} />}
                              </>
                            ),
                          })}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </nav>
            {railFooter && <div className="ds-rail-foot">{railFooter}</div>}
          </div>
          <div className="min-w-0">{children}</div>
        </div>
      </div>
    );
  }

  // ── mobile: detail ──
  if (activeId !== null) {
    const label = active?.label ?? title;
    return (
      <div className={cn('ds-sshell', className)} data-layout="mobile" data-screen="detail">
        <div key={`detail-${activeId}`} className={cn('ds-sshell-screen', !(canTransition && !isDesktop) && 'ds-sshell-screen--fallback')}>
          <div className="ds-sshell-bar" data-scrolled={scrolled ? 'true' : 'false'}>
            {linkRenderer({
              href: homeHref,
              className: 'ds-sshell-back',
              children: (<><ChevronLeftIcon /><span>{homeLabel ?? title}</span></>),
            })}
            <span aria-hidden="true" className="ds-sshell-bartitle">{label}</span>
            <span />
          </div>
          <div className="ds-sshell-detail">
            <h1 ref={largeRef} tabIndex={-1} className="ds-sshell-large">{label}</h1>
            {children}
          </div>
        </div>
      </div>
    );
  }

  // ── mobile: home list ──
  return (
    <div className={cn('ds-sshell', className)} data-layout="mobile" data-screen="home">
      <div key="home" className={cn('ds-sshell-screen ds-sshell-home', !(canTransition && !isDesktop) && 'ds-sshell-screen--fallback')}>
        <h1 ref={largeRef} tabIndex={-1} className="ds-sshell-large">{title}</h1>
        {home && <div className="mb-6">{home}</div>}
        {groups.map((g, gi) => (
          <SettingsGroup key={g.label ?? `__${gi}`} title={g.label ?? undefined} aria-label={g.label ? undefined : title}>
            {g.items.map((s) => (
              <SettingsRow
                key={s.id}
                variant="link"
                href={hrefFor(s)}
                renderLink={linkRenderer}
                icon={s.icon}
                tone={s.tone ?? 'neutral'}
                title={s.label}
                description={s.description}
                trailing={hasBadge(s.badge) ? <Badge severity="medium" size="md" label={String(s.badge)} /> : undefined}
              />
            ))}
          </SettingsGroup>
        ))}
        {homeFooter}
      </div>
    </div>
  );
}
