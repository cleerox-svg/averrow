import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Tabs, type Tab } from '@averrow/shared/ui';

const TABS: Tab[] = [
  { id: 'one', label: 'One', count: 3 },
  { id: 'two', label: 'Two', badge: 'NEW' },
  { id: 'three', label: 'Three', count: 0 },
];

function Harness(props: { activation?: 'auto' | 'manual'; variant?: 'pills' | 'underline' | 'bar'; onChange?: (id: string) => void; linkedPanels?: boolean }) {
  const [active, setActive] = useState('one');
  return (
    <Tabs
      aria-label="Sections"
      tabs={TABS}
      activeTab={active}
      variant={props.variant}
      activation={props.activation}
      linkedPanels={props.linkedPanels}
      onChange={(id) => { setActive(id); props.onChange?.(id); }}
    />
  );
}

const tab = (name: RegExp | string) => screen.getByRole('tab', { name });

describe.each(['pills', 'underline', 'bar'] as const)('shared Tabs (%s)', (variant) => {
  it('exposes a labelled tablist with aria-selected on the active tab only', () => {
    render(<Harness variant={variant} />);
    expect(screen.getByRole('tablist', { name: 'Sections' })).toBeInTheDocument();
    expect(tab(/^One/)).toHaveAttribute('aria-selected', 'true');
    expect(tab(/^Two/)).toHaveAttribute('aria-selected', 'false');
    expect(tab(/^Three/)).toHaveAttribute('aria-selected', 'false');
  });

  it('uses a roving tabindex (only the active tab is a tab stop)', () => {
    render(<Harness variant={variant} />);
    expect(tab(/^One/)).toHaveAttribute('tabindex', '0');
    expect(tab(/^Two/)).toHaveAttribute('tabindex', '-1');
    expect(tab(/^Three/)).toHaveAttribute('tabindex', '-1');
  });

  it('renders count and badge, including a count of 0', () => {
    render(<Harness variant={variant} />);
    expect(tab(/^One/)).toHaveTextContent('3');
    expect(tab(/^Two/)).toHaveTextContent('NEW');
    expect(tab(/^Three/)).toHaveTextContent('0');
  });

  it('highlights the active tab with --amber-text and keeps inactive tabs on --text-secondary', () => {
    const { rerender } = render(<Tabs tabs={TABS} activeTab="two" onChange={() => {}} variant={variant} />);
    expect(tab(/^Two/).style.color).toBe('var(--amber-text)');
    expect(tab(/^One/).style.color).toBe('var(--text-secondary)');
    expect(tab(/^Three/).style.color).toBe('var(--text-secondary)');
    // Active styling follows the controlled activeTab prop.
    rerender(<Tabs tabs={TABS} activeTab="three" onChange={() => {}} variant={variant} />);
    expect(tab(/^Three/).style.color).toBe('var(--amber-text)');
    expect(tab(/^Two/).style.color).toBe('var(--text-secondary)');
  });

  it('renders tabs that have no count or badge', () => {
    render(
      <Tabs
        tabs={[{ id: 'a', label: 'Tab A' }, { id: 'b', label: 'Tab B' }]}
        activeTab="a"
        onChange={() => {}}
        variant={variant}
      />,
    );
    expect(tab('Tab A')).toBeInTheDocument();
    expect(tab('Tab B')).toBeInTheDocument();
  });

  it('clicking selects', async () => {
    const onChange = vi.fn();
    render(<Harness variant={variant} onChange={onChange} />);
    await userEvent.setup().click(tab(/^Two/));
    expect(onChange).toHaveBeenCalledWith('two');
    expect(tab(/^Two/)).toHaveAttribute('aria-selected', 'true');
  });
});

describe('shared Tabs keyboard', () => {
  it('ArrowRight / ArrowLeft move focus with wrap-around, without selecting (manual)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.tab();
    expect(tab(/^One/)).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(tab(/^Two/)).toHaveFocus();
    expect(tab(/^Two/)).toHaveAttribute('tabindex', '0');
    expect(tab(/^One/)).toHaveAttribute('tabindex', '-1');
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(tab(/^One/)).toHaveFocus(); // wrapped
    await user.keyboard('{ArrowLeft}');
    expect(tab(/^Three/)).toHaveFocus(); // wrapped backwards
    expect(onChange).not.toHaveBeenCalled();
    expect(tab(/^One/)).toHaveAttribute('aria-selected', 'true');
  });

  it('Home and End jump to first and last', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.tab();
    await user.keyboard('{End}');
    expect(tab(/^Three/)).toHaveFocus();
    await user.keyboard('{Home}');
    expect(tab(/^One/)).toHaveFocus();
  });

  it('Enter and Space select the focused tab in manual mode', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.tab();
    await user.keyboard('{ArrowRight}{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('two');
    expect(tab(/^Two/)).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowRight} ');
    expect(onChange).toHaveBeenLastCalledWith('three');
    expect(tab(/^Three/)).toHaveAttribute('aria-selected', 'true');
  });

  it('arrow focus also selects in auto mode', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness activation="auto" onChange={onChange} />);
    await user.tab();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('two');
    expect(tab(/^Two/)).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{End}');
    expect(onChange).toHaveBeenLastCalledWith('three');
  });

  it('roving tab stop returns to the active tab after focus leaves the list', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Harness />
        <button type="button">outside</button>
      </>,
    );
    await user.tab();
    await user.keyboard('{ArrowRight}');
    await user.tab(); // to "outside"
    expect(screen.getByRole('button', { name: 'outside' })).toHaveFocus();
    expect(tab(/^One/)).toHaveAttribute('tabindex', '0');
    expect(tab(/^Two/)).toHaveAttribute('tabindex', '-1');
  });
});

describe('shared Tabs panels linkage', () => {
  it('omits ids/aria-controls by default', () => {
    render(<Harness />);
    expect(tab(/^One/)).not.toHaveAttribute('aria-controls');
    expect(tab(/^One/)).not.toHaveAttribute('id');
  });

  it('emits id and aria-controls with linkedPanels', () => {
    render(<Harness linkedPanels />);
    expect(tab(/^One/)).toHaveAttribute('id', 'tab-one');
    expect(tab(/^One/)).toHaveAttribute('aria-controls', 'tabpanel-one');
  });
});

describe('shared Tabs tab stop + focus', () => {
  it('falls back to the first tab when activeTab is not in tabs (exactly one tab stop)', () => {
    render(<Tabs aria-label="S" tabs={TABS} activeTab="missing" onChange={() => {}} />);
    const stops = screen.getAllByRole('tab').filter((t) => t.getAttribute('tabindex') === '0');
    expect(stops).toHaveLength(1);
    expect(stops[0]).toHaveTextContent(/^One/);
  });

  it('does not emit a React key warning', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Harness />);
    expect(err.mock.calls.filter((c) => String(c[0]).includes('key'))).toEqual([]);
    err.mockRestore();
  });

  it.each(['pills', 'underline', 'bar'] as const)('%s tabs use an outline focus style (not a ring that inline boxShadow overrides)', (variant) => {
    render(<Harness variant={variant} />);
    const cls = tab(/^One/).className;
    expect(cls).toContain('focus-visible:outline-2');
    expect(cls).toContain('focus-visible:outline-[var(--amber-text)]');
    expect(cls).not.toContain('focus-visible:ring');
    expect(cls).not.toContain('focus-visible:outline-none');
  });

  it('bar tabs have horizontal padding so the active pill does not hug its text', () => {
    render(<Harness variant="bar" />);
    expect(tab(/^One/).className).toContain('px-2');
  });

  it('underline tabs use a negative outline offset so the scroller does not clip it', () => {
    render(<Harness variant="underline" />);
    expect(tab(/^One/).className).toContain('focus-visible:-outline-offset-2');
  });

  it('inactive tab count and NEW badge use secondary text, badge >= 9px', () => {
    render(<Harness />);
    const count = tab(/^Three/).querySelector('span.font-mono') as HTMLElement;
    expect(count.style.color).toBe('var(--text-secondary)');
    const badge = tab(/^Two/).querySelector('span.font-black') as HTMLElement;
    expect(badge.className).toContain('text-[9px]');
    expect(badge.style.color).toBe('var(--text-secondary)');
  });
});

describe('shared Tabs size', () => {
  it.each(['pills', 'underline', 'bar'] as const)('%s: md is 13px with a >=44px touch height; default is unchanged', (variant) => {
    const { rerender } = render(<Tabs tabs={TABS} activeTab="one" onChange={() => {}} variant={variant} size="md" />);
    const md = tab(/^One/);
    expect(md.className).toContain('text-[13px]');
    expect(md.className).toContain('min-h-[44px]');
    expect(md.className).not.toMatch(/text-\[(9|10|11)px\]/);
    rerender(<Tabs tabs={TABS} activeTab="one" onChange={() => {}} variant={variant} />);
    const sm = tab(/^One/);
    expect(sm.className).not.toContain('min-h-[44px]');
    expect(sm.className).toMatch(/text-\[(10|11)px\]/);
  });
});
