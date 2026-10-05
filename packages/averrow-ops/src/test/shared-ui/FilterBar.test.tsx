import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { FilterBar, type FilterOption } from '@averrow/shared/ui';

const FILTERS: FilterOption[] = [
  { value: 'all', label: 'All', count: 20 },
  { value: 'critical', label: 'Critical', count: 12 },
  { value: 'low', label: 'Low' },
];

describe('shared FilterBar', () => {
  it('renders pills as toggle buttons in a labelled group with aria-pressed', () => {
    render(<FilterBar filters={FILTERS} active="critical" onChange={() => {}} filterLabel="Severity" />);
    expect(screen.getByRole('group', { name: 'Severity' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Critical, 12' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'All, 20' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Low' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('defaults the group name to "Filters"', () => {
    render(<FilterBar filters={FILTERS} active="all" onChange={() => {}} />);
    expect(screen.getByRole('group', { name: 'Filters' })).toBeInTheDocument();
  });

  it('puts the count in the accessible name only when a count is given (including 0)', () => {
    render(<FilterBar filters={[{ value: 'z', label: 'Zero', count: 0 }, { value: 'n', label: 'None' }]} active="z" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Zero, 0' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'None' })).toBeInTheDocument();
  });

  it('calls onChange with the clicked value and toggles aria-pressed when controlled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    function Harness() {
      const [active, setActive] = useState('all');
      return <FilterBar filters={FILTERS} active={active} onChange={(v) => { onChange(v); setActive(v); }} />;
    }
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Critical, 12' }));
    expect(onChange).toHaveBeenCalledWith('critical');
    expect(screen.getByRole('button', { name: 'Critical, 12' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'All, 20' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('pills are keyboard-activatable', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<FilterBar filters={FILTERS} active="all" onChange={onChange} />);
    await user.tab();
    await user.keyboard('{Tab}{Enter}');
    expect(onChange).toHaveBeenCalledWith('critical');
  });

  it('search input is reachable by label, is type=search, and reports typing', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<FilterBar search={{ value: '', onChange, label: 'Search brands', placeholder: 'Find…' }} />);
    const input = screen.getByLabelText('Search brands');
    expect(input).toHaveAttribute('type', 'search');
    expect(screen.getByRole('searchbox', { name: 'Search brands' })).toBe(input);
    await user.type(input, 'ab');
    expect(onChange).toHaveBeenNthCalledWith(1, 'a');
    expect(onChange).toHaveBeenNthCalledWith(2, 'b'); // controlled: value stays ''
  });

  it('search label falls back to the placeholder, then to "Search"', () => {
    const { rerender } = render(<FilterBar search={{ value: '', onChange: () => {}, placeholder: 'Find brands' }} />);
    expect(screen.getByLabelText('Find brands')).toBeInTheDocument();
    rerender(<FilterBar search={{ value: '', onChange: () => {} }} />);
    expect(screen.getByLabelText('Search')).toBeInTheDocument();
  });

  it('renders nothing for search / group when not provided, and renders actions + children', () => {
    const { rerender } = render(<FilterBar />);
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    rerender(<FilterBar actions={<button type="button">Export</button>}><span>Secondary</span></FilterBar>);
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
    expect(screen.getByText('Secondary')).toBeInTheDocument();
  });

  it('pills use an outline focus style, since the active pill sets an inline boxShadow', () => {
    render(<FilterBar filters={FILTERS} active="all" onChange={() => {}} />);
    for (const name of [/^All/, /^Critical/]) {
      const cls = screen.getByRole('button', { name }).className;
      expect(cls).toContain('focus-visible:outline-2');
      expect(cls).toContain('focus-visible:outline-[var(--amber-text)]');
      expect(cls).not.toContain('focus-visible:ring');
    }
  });

  it('inactive pill label/count and the search placeholder use secondary text', () => {
    render(
      <FilterBar
        filters={FILTERS}
        active="all"
        onChange={() => {}}
        search={{ value: '', onChange: () => {}, placeholder: 'Find' }}
      />,
    );
    const pill = screen.getByRole('button', { name: /^Critical/ });
    expect(pill.style.color).toBe('var(--text-secondary)');
    expect((pill.querySelector('span') as HTMLElement).style.color).toBe('var(--text-secondary)');
    expect(screen.getByRole('searchbox').className).toContain('placeholder:text-[var(--text-secondary)]');
  });
});

describe('FilterBar search keys and size', () => {
  it('Escape clears, Enter submits, md size is legible', async () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(
      <FilterBar
        size="md"
        search={{ value: 'abc', onChange, onSubmit, label: 'Find' }}
        filters={[{ value: 'a', label: 'All' }]}
        active="a"
      />,
    );
    const input = screen.getByLabelText('Find');
    input.focus();
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledWith('abc');
    await user.keyboard('{Escape}');
    expect(onChange).toHaveBeenCalledWith('');
    expect(screen.getByRole('button', { name: 'All' }).className).toContain('text-[13px]');
  });
});
