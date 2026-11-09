import { useEffect } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { MemoryRouter, useNavigate, useLocation } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PageHeader } from '@averrow/shared/ui';
import { TabbedWorkspace, type WorkspaceTab } from './TabbedWorkspace';

const A = () => <div>pane-a</div>;
const B = () => <div>pane-b</div>;
const WithHeader = () => <PageHeader title="Pane title" subtitle="pane sub" actions={<button>act</button>} />;
const TABS: WorkspaceTab[] = [
  { id: 'a', label: 'A', Component: A },
  { id: 'b', label: 'B', Component: B },
];

let go: (to: string) => void = () => {};
function Loc() { const l = useLocation(); return <div data-testid="loc">{l.pathname + l.search}</div>; }
let mounts = 0;
const Counter = () => { useEffect(() => { mounts++; }, []); return <div>counter</div>; };
function Nav() { const n = useNavigate(); go = (to) => n(to); return null; }

describe('TabbedWorkspace', () => {
  it('follows ?tab= changes without a remount and falls back for unknown ids', async () => {
    render(
      <MemoryRouter initialEntries={['/w?tab=b']}>
        <Nav />
        <TabbedWorkspace crumb="X" title="W" tabs={TABS} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('pane-b')).toBeInTheDocument();
    act(() => go('/w?tab=a'));
    expect(await screen.findByText('pane-a')).toBeInTheDocument();
    act(() => go('/w?tab=nope'));
    expect(await screen.findByText('pane-a')).toBeInTheDocument();
  });

  it('switching tabs carries only ?tab= (no q/focus leak)', async () => {
    render(
      <MemoryRouter initialEntries={['/w?tab=a&q=acme&focus=x']}>
        <TabbedWorkspace crumb="X" title="W" tabs={TABS} />
        <Loc />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'B' }));
    expect(screen.getByTestId('loc').textContent).toBe('/w?tab=b');
    fireEvent.click(screen.getByRole('tab', { name: 'A' }));
    expect(screen.getByTestId('loc').textContent).toBe('/w');
  });

  it('remounts the active pane when ?q= changes', async () => {
    mounts = 0;
    const tabs: WorkspaceTab[] = [{ id: 'c', label: 'C', Component: Counter }];
    render(
      <MemoryRouter initialEntries={['/w?q=one']}>
        <Nav />
        <TabbedWorkspace crumb="X" title="W" tabs={tabs} />
      </MemoryRouter>,
    );
    await screen.findByText('counter');
    const before = mounts;
    act(() => go('/w?q=two'));
    expect(mounts).toBe(before + 1);
  });

  it('embedded tab renders exactly one h1 and keeps page actions', async () => {
    const tabs: WorkspaceTab[] = [{ id: 'h', label: 'H', Component: WithHeader }];
    render(
      <MemoryRouter initialEntries={['/w']}>
        <TabbedWorkspace crumb="X" title="Workspace" tabs={tabs} />
      </MemoryRouter>,
    );
    await screen.findByText('act');
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent('Workspace');
    expect(screen.queryByText('pane sub')).not.toBeInTheDocument();
  });

  it('renders a caps-authored crumb in sentence case', () => {
    render(
      <MemoryRouter initialEntries={['/w']}>
        <TabbedWorkspace crumb="PLATFORM" title="Workspace" tabs={TABS} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Platform')).toHaveClass('console-crumb');
    expect(screen.queryByText('PLATFORM')).not.toBeInTheDocument();
  });

  it('uses the kit Tabs (real tablist, arrow keys), with no looping LIVE indicator', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/w?tab=b']}>
        <TabbedWorkspace crumb="Platform" title="Workspace" tabs={TABS} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('tablist', { name: 'Workspace sections' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map(t => t.textContent)).toEqual(['A', 'B']);
    expect(screen.getByRole('tab', { name: 'B' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'A' })).toHaveAttribute('aria-selected', 'false');
    expect(container.querySelector('.console-live, .console-tabs')).toBeNull();
    expect(screen.queryByText('LIVE')).not.toBeInTheDocument();
  });

  it('source and stylesheet carry no looping dot or button-row tabs', () => {
    const src = readFileSync(resolve(__dirname, 'TabbedWorkspace.tsx'), 'utf8');
    expect(src).not.toMatch(/console-live|console-tabs|variant="primary"/);
    const css = readFileSync(resolve(__dirname, '../../features/console/console.css'), 'utf8');
    expect(css).not.toMatch(/console-live|console-ping|\.console-tabs\b/);
    // no KPI row between the title and the tab bar: keep a gap
    expect(css).toMatch(/\.console-head \+ \.console-tabbar \{ margin-top: 12px; \}/);
  });
});
