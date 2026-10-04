import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { MultiFeedConsensusPanel } from './MultiFeedConsensusPanel';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { get } }));

const ROW = {
  ip_address: '203.0.113.7', feed_count: 5, feeds: ['urlhaus', 'openphish', 'abuseipdb'],
  threat_count: 12, brand_count: 3, last_seen: '2026-10-03T10:00:00Z',
};

describe('MultiFeedConsensusPanel', () => {
  beforeEach(() => { get.mockReset(); });

  it('shows loading, not empty/error, while pending', () => {
    get.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<MultiFeedConsensusPanel />);
    expect(screen.getByText('Loading multi-feed consensus')).toBeInTheDocument();
    expect(screen.queryByText('No IPs flagged by 4+ feeds')).not.toBeInTheDocument();
    expect(screen.queryByText(/couldn't load/i)).not.toBeInTheDocument();
  });

  it('shows a retryable error, never the empty copy, when the request fails', async () => {
    get.mockRejectedValue(new Error('boom'));
    renderWithProviders(<MultiFeedConsensusPanel />);
    expect(await screen.findByText("Couldn't load multi-feed consensus")).toBeInTheDocument();
    expect(screen.queryByText('No IPs flagged by 4+ feeds')).not.toBeInTheDocument();
    get.mockResolvedValue({ success: true, data: [ROW] });
    await userEvent.setup().click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('203.0.113.7')).toBeInTheDocument();
  });

  it('shows the empty copy for an empty list', async () => {
    get.mockResolvedValue({ success: true, data: [] });
    renderWithProviders(<MultiFeedConsensusPanel />);
    expect(await screen.findByText('No IPs flagged by 4+ feeds')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/api/intel/multi-feed-consensus');
  });

  it('renders rows with feed names and links each to the Threats list filtered by IP', async () => {
    get.mockResolvedValue({ success: true, data: [ROW] });
    renderWithProviders(<MultiFeedConsensusPanel />);
    expect(await screen.findByText('203.0.113.7')).toBeInTheDocument();
    expect(screen.getByText('5 feeds')).toBeInTheDocument();
    expect(screen.getByText('openphish')).toBeInTheDocument();
    expect(screen.getByText(/12 threats · 3 brands · newest threat/)).toBeInTheDocument();
    expect(screen.queryByText(/first seen|last seen/i)).not.toBeInTheDocument();
    const link = screen.getByRole('link');
    const href = link.getAttribute('href') ?? '';
    expect(href).toContain('q=203.0.113.7');
    expect(href).toMatch(/threats/);
  });

  it('collapses and expands', async () => {
    get.mockResolvedValue({ success: true, data: [ROW] });
    renderWithProviders(<MultiFeedConsensusPanel />);
    await screen.findByText('203.0.113.7');
    const toggle = screen.getByRole('button', { name: /multi-feed consensus/i });
    await userEvent.setup().click(toggle);
    await waitFor(() => expect(screen.queryByText('203.0.113.7')).not.toBeInTheDocument());
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // aria-controls target stays in the DOM, hidden, while collapsed.
    expect(document.getElementById('multi-feed-consensus-body')).toHaveAttribute('hidden');
  });

  it('has a Corroboration header and an h3 toggle with aria-controls', async () => {
    get.mockResolvedValue({ success: true, data: [ROW] });
    renderWithProviders(<MultiFeedConsensusPanel />);
    await screen.findByText('203.0.113.7');
    expect(screen.getByRole('heading', { level: 2, name: 'Corroboration' })).toBeInTheDocument();
    const h3 = screen.getByRole('heading', { level: 3 });
    const toggle = within(h3).getByRole('button', { name: /multi-feed consensus/i });
    expect(toggle).toHaveClass('ds-focusable');
    expect(toggle).toHaveAttribute('aria-controls', 'multi-feed-consensus-body');
    expect(document.getElementById('multi-feed-consensus-body')).not.toBeNull();
  });

  it('uses singular copy for 1 threat / 1 brand / 1 feed', async () => {
    get.mockResolvedValue({ success: true, data: [{ ...ROW, feed_count: 1, threat_count: 1, brand_count: 1 }] });
    renderWithProviders(<MultiFeedConsensusPanel />);
    expect(await screen.findByText(/1 threat · 1 brand · newest threat/)).toBeInTheDocument();
    expect(screen.getByText('1 feed')).toBeInTheDocument();
  });

  it('caps at 5 rows with a Show all toggle', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...ROW, ip_address: `198.51.100.${i + 1}` }));
    get.mockResolvedValue({ success: true, data: many });
    renderWithProviders(<MultiFeedConsensusPanel />);
    await screen.findByText('198.51.100.1');
    expect(screen.getAllByRole('link')).toHaveLength(5);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Show all (8)' }));
    expect(screen.getAllByRole('link')).toHaveLength(8);
    await user.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(screen.getAllByRole('link')).toHaveLength(5);
  });

  it('does not show the toggle for 5 or fewer rows', async () => {
    get.mockResolvedValue({ success: true, data: [ROW] });
    renderWithProviders(<MultiFeedConsensusPanel />);
    await screen.findByText('203.0.113.7');
    expect(screen.queryByRole('button', { name: /show all/i })).not.toBeInTheDocument();
  });
});
