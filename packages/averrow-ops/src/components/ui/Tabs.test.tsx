import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tabs } from './Tabs';

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
});
