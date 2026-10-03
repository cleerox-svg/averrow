import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Avatar } from '@averrow/shared/ui';

describe('shared Avatar', () => {
  it('shows the uppercased first character of the name', () => {
    render(<Avatar name="acme corp" />);
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('trims the name and falls back to ? for an empty name', () => {
    const { rerender } = render(<Avatar name="  google" />);
    expect(screen.getByText('G')).toBeInTheDocument();
    rerender(<Avatar name="   " />);
    expect(screen.getByText('?')).toBeInTheDocument();
  });

  it('is decorative (aria-hidden, no role) without a label', () => {
    const { container } = render(<Avatar name="Acme" />);
    expect(container.firstChild).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('with label is role=img and the label is the accessible name', () => {
    render(<Avatar name="Acme" label="Acme Corp" />);
    expect(screen.getByRole('img', { name: 'Acme Corp' })).toBeInTheDocument();
  });

  it('puts the severity in the accessible name (case-insensitive)', () => {
    render(<Avatar name="Acme" label="Acme Corp" severity="CRITICAL" />);
    expect(screen.getByRole('img', { name: 'Acme Corp, critical severity' })).toBeInTheDocument();
  });

  it('does not add severity text to the name without a label', () => {
    const { container } = render(<Avatar name="Acme" severity="high" />);
    expect(container.firstChild).toHaveAttribute('aria-hidden', 'true');
    expect(container.firstChild).not.toHaveAttribute('aria-label');
  });

  it('renders the favicon (decorative alt) instead of the initial', () => {
    const { container } = render(<Avatar name="Acme" faviconUrl="https://acme.test/f.ico" />);
    const img = container.querySelector('img')!;
    expect(img).toHaveAttribute('src', 'https://acme.test/f.ico');
    expect(img).toHaveAttribute('alt', '');
    expect(screen.queryByText('A')).not.toBeInTheDocument();
  });

  it('falls back to the initial when the favicon fails to load', () => {
    const { container } = render(<Avatar name="Acme" faviconUrl="https://acme.test/broken.ico" />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('retries a new favicon URL after a previous one failed', () => {
    const { container, rerender } = render(<Avatar name="Acme" faviconUrl="https://acme.test/broken.ico" />);
    fireEvent.error(container.querySelector('img')!);
    rerender(<Avatar name="Acme" faviconUrl="https://acme.test/ok.ico" />);
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://acme.test/ok.ico');
  });

  it('never renders a user photo: an avatarUrl is not an img source', () => {
    const props = { name: 'Claude Leroux', avatarUrl: 'https://lh3.googleusercontent.com/me.png' } as unknown as React.ComponentProps<typeof Avatar>;
    const { container } = render(<Avatar {...props} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).not.toContain('googleusercontent');
    expect(screen.getByText('C')).toBeInTheDocument();
  });

  it('renders a severity dot only for known severities', () => {
    const { container, rerender } = render(<Avatar name="A" severity="high" />);
    // tile > inner + dot
    expect(container.firstElementChild!.children).toHaveLength(2);
    rerender(<Avatar name="A" severity="bogus" />);
    expect(container.firstElementChild!.children).toHaveLength(1);
    rerender(<Avatar name="A" severity={null} />);
    expect(container.firstElementChild!.children).toHaveLength(1);
  });

  it('applies the requested size', () => {
    const { container } = render(<Avatar name="A" size={64} />);
    const el = container.firstChild as HTMLElement;
    expect(el.style.width).toBe('64px');
    expect(el.style.height).toBe('64px');
  });
});
