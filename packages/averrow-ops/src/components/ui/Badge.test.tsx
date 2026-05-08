import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from './Badge';

describe('Badge', () => {
  it('renders children', () => {
    render(<Badge>CRITICAL</Badge>);
    expect(screen.getByText('CRITICAL')).toBeInTheDocument();
  });

  it('applies variant styling for critical', () => {
    const { container } = render(<Badge variant="critical">HIGH</Badge>);
    const el = container.firstChild as HTMLElement;
    expect(el.style.background).toBeTruthy();
    expect(el.style.border).toBeTruthy();
  });

  it('renders with default variant when none specified', () => {
    const { container } = render(<Badge>DEFAULT</Badge>);
    expect(container.firstChild).toBeInTheDocument();
  });

  it('accepts custom className', () => {
    const { container } = render(<Badge className="custom-class">TEST</Badge>);
    expect(container.firstChild).toHaveClass('custom-class');
  });

  it('renders all variant types without error', () => {
    const variants = ['critical', 'high', 'medium', 'low', 'success', 'info', 'default'] as const;
    variants.forEach(variant => {
      const { unmount } = render(<Badge variant={variant}>{variant}</Badge>);
      expect(screen.getByText(variant)).toBeInTheDocument();
      unmount();
    });
  });

  it('applies base inline styling', () => {
    const { container } = render(<Badge>TEST</Badge>);
    const el = container.firstChild as HTMLElement;
    expect(el.style.textTransform).toBe('uppercase');
    expect(el.style.fontFamily).toBeTruthy();
    expect(el.style.border).toBeTruthy();
  });
});
