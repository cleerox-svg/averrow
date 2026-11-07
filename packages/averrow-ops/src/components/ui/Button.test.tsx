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

  it('marks only the primary variant with ds-btn-primary (accent hover/press rules in tokens.css)', () => {
    const { container } = render(<><Button>P</Button><Button variant="secondary">S</Button></>);
    const [p, s] = Array.from(container.querySelectorAll('button'));
    expect(p!.className).toContain('ds-btn-primary');
    expect(s!.className).not.toContain('ds-btn-primary');
  });

  it('primary falls back to the legacy amber look when --btn-primary-* are unset', () => {
    const { container } = render(<Button>P</Button>);
    const el = container.firstChild as HTMLElement;
    const attr = el.getAttribute('style') ?? '';
    expect(attr).toContain('var(--btn-primary-bg, linear-gradient(135deg, var(--primary), var(--primary-pressed)))');
    expect(attr).toContain('var(--btn-primary-ink, #000)');
    expect(attr).toContain('var(--btn-primary-border, color-mix(in srgb, var(--primary) 60%, transparent))');
    expect(attr).toContain('var(--btn-primary-shadow, 0 4px 16px var(--primary-glow), 0 2px 4px rgba(0, 0, 0, 0.40), inset 0 1px 0 rgba(255, 255, 255, 0.30), inset 0 -1px 0 rgba(0, 0, 0, 0.20))');
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
