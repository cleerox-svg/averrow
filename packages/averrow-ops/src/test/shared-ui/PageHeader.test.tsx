import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PageHeader, WorkspaceEmbedProvider, WorkspaceEmbedContext, useWorkspaceEmbed } from '@averrow/shared/ui';

const full = (extra: Partial<React.ComponentProps<typeof PageHeader>> = {}) => (
  <PageHeader
    title="Brands"
    subtitle="All monitored brands"
    actions={<button type="button">Add</button>}
    meta={<span>Updated now</span>}
    badge={<span>BETA</span>}
    {...extra}
  />
);

function Probe() {
  return <span data-testid="probe">{String(useWorkspaceEmbed())}</span>;
}

describe('shared PageHeader', () => {
  it('renders an h1 title and subtitle by default', () => {
    render(full());
    expect(screen.getByRole('heading', { level: 1, name: 'Brands' })).toBeInTheDocument();
    expect(screen.getByText('All monitored brands')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();
    expect(screen.getByText('Updated now')).toBeInTheDocument();
    expect(screen.getByText('BETA')).toBeInTheDocument();
  });

  const expectEmbedded = () => {
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.queryByText('Brands')).not.toBeInTheDocument();
    expect(screen.queryByText('All monitored brands')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();
    expect(screen.getByText('Updated now')).toBeInTheDocument();
    expect(screen.getByText('BETA')).toBeInTheDocument();
  };

  it('embedded prop hides h1 + subtitle but keeps actions, meta and badge', () => {
    render(full({ embedded: true }));
    expectEmbedded();
  });

  it('WorkspaceEmbedProvider hides h1 + subtitle but keeps actions, meta and badge', () => {
    render(<WorkspaceEmbedProvider>{full()}</WorkspaceEmbedProvider>);
    expectEmbedded();
  });

  it('embedded={false} overrides an embedding context', () => {
    render(<WorkspaceEmbedProvider>{full({ embedded: false })}</WorkspaceEmbedProvider>);
    expect(screen.getByRole('heading', { level: 1, name: 'Brands' })).toBeInTheDocument();
  });

  it('embedded={true} overrides a non-embedding context', () => {
    render(<WorkspaceEmbedProvider value={false}>{full({ embedded: true })}</WorkspaceEmbedProvider>);
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('embedded with only actions still renders actions', () => {
    render(<PageHeader title="T" embedded actions={<button type="button">Go</button>} />);
    expect(screen.getByRole('button', { name: 'Go' })).toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('context defaults to false and the provider value defaults to true', () => {
    const { rerender } = render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('false');
    rerender(<WorkspaceEmbedProvider><Probe /></WorkspaceEmbedProvider>);
    expect(screen.getByTestId('probe')).toHaveTextContent('true');
    rerender(<WorkspaceEmbedContext.Provider value><Probe /></WorkspaceEmbedContext.Provider>);
    expect(screen.getByTestId('probe')).toHaveTextContent('true');
  });

  it('back renders a button when there is no href and fires onClick', async () => {
    const onClick = vi.fn();
    render(<PageHeader title="T" back={{ label: 'Back to brands', onClick }} />);
    const btn = screen.getByRole('button', { name: /Back to brands/ });
    expect(btn).toHaveAttribute('type', 'button');
    await userEvent.setup().click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('back renders a link when href is set', () => {
    render(<PageHeader title="T" back={{ label: 'Back to brands', href: '/brands' }} />);
    const link = screen.getByRole('link', { name: /Back to brands/ });
    expect(link).toHaveAttribute('href', '/brands');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('back arrow glyph is hidden from assistive tech', () => {
    render(<PageHeader title="T" back={{ label: 'Back', onClick: () => {} }} />);
    expect(screen.getByRole('button')).toHaveAccessibleName('Back');
  });
});
