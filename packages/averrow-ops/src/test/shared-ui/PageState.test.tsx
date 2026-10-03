import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PageState, pageStateKind } from '@averrow/shared/ui';

describe('pageStateKind', () => {
  it.each([
    [{ isError: true, isLoading: true, isEmpty: true }, 'error'],
    [{ isError: true, isEmpty: true }, 'error'],
    [{ isError: true }, 'error'],
    [{ isLoading: true, isEmpty: true }, 'loading'],
    [{ isLoading: true }, 'loading'],
    [{ isEmpty: true }, 'empty'],
    [{}, null],
    [{ isLoading: false, isError: false, isEmpty: false }, null],
  ] as const)('%j -> %s', (input, expected) => {
    expect(pageStateKind(input)).toBe(expected);
  });
});

describe('PageState roles', () => {
  it('error is role=alert', () => {
    render(<PageState kind="error" />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it.each(['page', 'card', 'table', 'inline'] as const)('loading (%s) is role=status + aria-busy with sr-only "Loading…"', (layout) => {
    render(<PageState kind="loading" layout={layout} />);
    const el = screen.getByRole('status');
    expect(el).toHaveAttribute('aria-busy', 'true');
    expect(el).toHaveTextContent('Loading…');
  });

  it('loading honours a custom title for the sr-only text', () => {
    render(<PageState kind="loading" title="Loading notifications…" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading notifications…');
  });

  it.each(['empty', 'clear', 'locked'] as const)('%s is role=status without aria-busy', (kind) => {
    render(<PageState kind={kind} />);
    const el = screen.getByRole('status');
    expect(el).not.toHaveAttribute('aria-busy');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('inline error is the polite stale-data banner (role=status), not an alert', () => {
    render(<PageState kind="error" layout="inline" />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('inline error with `assertive` (no data on screen) stays role=alert', () => {
    render(<PageState kind="error" layout="inline" assertive />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it.each(['page', 'card', 'table'] as const)('blocking error (%s) stays role=alert', (layout) => {
    render(<PageState kind="error" layout={layout} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});

describe('PageState content', () => {
  it('default error copy never claims there is nothing / no results', () => {
    render(<PageState kind="error" />);
    const text = screen.getByRole('alert').textContent ?? '';
    expect(text).not.toMatch(/nothing|no results|no data|empty/i);
    expect(text).toMatch(/couldn't load/i);
  });

  it('uses custom title and description', () => {
    render(<PageState kind="empty" title="Inbox zero." description="No notifications waiting for you." />);
    expect(screen.getByText('Inbox zero.')).toBeInTheDocument();
    expect(screen.getByText('No notifications waiting for you.')).toBeInTheDocument();
  });

  it('shows Try again only for error, and calls onRetry', async () => {
    const onRetry = vi.fn();
    const { rerender } = render(<PageState kind="error" onRetry={onRetry} />);
    await userEvent.setup().click(screen.getByRole('button', { name: /^Try again/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    for (const kind of ['empty', 'clear', 'locked', 'loading'] as const) {
      rerender(<PageState kind={kind} onRetry={onRetry} />);
      expect(screen.queryByRole('button', { name: /^Try again/ })).not.toBeInTheDocument();
    }
  });

  it('the retry button name includes the title so several error cards stay distinguishable', async () => {
    const a = vi.fn(); const b = vi.fn();
    render(
      <>
        <PageState kind="error" layout="card" title="Couldn't load brands" onRetry={a} />
        <PageState kind="error" layout="card" title="Couldn't load feeds" onRetry={b} />
      </>,
    );
    expect(screen.getAllByRole('button', { name: /^Try again/ })).toHaveLength(2);
    await userEvent.setup().click(screen.getByRole('button', { name: "Try again: Couldn't load feeds" }));
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
  });

  it('no Try again button when onRetry is omitted', () => {
    render(<PageState kind="error" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders an action spec as a button and a node as-is', async () => {
    const onClick = vi.fn();
    const { rerender } = render(<PageState kind="empty" action={{ label: 'Add brand', onClick }} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Add brand' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(<PageState kind="empty" action={<a href="/x">Go</a>} />);
    expect(screen.getByRole('link', { name: 'Go' })).toBeInTheDocument();
  });

  it('renders secondaryAction', () => {
    render(<PageState kind="empty" secondaryAction={{ label: 'Learn more', onClick: () => {} }} />);
    expect(screen.getByRole('button', { name: 'Learn more' })).toBeInTheDocument();
  });

  it('decorative icon is aria-hidden', () => {
    const { container } = render(<PageState kind="clear" />);
    expect(container.querySelector('svg')?.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  // Ported from the retired ops EmptyState tests (title/description/action/
  // secondaryAction/icon/compact), minus its variant colour classes.
  it('renders a custom icon, and hides the icon with icon={null}', () => {
    const { rerender } = render(<PageState kind="empty" icon={<span data-testid="test-icon">i</span>} />);
    expect(screen.getByTestId('test-icon')).toBeInTheDocument();
    rerender(<PageState kind="empty" icon={null} />);
    expect(screen.queryByTestId('test-icon')).not.toBeInTheDocument();
    expect(document.querySelector('svg')).toBeNull();
  });

  it('secondaryAction click fires its handler', async () => {
    const onClick = vi.fn();
    render(
      <PageState
        kind="empty"
        action={{ label: 'Primary', onClick: vi.fn() }}
        secondaryAction={{ label: 'Secondary', onClick }}
      />,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Secondary' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('no action buttons unless an action or onRetry is given', () => {
    render(<PageState kind="empty" title="Empty" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('is centred, and compact uses tighter padding than the default', () => {
    const { container, rerender } = render(<PageState kind="empty" />);
    const root = container.firstChild as HTMLElement;
    expect(root).toHaveClass('flex', 'items-center', 'justify-center', 'py-16');
    rerender(<PageState kind="empty" compact />);
    expect(container.firstChild).toHaveClass('py-8');
    expect(container.firstChild).not.toHaveClass('py-16');
  });

  it('inline layout is a single row (role=status for the stale-data banner)', () => {
    render(<PageState kind="error" layout="inline" title="Couldn't refresh" description="Showing the last list." onRetry={() => {}} />);
    const alert = screen.getByRole('status');
    expect(alert).toHaveClass('flex-wrap', 'items-center');
    expect(alert).toHaveTextContent("Couldn't refresh");
    expect(screen.getByRole('button', { name: /^Try again/ })).toBeInTheDocument();
  });

  it('locked is calm status, not an alert', () => {
    render(<PageState kind="locked" title="Access denied" description="Only super admins." />);
    expect(screen.getByRole('status')).toHaveTextContent('Access denied');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
