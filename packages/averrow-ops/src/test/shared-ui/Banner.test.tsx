import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Banner, type BannerTone } from '@averrow/shared/ui';

describe('shared Banner', () => {
  it.each(['critical', 'high', 'medium', 'low', 'info', 'success'] as BannerTone[])('renders tone %s with an icon tile', (tone) => {
    const { container } = render(<Banner tone={tone} title="T">msg</Banner>);
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveAttribute('data-tone', tone);
    expect(container.querySelector('.ds-banner-icon svg')).not.toBeNull();
  });

  it('falls back to info for an unknown tone and defaults to info/inline', () => {
    const { container, rerender } = render(<Banner tone={'bogus' as unknown as BannerTone} title="T" />);
    expect(container.firstElementChild).toHaveAttribute('data-tone', 'info');
    rerender(<Banner title="T" />);
    expect(container.firstElementChild).toHaveAttribute('data-variant', 'inline');
  });

  it('renders the prominent variant with eyebrow and hides the icon with icon={false}', () => {
    const { container } = render(<Banner variant="prominent" tone="critical" eyebrow="SLA breach" icon={false} title="T" />);
    expect(container.firstElementChild).toHaveAttribute('data-variant', 'prominent');
    expect(screen.getByText('SLA breach')).toBeInTheDocument();
    expect(container.querySelector('.ds-banner-icon')).toBeNull();
  });

  it('is a section only with an accessible name, never role=alert', () => {
    const { rerender } = render(<Banner title="T" />);
    expect(screen.queryByRole('region')).toBeNull();
    rerender(<Banner title="T" aria-label="Notice" />);
    expect(screen.getByRole('region', { name: 'Notice' })).toBeInTheDocument();
    rerender(<Banner title="Named by title" labelFromTitle />);
    expect(screen.getByRole('region', { name: 'Named by title' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('headingLevel picks the title element', () => {
    const { rerender } = render(<Banner title="T" headingLevel={2} />);
    expect(screen.getByRole('heading', { level: 2, name: 'T' })).toBeInTheDocument();
    rerender(<Banner title="T" headingLevel={3} />);
    expect(screen.getByRole('heading', { level: 3 })).toBeInTheDocument();
    rerender(<Banner title="T" />); // default: no heading, the region label carries semantics
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('button trigger toggles details with aria-expanded/controls and unclamps the message', () => {
    const { container } = render(<Banner title="T" details={<p>more</p>}>msg</Banner>);
    const btn = screen.getByRole('button', { name: 'Details' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('more')).not.toBeVisible();
    expect(container.querySelector('.ds-banner-msg')).toHaveClass('ds-banner-clamp');
    fireEvent.click(btn);
    const hide = screen.getByRole('button', { name: 'Details' }); // label is static
    expect(hide).toHaveAttribute('aria-expanded', 'true');
    expect(hide.getAttribute('aria-controls')).toBe(screen.getByText('more').parentElement?.id);
    expect(screen.getByText('more')).toBeVisible();
    expect(container.querySelector('.ds-banner-msg')).not.toHaveClass('ds-banner-clamp');
  });

  it('shows Show more / Show less only when the text actually overflows', () => {
    const { rerender } = render(<Banner title="T">msg</Banner>);
    expect(screen.queryByRole('button')).toBeNull(); // jsdom: no layout, no overflow
    rerender(<Banner title="T" variant="prominent" details={undefined}>msg</Banner>);
    expect(screen.queryByRole('button')).toBeNull();
  });

  describe('overflow detection', () => {
    const proto = HTMLElement.prototype;
    const sh = Object.getOwnPropertyDescriptor(proto, 'scrollHeight');
    const ch = Object.getOwnPropertyDescriptor(proto, 'clientHeight');
    afterEach(() => {
      if (sh) Object.defineProperty(proto, 'scrollHeight', sh); else delete (proto as unknown as Record<string, unknown>).scrollHeight;
      if (ch) Object.defineProperty(proto, 'clientHeight', ch); else delete (proto as unknown as Record<string, unknown>).clientHeight;
    });
    function mockLayout(scroll: number, client: number) {
      Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: () => scroll });
      Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => client });
    }

    it('adds a Show more toggle that unclamps the message when clamped text overflows', () => {
      mockLayout(80, 40);
      const { container } = render(<Banner title="T">a long message</Banner>);
      const btn = screen.getByRole('button', { name: 'Show more' });
      expect(btn).toHaveAttribute('aria-expanded', 'false');
      expect(btn).not.toHaveAttribute('aria-controls');
      expect(container.querySelector('.ds-banner-msg')).toHaveClass('ds-banner-clamp');
      fireEvent.click(btn);
      expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
      expect(container.querySelector('.ds-banner-msg')).not.toHaveClass('ds-banner-clamp');
    });

    it('never clamps or offers Show more on prominent banners', () => {
      mockLayout(80, 40);
      const { container } = render(<Banner variant="prominent" title="T">msg</Banner>);
      expect(screen.queryByRole('button')).toBeNull();
      expect(container.querySelector('.ds-banner-clamp')).toBeNull();
    });
  });

  it('header trigger makes the title a toggle button', () => {
    const ref = { current: null as HTMLElement | null };
    render(<Banner title="Header" detailsTrigger="header" headerRef={ref} details={<p>body</p>} />);
    const btn = screen.getByRole('button', { name: 'Header' });
    expect(ref.current).toBe(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(btn).toHaveAttribute('aria-controls');
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('body')).toBeVisible();
  });

  it('uncontrolled calls onOpenChange; controlled follows the prop', () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(<Banner title="T" defaultOpen details="d" onOpenChange={onOpenChange} />);
    expect(screen.getByRole('button', { name: 'Details' })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.getByRole('button', { name: 'Details' })).toHaveAttribute('aria-expanded', 'false');

    rerender(<Banner title="T" open={false} details="d" onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole('button', { name: 'Details' })).toHaveAttribute('aria-expanded', 'false'); // parent did not update
    rerender(<Banner title="T" open details="d" onOpenChange={onOpenChange} />);
    expect(screen.getByRole('button', { name: 'Details' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('caller aria-labelledby beats labelFromTitle; empty slots leave no grid track', () => {
    const { container } = render(<><span id="x">Ext</span><Banner title="T" labelFromTitle aria-labelledby="x" icon={false} /></>);
    expect(screen.getByRole('region', { name: 'Ext' })).toBeInTheDocument();
    const root = container.querySelector('.ds-banner') as HTMLElement;
    expect(root.style.getPropertyValue('--bn-cols')).toBe('minmax(0, 1fr)');
  });

  it('dismiss button calls onDismiss with the given label', () => {
    const onDismiss = vi.fn();
    render(<Banner title="T" onDismiss={onDismiss} dismissLabel="Close it" />);
    fireEvent.click(screen.getByRole('button', { name: 'Close it' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders actions, and pulse uses the live-ping keyframes', () => {
    const { container } = render(<Banner title="T" pulse actions={<a href="/x">Go</a>} />);
    expect(screen.getByRole('link', { name: 'Go' })).toBeInTheDocument();
    expect(container.querySelector('[style*="live-ping"]')).not.toBeNull();
    const { container: still } = render(<Banner title="T" />);
    expect(still.querySelector('[style*="live-ping"]')).toBeNull();
  });
});

describe('Banner density', () => {
  it('defaults to density=default and exposes compact via data-density', () => {
    const { container, rerender } = render(<Banner title="T" />);
    expect(container.firstElementChild).toHaveAttribute('data-density', 'default');
    rerender(<Banner title="T" density="compact" />);
    expect(container.firstElementChild).toHaveAttribute('data-density', 'compact');
    expect(container.firstElementChild).toHaveAttribute('data-variant', 'inline');
  });

  it('compact never clamps and never offers Show more', () => {
    const { container, rerender } = render(<Banner title="T">msg</Banner>);
    expect(container.querySelector('.ds-banner-clamp')).not.toBeNull();
    rerender(<Banner title="T" density="compact">msg</Banner>);
    expect(container.querySelector('.ds-banner-clamp')).toBeNull();
    expect(screen.queryByRole('button', { name: /show more/i })).toBeNull();
  });

  it('compact uses a 20px icon column and still shows actions and dismiss', () => {
    const { container } = render(
      <Banner title="T" density="compact" actions={<button type="button">Go</button>} onDismiss={() => {}} />,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.getPropertyValue('--bn-cols')).toMatch(/^20px /);
    expect(screen.getByRole('button', { name: 'Go' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it('density is ignored for the prominent variant', () => {
    const { container } = render(<Banner variant="prominent" density="compact" title="T" />);
    expect(container.firstElementChild).toHaveAttribute('data-density', 'default');
  });
});
