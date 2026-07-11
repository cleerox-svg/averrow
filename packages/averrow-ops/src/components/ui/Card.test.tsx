import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Card, CardHeader, CardBody } from './Card';

describe('Card', () => {
  it('renders children', () => {
    render(<Card>Card content</Card>);
    expect(screen.getByText('Card content')).toBeInTheDocument();
  });

  it('renders without crashing with hover prop', () => {
    const { container } = render(<Card hover>Content</Card>);
    expect(container.firstChild).toBeInTheDocument();
  });

  it('renders without crashing when hover=false', () => {
    const { container } = render(<Card hover={false}>Content</Card>);
    expect(container.firstChild).toBeInTheDocument();
  });

  it('applies base inline styling', () => {
    const { container } = render(<Card>Content</Card>);
    const el = container.firstChild as HTMLElement;
    expect(el).toBeInTheDocument();
    expect(el.style.position).toBe('relative');
    expect(el.style.borderRadius).toBeTruthy();
  });

  it('accepts custom className', () => {
    const { container } = render(<Card className="cursor-pointer">Content</Card>);
    expect(container.firstChild).toHaveClass('cursor-pointer');
  });

  // ─── Additive a11y pass-through props (2026-07 admin-dashboard a11y pass) ──
  // These props are opt-in — every existing call site that omits them keeps
  // its current (undefined) rendered output. FeedRiskCard
  // (features/admin/metrics/FeedFailures.tsx) is the first real consumer.
  describe('a11y pass-through props', () => {
    it('omits role/tabIndex/aria-* entirely when not passed (no regression for existing call sites)', () => {
      const { container } = render(<Card>Content</Card>);
      const el = container.firstChild as HTMLElement;
      expect(el).not.toHaveAttribute('role');
      expect(el).not.toHaveAttribute('tabindex');
      expect(el).not.toHaveAttribute('aria-label');
      expect(el).not.toHaveAttribute('aria-expanded');
    });

    it('forwards role, tabIndex, aria-label, and aria-expanded onto the root element', () => {
      render(
        <Card role="button" tabIndex={0} aria-label="Expand details" aria-expanded={false}>
          Content
        </Card>,
      );
      const el = screen.getByRole('button', { name: 'Expand details' });
      expect(el).toHaveAttribute('tabindex', '0');
      expect(el).toHaveAttribute('aria-expanded', 'false');
    });

    it('reflects aria-expanded=true when passed true', () => {
      render(
        <Card role="button" tabIndex={0} aria-label="Collapse details" aria-expanded>
          Content
        </Card>,
      );
      expect(screen.getByRole('button', { name: 'Collapse details' })).toHaveAttribute('aria-expanded', 'true');
    });

    it('invokes onKeyDown when a key is pressed on the card', async () => {
      const onKeyDown = vi.fn();
      render(
        <Card role="button" tabIndex={0} aria-label="Row" onKeyDown={onKeyDown}>
          Content
        </Card>,
      );
      const el = screen.getByRole('button', { name: 'Row' });
      el.focus();
      await userEvent.keyboard('{Enter}');
      expect(onKeyDown).toHaveBeenCalledTimes(1);
      expect(onKeyDown.mock.calls[0][0]).toMatchObject({ key: 'Enter' });
    });

    it('still fires onClick alongside the new a11y props (click path unaffected)', async () => {
      const onClick = vi.fn();
      render(
        <Card role="button" tabIndex={0} aria-label="Row" onClick={onClick}>
          Content
        </Card>,
      );
      await userEvent.click(screen.getByRole('button', { name: 'Row' }));
      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });
});

describe('CardHeader', () => {
  it('renders with section label styling', () => {
    render(<CardHeader>Section Title</CardHeader>);
    const el = screen.getByText('Section Title');
    expect(el).toHaveClass('font-mono');
    expect(el).toHaveClass('uppercase');
  });
});

describe('CardBody', () => {
  it('renders children', () => {
    render(<CardBody>Body content</CardBody>);
    expect(screen.getByText('Body content')).toBeInTheDocument();
  });

  it('accepts custom className', () => {
    const { container } = render(<CardBody className="space-y-4">Content</CardBody>);
    expect(container.firstChild).toHaveClass('space-y-4');
  });
});
