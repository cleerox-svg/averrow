import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Shell } from './Shell';

// Off-canvas drawer behaviour of the tenant shell below the `md` breakpoint.
// jsdom has no layout/CSS, so these assert the observable contract: ARIA
// state, focus, inert, scroll lock and the close paths — not Tailwind classes.

vi.mock('@/lib/auth', () => ({
  useAuth: vi.fn(() => ({
    user: {
      id: 'u1', email: 'jane@acme.test', name: 'Jane Doe', display_name: 'Jane Doe',
      organization: { id: 'org1', name: 'Acme', role: 'admin', plan: 'professional' },
    },
    loading: false,
    logout: vi.fn(),
  })),
}));
vi.mock('@/lib/modules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/modules')>();
  return { ...actual, useTenantModules: () => ({ data: { modules: [] }, isLoading: false }) };
});
vi.mock('@/lib/auditLog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auditLog')>();
  return { ...actual, useCanViewAudit: () => false };
});
vi.mock('@/lib/useTheme', () => ({
  useTheme: () => ({ theme: 'dark', cycle: vi.fn() }),
}));

type MqListener = (e: { matches: boolean }) => void;
let mqListeners: Set<MqListener>;
let mqQueries: string[];

function installMatchMedia() {
  mqListeners = new Set();
  mqQueries = [];
  window.matchMedia = vi.fn((query: string) => {
    mqQueries.push(query);
    return {
      matches: false,
      media: query,
      addEventListener: (_: string, l: MqListener) => mqListeners.add(l),
      removeEventListener: (_: string, l: MqListener) => mqListeners.delete(l),
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    };
  }) as unknown as typeof window.matchMedia;
}

let navigateTo: (to: string) => void;
function NavProbe() {
  const navigate = useNavigate();
  navigateTo = (to) => navigate(to);
  return null;
}

function renderShell(initial = '/console') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <NavProbe />
        <Routes>
          <Route element={<Shell />}>
            <Route path="*" element={<div>page content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// The aside's own close button is the one inside the sidebar.
const aside = (c: HTMLElement) => c.querySelector('aside#tenant-sidebar') as HTMLElement;
const closeBtn = (c: HTMLElement) =>
  aside(c).querySelector('button[aria-label="Close navigation"]') as HTMLButtonElement;
const scrim = (c: HTMLElement) => c.querySelector('div[aria-hidden="true"].fixed.inset-0') as HTMLElement | null;

describe('tenant Shell mobile navigation drawer', () => {
  beforeEach(() => {
    installMatchMedia();
    document.body.style.overflow = '';
  });
  afterEach(() => {
    document.body.style.overflow = '';
  });

  it('hamburger starts closed, opens the drawer and reflects it in aria-expanded', async () => {
    const user = userEvent.setup();
    const { container } = renderShell();
    const btn = screen.getByRole('button', { name: 'Open navigation' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(btn).toHaveAttribute('aria-controls', 'tenant-sidebar');

    await user.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');

    await user.click(closeBtn(container));
    expect(btn).toHaveAttribute('aria-expanded', 'false');
  });

  it('aside is a modal dialog only while open', async () => {
    const user = userEvent.setup();
    const { container } = renderShell();
    const a = aside(container);
    expect(a).not.toHaveAttribute('role');
    expect(a).not.toHaveAttribute('aria-modal');

    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(a).toHaveAttribute('role', 'dialog');
    expect(a).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('dialog', { name: 'Main navigation' })).toBe(a);

    await user.click(closeBtn(container));
    expect(a).not.toHaveAttribute('role');
    expect(a).not.toHaveAttribute('aria-modal');
  });

  it('renders the scrim only while open', async () => {
    const user = userEvent.setup();
    const { container } = renderShell();
    expect(scrim(container)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(scrim(container)).not.toBeNull();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const { container } = renderShell();
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(aside(container)).toHaveAttribute('role', 'dialog');
    await user.keyboard('{Escape}');
    expect(aside(container)).not.toHaveAttribute('role');
    expect(screen.getByRole('button', { name: 'Open navigation' })).toBeInTheDocument();
  });

  it('ignores other keys while open', async () => {
    const user = userEvent.setup();
    const { container } = renderShell();
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    await user.keyboard('a');
    expect(aside(container)).toHaveAttribute('role', 'dialog');
  });

  it('closes on scrim click', async () => {
    const user = userEvent.setup();
    const { container } = renderShell();
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    await user.click(scrim(container)!);
    expect(aside(container)).not.toHaveAttribute('role');
    expect(scrim(container)).toBeNull();
  });

  it('closes on the drawer close button', async () => {
    const user = userEvent.setup();
    const { container } = renderShell();
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    await user.click(closeBtn(container));
    expect(aside(container)).not.toHaveAttribute('role');
  });

  it('closes on route change', async () => {
    const user = userEvent.setup();
    const { container } = renderShell('/console');
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(aside(container)).toHaveAttribute('role', 'dialog');
    act(() => navigateTo('/threats'));
    expect(aside(container)).not.toHaveAttribute('role');
  });

  it('closes when tapping a link to a different page', async () => {
    const user = userEvent.setup();
    const { container } = renderShell('/console');
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    await user.click(screen.getByRole('link', { name: 'Threats' }));
    expect(aside(container)).not.toHaveAttribute('role');
  });

  it('closes when tapping the link of the page you are already on (no route change)', async () => {
    const user = userEvent.setup();
    const { container } = renderShell('/console');
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    const current = screen.getByRole('link', { name: 'Console' });
    expect(current).toHaveAttribute('aria-current', 'page');
    await user.click(current);
    expect(aside(container)).not.toHaveAttribute('role');
  });

  it('does not close when tapping a non-link area of the nav', async () => {
    const user = userEvent.setup();
    const { container } = renderShell('/console');
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    await user.click(screen.getByText('Workspace'));
    expect(aside(container)).toHaveAttribute('role', 'dialog');
  });

  it('makes page content inert and locks body scroll while open, restoring both on close', async () => {
    const user = userEvent.setup();
    document.body.style.overflow = 'auto';
    const { container } = renderShell();
    const main = screen.getByRole('main');
    const wrapper = main.parentElement as HTMLElement;
    expect(wrapper.inert).toBeFalsy();

    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(wrapper.inert).toBe(true);
    expect(wrapper).toContainElement(main);
    expect(wrapper).not.toContainElement(aside(container));
    expect(document.body.style.overflow).toBe('hidden');

    await user.click(closeBtn(container));
    expect(wrapper.inert).toBeFalsy();
    // Restores the previous value, not just ''.
    expect(document.body.style.overflow).toBe('auto');
  });

  it('restores body scroll and inert when unmounted while open', async () => {
    const user = userEvent.setup();
    const { unmount } = renderShell();
    const wrapper = screen.getByRole('main').parentElement as HTMLElement;
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('');
    expect(wrapper.inert).toBeFalsy();
  });

  it('moves focus to the drawer close button on open', async () => {
    const user = userEvent.setup();
    const { container } = renderShell();
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(closeBtn(container)).toHaveFocus();
  });

  it.each([
    ['close button', async (c: HTMLElement, u: ReturnType<typeof userEvent.setup>) => { await u.click(closeBtn(c)); }],
    ['Escape', async (_c: HTMLElement, u: ReturnType<typeof userEvent.setup>) => { await u.keyboard('{Escape}'); }],
    ['scrim', async (c: HTMLElement, u: ReturnType<typeof userEvent.setup>) => { await u.click(scrim(c)!); }],
  ])('returns focus to the hamburger when closed via %s', async (_name, close) => {
    const user = userEvent.setup();
    const { container } = renderShell();
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    await close(container, user);
    expect(screen.getByRole('button', { name: 'Open navigation' })).toHaveFocus();
  });

  it('does not steal focus on initial mount', () => {
    renderShell();
    expect(screen.getByRole('button', { name: 'Open navigation' })).not.toHaveFocus();
  });

  it('closes when (min-width: 768px) media query fires change with matches=true', async () => {
    const user = userEvent.setup();
    const { container } = renderShell();
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(mqQueries).toContain('(min-width: 768px)');
    expect(mqListeners.size).toBe(1);

    act(() => mqListeners.forEach((l) => l({ matches: true })));
    expect(aside(container)).not.toHaveAttribute('role');
  });

  it('stays open when the media query changes to matches=false', async () => {
    const user = userEvent.setup();
    const { container } = renderShell();
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    act(() => mqListeners.forEach((l) => l({ matches: false })));
    expect(aside(container)).toHaveAttribute('role', 'dialog');
  });

  it('removes the media query listener once closed', async () => {
    const user = userEvent.setup();
    const { container } = renderShell();
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(mqListeners.size).toBe(1);
    await user.click(closeBtn(container));
    expect(mqListeners.size).toBe(0);
  });
});
