import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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
