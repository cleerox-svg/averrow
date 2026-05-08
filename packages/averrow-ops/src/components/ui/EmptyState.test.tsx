import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  it('renders message (legacy prop)', () => {
    render(<EmptyState message="No data available" />);
    expect(screen.getByText('No data available')).toBeInTheDocument();
  });

  it('renders title prop', () => {
    render(<EmptyState title="No active threats" />);
    expect(screen.getByText('No active threats')).toBeInTheDocument();
  });

  it('renders description when provided (legacy prop)', () => {
    render(<EmptyState message="Empty" description="Try adjusting filters" />);
    expect(screen.getByText('Try adjusting filters')).toBeInTheDocument();
  });

  it('renders subtitle when provided', () => {
    render(<EmptyState title="Empty" subtitle="Try adjusting filters" />);
    expect(screen.getByText('Try adjusting filters')).toBeInTheDocument();
  });

  it('does not render subtitle when not provided', () => {
    render(<EmptyState title="Empty" />);
    expect(screen.queryByText('Try adjusting filters')).not.toBeInTheDocument();
  });

  it('renders action button when provided', async () => {
    const onClick = vi.fn();
    render(<EmptyState title="Empty" action={{ label: 'Retry', onClick }} />);
    const btn = screen.getByText('Retry');
    expect(btn).toBeInTheDocument();
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does not render action button when not provided', () => {
    render(<EmptyState title="Empty" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders centered layout', () => {
    const { container } = render(<EmptyState title="Empty" />);
    expect(container.firstChild).toHaveClass('flex');
    expect(container.firstChild).toHaveClass('items-center');
    expect(container.firstChild).toHaveClass('justify-center');
  });

  it('renders icon when provided', () => {
    render(<EmptyState title="Empty" icon={<span data-testid="test-icon">icon</span>} />);
    expect(screen.getByTestId('test-icon')).toBeInTheDocument();
  });

  it('renders secondary action', async () => {
    const onClick = vi.fn();
    render(
      <EmptyState
        title="Empty"
        action={{ label: 'Primary', onClick: vi.fn() }}
        secondaryAction={{ label: 'Secondary', onClick }}
      />
    );
    const btn = screen.getByText('Secondary');
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('applies compact padding', () => {
    const { container } = render(<EmptyState title="Empty" compact />);
    expect(container.firstChild).toHaveClass('py-8');
  });

  it('applies variant border styles', () => {
    const { container } = render(<EmptyState title="Error" variant="error" />);
    expect(container.firstChild).toHaveClass('border-red-500/15');
  });
});
