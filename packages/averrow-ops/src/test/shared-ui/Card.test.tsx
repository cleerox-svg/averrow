import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  Card, CardHeader, CardTitle, CardContent, CardFooter, resolveCardPadding,
} from '@averrow/shared/ui';

const root = (c: HTMLElement) => c.firstChild as HTMLElement;

describe('Card', () => {
  it('renders children and accepts a custom className', () => {
    const { container } = render(<Card className="cursor-pointer">Card content</Card>);
    expect(screen.getByText('Card content')).toBeInTheDocument();
    expect(root(container)).toHaveClass('cursor-pointer');
  });

  it('applies base inline styling', () => {
    const el = root(render(<Card>Content</Card>).container);
    expect(el.style.position).toBe('relative');
    expect(el.style.borderRadius).toBe('var(--card-radius)');
    expect(el.style.overflow).toBe('hidden');
  });

  describe('padding', () => {
    it('defaults to 20px (the ops default)', () => {
      expect(root(render(<Card>x</Card>).container).style.padding).toBe('20px');
    });

    it.each([
      ['none', '0px'],
      ['sm', '12px'],
      ['md', '20px'],
      ['lg', '24px'],
    ] as const)('token %s resolves to valid CSS (%s)', (token, css) => {
      const el = root(render(<Card padding={token}>x</Card>).container);
      // jsdom drops invalid declarations, so a non-empty value proves valid CSS.
      expect(el.style.padding).toBe(css);
    });

    it('treats a number as px and passes raw CSS through', () => {
      expect(root(render(<Card padding={16}>x</Card>).container).style.padding).toBe('16px');
      expect(root(render(<Card padding={0}>x</Card>).container).style.padding).toBe('0px');
      expect(root(render(<Card padding="16px 20px">x</Card>).container).style.padding).toBe('16px 20px');
    });

    it('lets an explicit style.padding win', () => {
      expect(root(render(<Card padding="lg" style={{ padding: 7 }}>x</Card>).container).style.padding).toBe('7px');
    });

    it('resolveCardPadding mirrors the token table', () => {
      expect(resolveCardPadding(undefined)).toBe('20px');
      expect(resolveCardPadding('lg')).toBe('24px');
      expect(resolveCardPadding(8)).toBe('8px');
      expect(resolveCardPadding('4px 8px')).toBe('4px 8px');
    });
  });

  describe('variants', () => {
    it('active uses the amber border + glow', () => {
      const el = root(render(<Card variant="active">x</Card>).container);
      expect(el.style.border).toContain('var(--amber-border)');
      expect(el.style.boxShadow).toContain('var(--amber-glow)');
    });

    it('active + accent tints border and glow with the accent colour', () => {
      const el = root(render(<Card variant="active" accent="var(--blue)">x</Card>).container);
      expect(el.style.border).toContain('color-mix(in srgb, var(--blue)');
      expect(el.style.boxShadow).toContain('color-mix(in srgb, var(--blue)');
      expect(el.style.boxShadow).not.toContain('var(--amber-glow)');
    });

    it('accent is ignored outside the active variant', () => {
      const el = root(render(<Card accent="var(--blue)">x</Card>).container);
      expect(el.style.border).toContain('var(--border-base)');
      expect(el.style.boxShadow).not.toContain('var(--blue)');
    });

    it('flat has no shadow, blur or rim lines', () => {
      const { container } = render(<Card variant="flat">x</Card>);
      const el = root(container);
      expect(el.style.boxShadow).toBe('none');
      expect(el.style.backdropFilter).toBe('');
      expect(el.querySelectorAll('[aria-hidden]')).toHaveLength(0);
      expect(root(render(<Card>x</Card>).container).querySelectorAll('[aria-hidden]')).toHaveLength(2);
    });

    it('critical uses the red border', () => {
      expect(root(render(<Card variant="critical">x</Card>).container).style.border).toContain('var(--red-border)');
    });
  });

  describe('a11y pass-through props', () => {
    it('omits role/tabIndex/aria-* when not passed', () => {
      const el = root(render(<Card>Content</Card>).container);
      expect(el).not.toHaveAttribute('role');
      expect(el).not.toHaveAttribute('tabindex');
      expect(el).not.toHaveAttribute('aria-label');
      expect(el).not.toHaveAttribute('aria-expanded');
    });

    it('forwards role, tabIndex, aria-label and aria-expanded', () => {
      render(
        <Card role="button" tabIndex={0} aria-label="Expand details" aria-expanded={false}>Content</Card>,
      );
      const el = screen.getByRole('button', { name: 'Expand details' });
      expect(el).toHaveAttribute('tabindex', '0');
      expect(el).toHaveAttribute('aria-expanded', 'false');
    });

    it('fires onKeyDown and onClick', async () => {
      const onKeyDown = vi.fn();
      const onClick = vi.fn();
      render(
        <Card role="button" tabIndex={0} aria-label="Row" onKeyDown={onKeyDown} onClick={onClick}>Content</Card>,
      );
      const el = screen.getByRole('button', { name: 'Row' });
      el.focus();
      await userEvent.keyboard('{Enter}');
      expect(onKeyDown).toHaveBeenCalledTimes(1);
      await userEvent.click(el);
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('shows a pointer cursor only when clickable', () => {
      expect(root(render(<Card>x</Card>).container).style.cursor).toBe('default');
      expect(root(render(<Card onClick={() => {}}>x</Card>).container).style.cursor).toBe('pointer');
    });
  });

  it('composes with CardHeader / CardContent / CardFooter (padding="none")', () => {
    const { container } = render(
      <Card padding="none">
        <CardHeader><CardTitle>Title</CardTitle></CardHeader>
        <CardContent>Body</CardContent>
        <CardFooter>Foot</CardFooter>
      </Card>,
    );
    expect(root(container).style.padding).toBe('0px');
    expect(screen.getByRole('heading', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getByText('Body')).toHaveClass('p-4');
    expect(screen.getByText('Foot')).toBeInTheDocument();
  });
});

describe('Card overflow opt-in', () => {
  it('clips by default and allows visible/clip', () => {
    const { rerender, container } = render(<Card>x</Card>);
    expect((container.firstChild as HTMLElement).style.overflow).toBe('hidden');
    rerender(<Card overflow="visible">x</Card>);
    expect((container.firstChild as HTMLElement).style.overflow).toBe('visible');
    rerender(<Card overflow="clip">x</Card>);
    expect((container.firstChild as HTMLElement).style.overflow).toBe('clip');
  });
});
