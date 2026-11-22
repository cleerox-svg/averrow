import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { stubMatchMedia } from '@/test/shared-ui/helpers';

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

import { api } from '@/lib/api';
import { Databases } from './Databases';
import { OperationsWorkspace } from '@/features/operations/OperationsWorkspace';
import { auditDb, databasesFixture, emptyMeterFixture } from './fixtures';
import { formatBytes, formatCount, formatTimeToFull, sourceNodes } from './format';
import { projectionPoints } from './DatabaseDetail';

const get = vi.mocked(api.get);

function renderAt(url: string, ui: React.ReactElement = <Databases />) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  stubMatchMedia(false);
  get.mockReset();
  get.mockResolvedValue({ success: true, data: databasesFixture });
});

describe('Databases — cards (default)', () => {
  it('renders the summary strip, one card per database and dashed proposed cards', async () => {
    renderAt('/admin/operations?tab=databases');
    const strip = await screen.findByRole('region', { name: 'Fleet summary' });
    expect(within(strip).getByText('6.10 GB')).toBeInTheDocument();
    expect(within(strip).getByText('1.44 B')).toBeInTheDocument();
    expect(within(strip).getByText('37')).toBeInTheDocument();

    for (const n of ['trust-radar-v2', 'geoip-db', 'trust-radar-dns-queue', 'trust-radar-v2-audit']) {
      expect(screen.getByRole('article', { name: `${n} database` })).toBeInTheDocument();
    }
    expect(screen.getByRole('article', { name: 'averrow-telemetry (proposed)' })).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'averrow-archive (proposed)' })).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/api/databases?window=24h');
  });

  it('shows capacity, status and time to full on the core card', async () => {
    renderAt('/');
    const card = await screen.findByRole('article', { name: 'trust-radar-v2 database' });
    expect(within(card).getByText('Overloaded')).toBeInTheDocument();
    expect(within(card).getByText('CORE')).toBeInTheDocument();
    expect(within(card).getByRole('progressbar')).toHaveAttribute('aria-valuetext', '54% of 10.0 GB');
    expect(within(card).getByText(/months to full/)).toBeInTheDocument();
    expect(within(card).getByText('threat_cube_geo')).toBeInTheDocument();
    expect(within(card).getByText('Main reader (Cartographer) paused 31 h')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Open details for trust-radar-v2' }))
      .toHaveAttribute('href', '/admin/operations?tab=databases&db=core');
  });

  it('renders nulls as dashes / "not measured yet", never zero', async () => {
    renderAt('/');
    const card = await screen.findByRole('article', { name: 'trust-radar-v2-audit database' });
    expect(within(card).getByText('Unknown')).toBeInTheDocument();
    expect(within(card).getAllByText('—').length).toBeGreaterThanOrEqual(3);
    expect(within(card).getByText('not measured yet')).toBeInTheDocument();
    expect(within(card).getByText('Size not measured yet')).toBeInTheDocument();
    expect(within(card).getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  });

  it('shows a dash for the overload tile when the meter has no data', async () => {
    get.mockResolvedValue({ success: true, data: emptyMeterFixture });
    renderAt('/');
    const strip = await screen.findByRole('region', { name: 'Fleet summary' });
    expect(within(strip).getAllByText('Not measured yet').length).toBeGreaterThanOrEqual(2);
  });

  it('flags fail-soft sections', async () => {
    get.mockResolvedValue({ success: true, data: { ...databasesFixture, edges_error: 'meter down' } });
    renderAt('/');
    expect(await screen.findByText(/could not be loaded \(edges\)/)).toBeInTheDocument();
  });
});

describe('Databases — states', () => {
  it('shows loading then an error with retry', async () => {
    get.mockRejectedValue(new Error('boom'));
    renderAt('/');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load databases");
    expect(within(alert).getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});

describe('Databases — table view', () => {
  it('renders an accessible table of the same data', async () => {
    renderAt('/?view=table');
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Reads · cycle' })).toBeInTheDocument();
    const row = within(table).getByRole('row', { name: /trust-radar-v2 CORE/ });
    expect(within(row).getByText('5.42 GB')).toBeInTheDocument();
    const auditRow = within(table).getByRole('row', { name: /trust-radar-v2-audit/ });
    expect(within(auditRow).getAllByText('—').length).toBeGreaterThanOrEqual(5);
    expect(within(table).getByText(/averrow-telemetry/)).toBeInTheDocument();
  });

  it('switches views with the Cards / Map / Table toggle', async () => {
    const user = userEvent.setup();
    renderAt('/');
    await screen.findByRole('region', { name: 'Databases' });
    await user.click(screen.getByRole('button', { name: 'Table' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Cards' }));
    expect(await screen.findByRole('region', { name: 'Databases' })).toBeInTheDocument();
  });
});

describe('Databases — map view', () => {
  it('draws one selectable line per edge with overload and idle states', async () => {
    renderAt('/?view=map');
    const lines = await screen.findAllByRole('button', { name: /rows read/ });
    expect(lines).toHaveLength(databasesFixture.edges.length);
    const nav = screen.getByRole('button', { name: /navigator to trust-radar-v2: .*9 overloads/ });
    expect(nav).toHaveAttribute('data-overload', 'true');
    expect(screen.getByRole('button', { name: /cartographer to geoip-db: 0 rows read/ })).toHaveAttribute('data-idle', 'true');
    // heaviest edge is selected by default
    expect(screen.getByRole('region', { name: 'Selected line' })).toHaveTextContent('navigator to trust-radar-v2');
  });

  it('selects an edge on click and from the table fallback', async () => {
    const user = userEvent.setup();
    renderAt('/?view=map');
    await user.click(await screen.findByRole('button', { name: /^nexus to trust-radar-v2:/ }));
    expect(screen.getByRole('region', { name: 'Selected line' })).toHaveTextContent('nexus to trust-radar-v2');
    await user.click(screen.getByRole('button', { name: 'Inspect cube_healer to trust-radar-v2' }));
    expect(screen.getByRole('region', { name: 'Selected line' })).toHaveTextContent('cube_healer to trust-radar-v2');
    expect(screen.getByRole('region', { name: 'Selected line' })).toHaveTextContent('See cube_healer in Agents');
  });

  it('refetches when the window changes and shows legend + proposed note', async () => {
    const user = userEvent.setup();
    renderAt('/?view=map');
    await screen.findByRole('region', { name: 'Legend' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Window' }), '1h');
    await waitFor(() => expect(get).toHaveBeenCalledWith('/api/databases?window=1h'));
    expect(screen.getByRole('region', { name: 'After the split (proposed)' })).toHaveTextContent('averrow-telemetry');
  });

  it('shows an empty note when no edges are recorded', async () => {
    get.mockResolvedValue({ success: true, data: { ...databasesFixture, edges: [] } });
    renderAt('/?view=map');
    expect(await screen.findByText(/No per-job reads recorded/)).toBeInTheDocument();
  });
});

describe('Databases — detail', () => {
  it('renders KPIs, projection chart, overloads, tables and jobs for a store', async () => {
    renderAt('/admin/operations?tab=databases&db=core');
    expect(await screen.findByRole('heading', { name: 'trust-radar-v2' })).toBeInTheDocument();
    expect(screen.getByText('Overloaded')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← All databases' })).toHaveAttribute('href', '/admin/operations?tab=databases');
    expect(screen.getByRole('img', { name: /grew from .* to 5\.42 GB.*reaches 10\.0 GB/ })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /19 overload rejections over the last 24 hours\. Peak 14/ })).toBeInTheDocument();
    expect(screen.getByText('threat_cube_brand')).toBeInTheDocument();
    expect(screen.getByText('navigator')).toBeInTheDocument();
    expect(screen.getByText('Straight-line from the size history; dashed line is the projection to the limit.', { exact: false })).toBeInTheDocument();
  });

  it('says "not measured yet" for null overloads and missing history', async () => {
    renderAt('/?db=audit');
    expect(await screen.findByRole('heading', { name: 'trust-radar-v2-audit' })).toBeInTheDocument();
    expect(screen.getByText(/Overloads not measured yet/)).toBeInTheDocument();
    expect(screen.getByText(/Not enough size history yet/)).toBeInTheDocument();
    expect(screen.getByText('Table sizes not measured yet.')).toBeInTheDocument();
    expect(screen.getByText('size unavailable')).toBeInTheDocument();
  });

  it('handles a store with no overload measurements but other data', async () => {
    renderAt('/?db=geo');
    expect(await screen.findByRole('heading', { name: 'geoip-db' })).toBeInTheDocument();
    expect(screen.getByText(/Overloads not measured yet/)).toBeInTheDocument();
    expect(screen.getByText('Flat, not growing', { exact: false })).toBeInTheDocument();
  });

  it('reports an unknown store', async () => {
    renderAt('/?db=nope');
    expect(await screen.findByText('Database not found')).toBeInTheDocument();
  });
});

describe('Operations workspace tab', () => {
  it('mounts Databases at ?tab=databases', async () => {
    renderAt('/admin/operations?tab=databases', <OperationsWorkspace />);
    expect(await screen.findByRole('region', { name: 'Fleet summary' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Databases' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('format helpers', () => {
  it('formats bytes, counts and nulls', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(848 * 1024)).toBe('848 KB');
    expect(formatBytes(5.42 * 1024 ** 3)).toBe('5.42 GB');
    expect(formatCount(null)).toBe('—');
    expect(formatCount(54_200_000)).toBe('54.2 M');
    expect(formatCount(950)).toBe('950');
  });
  it('describes time to full', () => {
    expect(formatTimeToFull({ days_to_cap: null, growth_bytes_per_day: null })).toBe('Not enough history yet');
    expect(formatTimeToFull({ days_to_cap: null, growth_bytes_per_day: 0 })).toBe('Flat, not growing');
    expect(formatTimeToFull({ days_to_cap: 20, growth_bytes_per_day: 5 })).toBe('≈ 20 days to full');
    expect(formatTimeToFull({ days_to_cap: 213, growth_bytes_per_day: 5 })).toBe('≈ 7 months to full');
  });
  it('groups source nodes and projects to the cap', () => {
    const nodes = sourceNodes(databasesFixture.edges);
    expect(nodes.find((n) => n.source === 'navigator')?.rows_read).toBe(6_955_000);
    expect(nodes[0]?.kind).toBe('agent');
    const core = databasesFixture.databases[0]!;
    const { history, projection } = projectionPoints(core);
    expect(history).toHaveLength(4);
    expect(projection).toHaveLength(2);
    expect(projectionPoints(auditDb).projection).toEqual([]);
  });
});

describe('review fixes', () => {
  it('words the thresholds from the payload with 50/80 defaults and draws both markers', async () => {
    renderAt('/');
    const card = await screen.findByRole('article', { name: 'trust-radar-v2 database' });
    expect(within(card).getByText(/Check at 50% · critical at 80%/)).toBeInTheDocument();
    expect(card.querySelectorAll('.dbp-bar-mark')).toHaveLength(2);
  });

  it('uses threshold fields when the server sends them', async () => {
    get.mockResolvedValue({ success: true, data: { ...databasesFixture, summary: { ...databasesFixture.summary, warn_size_fraction: 0.6, critical_size_fraction: 0.9 } } });
    renderAt('/');
    const card = await screen.findByRole('article', { name: 'trust-radar-v2 database' });
    expect(within(card).getByText(/Check at 60% · critical at 90%/)).toBeInTheDocument();
  });

  it('labels overloads as from metered jobs and the plan figure as projected', async () => {
    renderAt('/');
    const strip = await screen.findByRole('region', { name: 'Fleet summary' });
    expect(within(strip).getByText(/from metered jobs/)).toBeInTheDocument();
    expect(within(strip).getByText(/projected % of 25 B plan/)).toBeInTheDocument();
  });

  it('carries the window through card and detail links', async () => {
    renderAt('/?window=cycle');
    const link = await screen.findByRole('link', { name: 'Open details for trust-radar-v2' });
    expect(link).toHaveAttribute('href', '/admin/operations?tab=databases&db=core&window=cycle');
  });

  it('labels detail top jobs with the window and keeps it on the back link', async () => {
    renderAt('/?db=core&window=1h');
    expect(await screen.findByRole('heading', { name: /Top jobs · last hour/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← All databases' })).toHaveAttribute('href', '/admin/operations?tab=databases&window=1h');
  });

  it('shows no projection and "At or over the cap" when size >= cap', async () => {
    const core = databasesFixture.databases[0]!;
    const over = { ...core, size_bytes: core.cap_bytes + 1, size_history: [...core.size_history.slice(0, 3), { date: '2026-11-22', bytes: core.cap_bytes + 1 }] };
    expect(projectionPoints(over).projection).toEqual([]);
    get.mockResolvedValue({ success: true, data: { ...databasesFixture, databases: [over] } });
    renderAt('/?db=core');
    expect(await screen.findByRole('img', { name: /at or over the cap/ })).toBeInTheDocument();
    expect(screen.getAllByText('At or over the cap').length).toBeGreaterThan(0);
    expect(screen.queryByRole('img', { name: /reaches/ })).toBeNull();
  });

  it('map: no Web & API group without http edges, and red means rejected statements', async () => {
    renderAt('/?view=map');
    await screen.findByRole('region', { name: 'Legend' });
    expect(screen.queryByText('Web & API', { selector: 'text' })).toBeNull();
    expect(screen.getByText(/Statements rejected \(overloaded\)/)).toBeInTheDocument();
  });
});
