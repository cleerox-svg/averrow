import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PanelErrorBoundary } from './PanelErrorBoundary';

let shouldThrow = true;
function Bomb() {
  if (shouldThrow) throw new Error('widget exploded');
  return <div>healthy</div>;
}

afterEach(() => { shouldThrow = true; vi.restoreAllMocks(); });

describe('PanelErrorBoundary', () => {
  it('contains a render crash and recovers on Retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<PanelErrorBoundary label="Intelligence panel"><Bomb /></PanelErrorBoundary>);
    expect(screen.getByRole('alert')).toHaveTextContent('Intelligence panel failed to render.');
    shouldThrow = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByText('healthy')).toBeInTheDocument();
  });

  it('renders children untouched when nothing throws', () => {
    shouldThrow = false;
    render(<PanelErrorBoundary label="x"><Bomb /></PanelErrorBoundary>);
    expect(screen.getByText('healthy')).toBeInTheDocument();
  });
});
