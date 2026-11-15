import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, render } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { api } from '@/lib/api';
import { InfobloxReferenceBlock, ThreatInfobloxReference, type InfobloxReferenceData } from './InfobloxReference';

vi.mock('@/lib/api', () => ({ api: { get: vi.fn() } }));

const NOTE = "Infoblox's published label for this indicator, shown as staff context. It is not an Averrow attribution.";
const CREDIT = 'Source: Infoblox Threat Intel, infobloxopen/threat-intelligence (CC BY 4.0). Indicators normalised and subset by Averrow.';

function ref(over: Partial<InfobloxReferenceData> = {}): InfobloxReferenceData {
  return {
    label_note: NOTE,
    credit: CREDIT,
    licence_url: 'https://creativecommons.org/licenses/by/4.0/',
    matches: [
      {
        indicator: 'evil.example', indicator_type: 'domain', match: 'exact', infoblox_label: 'VexTrio', label_kind: 'actor',
        classification: null, detected_date: '2025-08-06', source_file: 'a.csv',
        publication_url: 'https://blogs.infoblox.com/x/', updated_at: '2026-11-15',
      },
      {
        indicator: 'example.org', indicator_type: 'domain', match: 'parent_domain', infoblox_label: 'Some campaign', label_kind: 'campaign',
        classification: null, detected_date: null, source_file: 'b.csv', publication_url: null, updated_at: '2026-11-15',
      },
    ],
    ...over,
  };
}

describe('InfobloxReferenceBlock', () => {
  it('renders matches, note and credit from the response', () => {
    render(<InfobloxReferenceBlock reference={ref()} />);
    expect(screen.getByRole('region', { name: 'Infoblox reference' })).toBeInTheDocument();
    expect(screen.getByText('VexTrio')).toBeInTheDocument();
    expect(screen.getByText(/· actor/)).toBeInTheDocument();
    expect(screen.getByText(/· campaign/)).toBeInTheDocument();
    expect(screen.getByText('evil.example')).toBeInTheDocument();
    expect(screen.getByText(/exact match/)).toBeInTheDocument();
    expect(screen.getByText(/parent domain/)).toBeInTheDocument();
    expect(screen.getByText(NOTE)).toBeInTheDocument();
    expect(document.querySelector('[data-credit]')?.textContent).toContain(CREDIT);
    const pub = screen.getByRole('link', { name: /Infoblox publication/ });
    expect(pub).toHaveAttribute('href', 'https://blogs.infoblox.com/x/');
    expect(pub).toHaveAttribute('rel', 'noopener noreferrer');
    expect(pub).toHaveAttribute('target', '_blank');
    const lic = screen.getByRole('link', { name: /Licence/ });
    expect(lic).toHaveAttribute('href', 'https://creativecommons.org/licenses/by/4.0/');
    expect(lic).toHaveAttribute('rel', 'noopener noreferrer');
    // only one publication link: the match without a URL has none
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });

  it('drops a non-http publication url', () => {
    const r = ref();
    r.matches[0].publication_url = 'javascript:alert(1)';
    render(<InfobloxReferenceBlock reference={r} />);
    expect(screen.queryByRole('link', { name: /Infoblox publication/ })).toBeNull();
  });

  it('renders nothing for null, undefined or no matches', () => {
    const a = render(<InfobloxReferenceBlock reference={null} />);
    expect(a.container).toBeEmptyDOMElement();
    const b = render(<InfobloxReferenceBlock reference={undefined} />);
    expect(b.container).toBeEmptyDOMElement();
    const c = render(<InfobloxReferenceBlock reference={ref({ matches: [] })} />);
    expect(c.container).toBeEmptyDOMElement();
  });
});

describe('ThreatInfobloxReference', () => {
  beforeEach(() => vi.mocked(api.get).mockReset());

  it('does not fetch until opened, then fetches the detail once', async () => {
    vi.mocked(api.get).mockResolvedValue({ success: true, data: { infoblox_reference: ref() } });
    const { rerender } = renderWithProviders(<ThreatInfobloxReference threatId="t1" open={false} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(api.get).not.toHaveBeenCalled();
    rerender(<ThreatInfobloxReference threatId="t1" open />);
    await waitFor(() => expect(screen.getByText('VexTrio')).toBeInTheDocument());
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith('/api/threats/t1');
  });

  it('renders nothing when the detail has a null reference', async () => {
    vi.mocked(api.get).mockResolvedValue({ success: true, data: { infoblox_reference: null } });
    renderWithProviders(<ThreatInfobloxReference threatId="t2" open />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('region', { name: 'Infoblox reference' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/Infoblox|no match/i);
  });
});
