import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EntityListShell } from './EntityListShell';

interface Row { id: string; name: string }
const rows: Row[] = [{ id: '1', name: 'Alpha' }, { id: '2', name: 'Beta' }];

function shell(props: Partial<React.ComponentProps<typeof EntityListShell<Row>>>) {
  return (
    <EntityListShell<Row>
      items={rows}
      getKey={(r) => r.id}
      renderItem={(r) => <div>{r.name}</div>}
      empty={{ title: 'Nothing here', subtitle: 'Add one' }}
      {...props}
    />
  );
}

describe('EntityListShell states', () => {
  it('isError shows an error with retry and never the empty copy', async () => {
    const onRetry = vi.fn();
    render(shell({ items: undefined, isError: true, onRetry }));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/couldn't load/i);
    expect(screen.queryByText('Nothing here')).not.toBeInTheDocument();
    await userEvent.setup().click(within(alert).getByRole('button', { name: /^Try again/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('refreshError keeps the stale rows and adds the inline "Couldn\'t refresh" error with retry', async () => {
    const onRetry = vi.fn();
    render(shell({ refreshError: true, noun: 'campaigns', onRetry }));
    // Stale-data banner: polite status, not an assertive alert.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const alert = screen.getByRole('status');
    expect(alert).toHaveTextContent("Couldn't refresh campaigns");
    expect(alert).toHaveTextContent('Showing the last loaded list.');
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    await userEvent.setup().click(within(alert).getByRole('button', { name: /^Try again/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('refreshError defaults the noun, and is ignored when isError already owns the error state', () => {
    const { rerender } = render(shell({ refreshError: true }));
    expect(screen.getByRole('status')).toHaveTextContent("Couldn't refresh this list");
    rerender(shell({ items: undefined, isError: true, refreshError: true }));
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent(/couldn't load/i);
  });

  it('no alert at all when neither flag is set; empty list shows the empty copy', () => {
    const { rerender } = render(shell({}));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    rerender(shell({ items: [] }));
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
