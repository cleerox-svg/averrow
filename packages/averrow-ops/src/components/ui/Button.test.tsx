import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from './Button';

describe('Button', () => {
  it('renders children', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByText('Click me')).toBeInTheDocument();
  });

  it('calls onClick when clicked', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Click</Button>);
    await userEvent.click(screen.getByText('Click'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does not call onClick when disabled', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick} disabled>Click</Button>);
    await userEvent.click(screen.getByText('Click'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('applies primary variant styles by default', () => {
    const { container } = render(<Button>Primary</Button>);
    const el = container.firstChild as HTMLElement;
    expect(el.style.background).toContain('linear-gradient');
  });

  it('applies size styles', () => {
    const { container } = render(<Button size="sm">Small</Button>);
    const el = container.firstChild as HTMLElement;
    expect(el.style.fontSize).toBe('10px');
  });

  it('applies large size styles', () => {
    const { container } = render(<Button size="lg">Large</Button>);
    const el = container.firstChild as HTMLElement;
    expect(el.style.fontSize).toBe('12px');
  });

  it('renders all variants without error', () => {
    const variants = ['primary', 'secondary', 'ghost', 'success', 'danger'] as const;
    variants.forEach(variant => {
      const { unmount } = render(<Button variant={variant}>{variant}</Button>);
      expect(screen.getByText(variant)).toBeInTheDocument();
      unmount();
    });
  });

  it('renders as a button element', () => {
    render(<Button>Test</Button>);
    expect(screen.getByText('Test').tagName).toBe('BUTTON');
  });

  it('applies disabled styling', () => {
    const { container } = render(<Button disabled>Disabled</Button>);
    const el = container.firstChild as HTMLElement;
    expect(el).toBeDisabled();
    expect(el.style.opacity).toBe('0.4');
  });

  it('forwards native button attributes', () => {
    render(<Button type="submit" data-testid="submit-btn">Submit</Button>);
    const btn = screen.getByTestId('submit-btn');
    expect(btn).toHaveAttribute('type', 'submit');
  });
});
