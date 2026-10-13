import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ObservatoryLoadError } from './ObservatoryLoadError';

describe('ObservatoryLoadError', () => {
  it('is a critical status Banner on an opaque surface, positioned by its wrapper', () => {
    render(<ObservatoryLoadError onRetry={vi.fn()} right={336} zIndex={30} />);
    const region = screen.getByRole('status', { name: 'Observatory load error' });
    expect(region).toHaveAttribute('data-tone', 'critical');
    expect(region).toHaveAttribute('role', 'status');
    expect(region).toHaveTextContent("Couldn't load Observatory data");
    expect(region.style.background).toContain('--bg-card-deep');
    const wrapper = screen.getByTestId('observatory-load-error');
    expect(wrapper.style.position).toBe('absolute');
    expect(wrapper.style.right).toBe('336px');
    expect(wrapper.style.width).toBe('320px');
    expect(region.style.position).toBe('');
  });

  it('Retry calls onRetry', async () => {
    const onRetry = vi.fn();
    render(<ObservatoryLoadError onRetry={onRetry} right={16} zIndex={30} />);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
