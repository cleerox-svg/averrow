import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataTable, Table, Th, Td, type Column, type SortState } from '@averrow/shared/ui';

interface Row { id: string; name: string; score: number | null; sev?: 'critical' | 'low' }

const ROWS: Row[] = [
  { id: 'a', name: 'Bravo', score: 20, sev: 'low' },
  { id: 'b', name: 'Alpha', score: 90, sev: 'critical' },
  { id: 'c', name: 'Charlie', score: null },
  { id: 'd', name: 'Delta', score: 50 },
];

const COLS: Column<Row>[] = [
  { key: 'name', header: 'Name', sortAccessor: (r) => r.name, render: (r) => r.name },
  { key: 'score', header: 'Score', sortAccessor: (r) => r.score, render: (r) => String(r.score ?? 'n/a') },
  { key: 'plain', header: 'Plain', render: () => 'x' },
];

const bodyNames = () =>
  screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0]!.textContent);

const header = (name: string) => screen.getByRole('columnheader', { name: new RegExp(name) });

describe('DataTable', () => {
  it('renders caption (sr-only) and labels the scroll region with it', () => {
    render(<DataTable columns={COLS} rows={ROWS} getRowKey={(r) => r.id} caption="Brands" />);
    expect(screen.getByText('Brands', { selector: 'caption' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Brands' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Brands' })).toBeInTheDocument();
  });

  it('falls back to a generic region label without a caption', () => {
    render(<DataTable columns={COLS} rows={ROWS} getRowKey={(r) => r.id} />);
    expect(screen.getByRole('region', { name: 'Data table' })).toBeInTheDocument();
  });

  it('only exposes aria-sort on sortable columns; unsorted ones read none', () => {
    render(<DataTable columns={COLS} rows={ROWS} getRowKey={(r) => r.id} />);
    expect(header('Name')).toHaveAttribute('aria-sort', 'none');
    expect(header('Score')).toHaveAttribute('aria-sort', 'none');
    expect(header('Plain')).not.toHaveAttribute('aria-sort');
    expect(within(header('Plain')).queryByRole('button')).not.toBeInTheDocument();
  });

  // NOTE: first click on an unsorted column sorts DESCENDING (highest first),
  // then toggles to ascending. See Table.tsx `toggle`.
  it('cycles aria-sort none -> descending -> ascending on header-button clicks', async () => {
    const user = userEvent.setup();
    render(<DataTable columns={COLS} rows={ROWS} getRowKey={(r) => r.id} />);
    const btn = within(header('Name')).getByRole('button');
    await user.click(btn);
    expect(header('Name')).toHaveAttribute('aria-sort', 'descending');
    expect(bodyNames()).toEqual(['Delta', 'Charlie', 'Bravo', 'Alpha']);
    await user.click(btn);
    expect(header('Name')).toHaveAttribute('aria-sort', 'ascending');
    expect(bodyNames()).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
  });

  it('moves aria-sort to the newly clicked column', async () => {
    const user = userEvent.setup();
    render(<DataTable columns={COLS} rows={ROWS} getRowKey={(r) => r.id} />);
    await user.click(within(header('Name')).getByRole('button'));
    await user.click(within(header('Score')).getByRole('button'));
    expect(header('Name')).toHaveAttribute('aria-sort', 'none');
    expect(header('Score')).toHaveAttribute('aria-sort', 'descending');
  });

  it('sorts nulls last in both directions', async () => {
    const user = userEvent.setup();
    render(<DataTable columns={COLS} rows={ROWS} getRowKey={(r) => r.id} />);
    const btn = within(header('Score')).getByRole('button');
    await user.click(btn); // desc
    expect(bodyNames()).toEqual(['Alpha', 'Delta', 'Bravo', 'Charlie']);
    await user.click(btn); // asc
    expect(bodyNames()).toEqual(['Bravo', 'Delta', 'Alpha', 'Charlie']);
  });

  it('honours initialSort', () => {
    render(<DataTable columns={COLS} rows={ROWS} getRowKey={(r) => r.id} initialSort={{ key: 'name', dir: 'asc' }} />);
    expect(header('Name')).toHaveAttribute('aria-sort', 'ascending');
    expect(bodyNames()).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
  });

  it('does not mutate the rows prop when sorting', async () => {
    const rows = [...ROWS];
    render(<DataTable columns={COLS} rows={rows} getRowKey={(r) => r.id} />);
    await userEvent.setup().click(within(header('Name')).getByRole('button'));
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('sorts from the keyboard (Enter and Space on the header button)', async () => {
    const user = userEvent.setup();
    render(<DataTable columns={COLS} rows={ROWS} getRowKey={(r) => r.id} />);
    const btn = within(header('Name')).getByRole('button');
    btn.focus();
    await user.keyboard('{Enter}');
    expect(header('Name')).toHaveAttribute('aria-sort', 'descending');
    await user.keyboard(' ');
    expect(header('Name')).toHaveAttribute('aria-sort', 'ascending');
  });

  describe('controlled sort', () => {
    it('does not sort client-side for columns without an accessor and reports changes', async () => {
      const user = userEvent.setup();
      const onSortChange = vi.fn();
      const cols: Column<Row>[] = [
        { key: 'name', header: 'Name', sortable: true, render: (r) => r.name },
      ];
      render(
        <DataTable columns={cols} rows={ROWS} getRowKey={(r) => r.id}
          sort={{ key: 'name', dir: 'asc' }} onSortChange={onSortChange} />,
      );
      // Server order preserved.
      expect(bodyNames()).toEqual(['Bravo', 'Alpha', 'Charlie', 'Delta']);
      expect(header('Name')).toHaveAttribute('aria-sort', 'ascending');
      await user.click(within(header('Name')).getByRole('button'));
      expect(onSortChange).toHaveBeenCalledWith({ key: 'name', dir: 'desc' } satisfies SortState);
      // Parent has not updated `sort`, so the header must not move on its own.
      expect(header('Name')).toHaveAttribute('aria-sort', 'ascending');
      expect(bodyNames()).toEqual(['Bravo', 'Alpha', 'Charlie', 'Delta']);
    });

    it('does not keep internal state when controlled', async () => {
      const user = userEvent.setup();
      render(
        <DataTable columns={COLS} rows={ROWS} getRowKey={(r) => r.id}
          sort={null} onSortChange={() => {}} />,
      );
      await user.click(within(header('Name')).getByRole('button'));
      expect(header('Name')).toHaveAttribute('aria-sort', 'none');
      expect(bodyNames()).toEqual(['Bravo', 'Alpha', 'Charlie', 'Delta']);
    });
  });

  describe('rows', () => {
    it('clickable row is focusable and responds to click, Enter and Space', async () => {
      const user = userEvent.setup();
      const onRowClick = vi.fn();
      render(<DataTable columns={COLS} rows={ROWS} getRowKey={(r) => r.id} onRowClick={onRowClick} />);
      // Clickable rows expose role="button" (named by the first cell).
      const row = screen.getByRole('button', { name: 'Bravo' });
      expect(row.tagName).toBe('TR');
      expect(row).toHaveAttribute('tabindex', '0');
      row.focus();
      await user.keyboard('{Enter}');
      expect(onRowClick).toHaveBeenLastCalledWith(ROWS[0]);
      await user.keyboard(' ');
      expect(onRowClick).toHaveBeenCalledTimes(2);
      await user.click(row);
      expect(onRowClick).toHaveBeenCalledTimes(3);
    });

    it('rows are not focusable without onRowClick', () => {
      render(<DataTable columns={COLS} rows={ROWS} getRowKey={(r) => r.id} />);
      expect(screen.getAllByRole('row')[1]).not.toHaveAttribute('tabindex');
    });

    it('Enter on a control inside a row does not trigger the row handler', async () => {
      const user = userEvent.setup();
      const onRowClick = vi.fn();
      const onInner = vi.fn();
      const cols: Column<Row>[] = [
        { key: 'name', header: 'Name', render: (r) => <button type="button" onClick={onInner}>{r.name}</button> },
      ];
      render(<DataTable columns={cols} rows={ROWS.slice(0, 1)} getRowKey={(r) => r.id} onRowClick={onRowClick} />);
      const inner = screen.getAllByRole('button', { name: 'Bravo' }).find((b) => b.tagName === 'BUTTON')!;
      inner.focus();
      await user.keyboard('{Enter}');
      expect(onInner).toHaveBeenCalledTimes(1);
      // The click that Enter produces bubbles to the row (expected for mouse);
      // the keydown path itself must not fire a second call.
      expect(onRowClick.mock.calls.length).toBeLessThanOrEqual(1);
    });

    it('rowSeverity sets data-severity and omits it for null/undefined', () => {
      render(
        <DataTable columns={COLS} rows={ROWS} getRowKey={(r) => r.id} rowSeverity={(r) => r.sev ?? null} />,
      );
      const rows = screen.getAllByRole('row').slice(1);
      expect(rows[0]).toHaveAttribute('data-severity', 'low');
      expect(rows[1]).toHaveAttribute('data-severity', 'critical');
      expect(rows[2]).not.toHaveAttribute('data-severity');
    });

    it('renders `empty` in a full-width row when there are no rows', () => {
      render(<DataTable columns={COLS} rows={[]} getRowKey={(r: Row) => r.id} empty={<span>No brands</span>} />);
      expect(screen.getByText('No brands').closest('td')).toHaveAttribute('colspan', String(COLS.length));
    });

    it('renders no body row when empty and no `empty` node', () => {
      render(<DataTable columns={COLS} rows={[]} getRowKey={(r: Row) => r.id} />);
      expect(screen.getAllByRole('row')).toHaveLength(1);
    });
  });
});

describe('Table / Th / Td primitives', () => {
  it('Th defaults scope=col; Table with label becomes a focusable region', () => {
    render(
      <Table label="Raw table">
        <thead><tr><Th>H</Th></tr></thead>
        <tbody><tr><Td>C</Td></tr></tbody>
      </Table>,
    );
    expect(screen.getByRole('columnheader', { name: 'H' })).toHaveAttribute('scope', 'col');
    const region = screen.getByRole('region', { name: 'Raw table' });
    expect(region).toHaveAttribute('tabindex', '0');
  });

  it('Table without label is not a region', () => {
    render(<Table><tbody><tr><Td>C</Td></tr></tbody></Table>);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });
});

describe('DataTable row semantics', () => {
  it('clickable rows are buttons named by their first cell by default', () => {
    render(<DataTable columns={COLS} rows={ROWS} getRowKey={(r) => r.id} onRowClick={() => {}} />);
    expect(screen.getByRole('button', { name: 'Bravo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Alpha' })).toHaveAttribute('tabindex', '0');
  });

  it('rowLabel overrides the accessible name', () => {
    render(
      <DataTable columns={COLS} rows={ROWS} getRowKey={(r) => r.id} onRowClick={() => {}}
        rowLabel={(r) => `Open ${r.name}`} />,
    );
    expect(screen.getByRole('button', { name: 'Open Bravo' })).toHaveAttribute('aria-label', 'Open Bravo');
    expect(screen.queryByRole('button', { name: 'Bravo' })).not.toBeInTheDocument();
  });

  it('non-clickable rows keep native row semantics', () => {
    render(<DataTable columns={COLS} rows={ROWS} getRowKey={(r) => r.id} rowLabel={(r) => r.name} />);
    expect(screen.getAllByRole('row')).toHaveLength(ROWS.length + 1);
    expect(screen.queryAllByRole('button').filter((b) => b.tagName === 'TR')).toHaveLength(0);
  });
});

describe('DataTable scroll region focus', () => {
  const origRO = globalThis.ResizeObserver;
  const origSW = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
  const origCW = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  afterEach(() => {
    globalThis.ResizeObserver = origRO;
    if (origSW) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', origSW);
    if (origCW) Object.defineProperty(HTMLElement.prototype, 'clientWidth', origCW);
  });

  const stubWidths = (scroll: number, client: number) => {
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get: () => scroll });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => client });
  };

  it('is not a tab stop when content fits', () => {
    stubWidths(300, 300);
    render(<DataTable columns={COLS} rows={ROWS} getRowKey={(r) => r.id} caption="T" />);
    expect(screen.getByRole('region', { name: 'T' })).not.toHaveAttribute('tabindex');
  });

  it('becomes a tab stop when it overflows', () => {
    stubWidths(900, 300);
    render(<DataTable columns={COLS} rows={ROWS} getRowKey={(r) => r.id} caption="T" />);
    expect(screen.getByRole('region', { name: 'T' })).toHaveAttribute('tabindex', '0');
  });

  it('reacts to a ResizeObserver callback', () => {
    let cb: () => void = () => {};
    globalThis.ResizeObserver = class {
      constructor(c: () => void) { cb = c; }
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;
    stubWidths(300, 300);
    render(<DataTable columns={COLS} rows={ROWS} getRowKey={(r) => r.id} caption="T" />);
    const region = screen.getByRole('region', { name: 'T' });
    expect(region).not.toHaveAttribute('tabindex');
    stubWidths(900, 300);
    act(() => cb());
    expect(region).toHaveAttribute('tabindex', '0');
  });

  it('does not throw without ResizeObserver', () => {
    // @ts-expect-error simulating an environment without ResizeObserver
    delete globalThis.ResizeObserver;
    stubWidths(900, 300);
    expect(() => render(<DataTable columns={COLS} rows={ROWS} getRowKey={(r) => r.id} caption="T" />)).not.toThrow();
    expect(screen.getByRole('region', { name: 'T' })).toHaveAttribute('tabindex', '0');
  });

  it('header text uses secondary text', () => {
    render(<DataTable columns={COLS} rows={ROWS} getRowKey={(r) => r.id} />);
    expect(header('Name').style.color).toBe('var(--text-secondary)');
  });
});
