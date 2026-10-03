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

  it('inline error is still role=alert', () => {
    render(<PageState kind="error" layout="inline" />);
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
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    for (const kind of ['empty', 'clear', 'locked', 'loading'] as const) {
      rerender(<PageState kind={kind} onRetry={onRetry} />);
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    }
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
});
