import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tabs } from './Tabs';

// jsdom has no ResizeObserver; the underline variant's scroll-fade effect
// (Tabs.tsx) instantiates one on mount. Stub it so underline-variant tests
// don't crash — this is a test-environment shim, not a behavior change.
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

describe('Tabs', () => {
  const tabs = [
    { id: 'all', label: 'All', count: 10 },
    { id: 'active', label: 'Active', count: 5 },
    { id: 'draft', label: 'Draft', count: 3 },
  ];

  it('renders all tabs', () => {
    render(<Tabs tabs={tabs} activeTab="all" onChange={() => {}} />);
    expect(screen.getByText('All')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
  });

  it('shows counts', () => {
    render(<Tabs tabs={tabs} activeTab="all" onChange={() => {}} />);
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('calls onChange when tab is clicked', async () => {
    const onChange = vi.fn();
    render(<Tabs tabs={tabs} activeTab="all" onChange={onChange} />);
    await userEvent.click(screen.getByText('Active'));
    expect(onChange).toHaveBeenCalledWith('active');
  });

  it('highlights active tab', () => {
    render(<Tabs tabs={tabs} activeTab="active" onChange={() => {}} />);
    const activeButton = screen.getByText('Active').closest('button') as HTMLButtonElement;
    expect(activeButton.style.color).toBe('var(--amber)');
  });

  it('does not highlight inactive tabs', () => {
    render(<Tabs tabs={tabs} activeTab="all" onChange={() => {}} />);
    const draftButton = screen.getByText('Draft').closest('button') as HTMLButtonElement;
    expect(draftButton.style.color).toBe('var(--text-tertiary)');
  });

  it('renders tabs without counts', () => {
    const tabsNoCount = [
      { id: 'a', label: 'Tab A' },
      { id: 'b', label: 'Tab B' },
    ];
    render(<Tabs tabs={tabsNoCount} activeTab="a" onChange={() => {}} />);
    expect(screen.getByText('Tab A')).toBeInTheDocument();
    expect(screen.getByText('Tab B')).toBeInTheDocument();
  });

  it('switches active tab styling when different tab clicked', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<Tabs tabs={tabs} activeTab="all" onChange={onChange} />);

    await userEvent.click(screen.getByText('Draft'));
    expect(onChange).toHaveBeenCalledWith('draft');

    // Simulate parent updating the activeTab
    rerender(<Tabs tabs={tabs} activeTab="draft" onChange={onChange} />);
    const draftButton = screen.getByText('Draft').closest('button') as HTMLButtonElement;
    expect(draftButton.style.color).toBe('var(--amber)');
  });

  // ─── ARIA tab roles (v2.0 a11y addition) ────────────────────────
  describe('ARIA tab roles', () => {
    it('pills variant: wraps tabs in role="tablist" with role="tab" buttons', () => {
      render(<Tabs tabs={tabs} activeTab="active" onChange={() => {}} />);
      expect(screen.getByRole('tablist')).toBeInTheDocument();
      const tabButtons = screen.getAllByRole('tab');
      expect(tabButtons).toHaveLength(3);
    });

    it('pills variant: aria-selected is true only on the active tab', () => {
      render(<Tabs tabs={tabs} activeTab="active" onChange={() => {}} />);
      expect(screen.getByRole('tab', { name: /All/ })).toHaveAttribute('aria-selected', 'false');
      expect(screen.getByRole('tab', { name: /Active/ })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: /Draft/ })).toHaveAttribute('aria-selected', 'false');
    });

    it('pills variant: aria-selected flips when the active tab changes', () => {
      const { rerender } = render(<Tabs tabs={tabs} activeTab="all" onChange={() => {}} />);
      expect(screen.getByRole('tab', { name: /All/ })).toHaveAttribute('aria-selected', 'true');

      rerender(<Tabs tabs={tabs} activeTab="draft" onChange={() => {}} />);
      expect(screen.getByRole('tab', { name: /All/ })).toHaveAttribute('aria-selected', 'false');
      expect(screen.getByRole('tab', { name: /Draft/ })).toHaveAttribute('aria-selected', 'true');
    });

    it('bar variant: also exposes role="tablist"/role="tab" with correct aria-selected', () => {
      render(<Tabs tabs={tabs} activeTab="active" onChange={() => {}} variant="bar" />);
      expect(screen.getByRole('tablist')).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Active' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'false');
    });

    it('underline variant: also exposes role="tablist"/role="tab" with correct aria-selected', () => {
      render(<Tabs tabs={tabs} activeTab="draft" onChange={() => {}} variant="underline" />);
      expect(screen.getByRole('tablist')).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /Draft/ })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: /All/ })).toHaveAttribute('aria-selected', 'false');
    });

    // ─── linkedPanels opt-in (regression: aria-controls must not dangle) ──
    // aria-controls is only valid ARIA when the consumer actually renders
    // the matching tabpanel. Most Tabs consumers (Observatory, SuperAdminOrgs,
    // settings/Organization) render no tabpanel at all, so by default Tabs
    // must NOT emit id/aria-controls. Only the one consumer that renders a
    // matching `role="tabpanel"` (Metrics.tsx) opts in via `linkedPanels`.
    it('by default, does NOT emit id or aria-controls (no matching tabpanel exists)', () => {
      render(<Tabs tabs={tabs} activeTab="all" onChange={() => {}} />);
      const activeButton = screen.getByRole('tab', { name: /Active/ });
      expect(activeButton).not.toHaveAttribute('id');
      expect(activeButton).not.toHaveAttribute('aria-controls');
    });

    it('with linkedPanels, emits id + aria-controls pointing at its own tabpanel id', () => {
      render(<Tabs tabs={tabs} activeTab="all" onChange={() => {}} linkedPanels />);
      const activeButton = screen.getByRole('tab', { name: /Active/ });
      expect(activeButton).toHaveAttribute('id', 'tab-active');
      expect(activeButton).toHaveAttribute('aria-controls', 'tabpanel-active');
    });

    it('with linkedPanels, bar variant also emits id + aria-controls', () => {
      render(<Tabs tabs={tabs} activeTab="active" onChange={() => {}} variant="bar" linkedPanels />);
      const activeButton = screen.getByRole('tab', { name: 'Active' });
      expect(activeButton).toHaveAttribute('id', 'tab-active');
      expect(activeButton).toHaveAttribute('aria-controls', 'tabpanel-active');
    });

    it('with linkedPanels, underline variant also emits id + aria-controls', () => {
      render(<Tabs tabs={tabs} activeTab="draft" onChange={() => {}} variant="underline" linkedPanels />);
      const activeButton = screen.getByRole('tab', { name: /Draft/ });
      expect(activeButton).toHaveAttribute('id', 'tab-draft');
      expect(activeButton).toHaveAttribute('aria-controls', 'tabpanel-draft');
    });
  });
});
