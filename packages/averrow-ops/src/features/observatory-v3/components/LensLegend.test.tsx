import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { OperationGeo } from '@/hooks/useObservatoryLenses';
import { OperationsSection } from './LensLegend';
import { buildOperationsModel } from '../lib/lens/operations';

const op = (id: string, countries: string[]): OperationGeo => ({
  id, name: id, component_id: null, kind: 'asn', status: 'active', confidence_score: 80, threat_count: 10, actor: null,
  countries, asns: [], last_seen: null, last_movement_pivot_at: null,
});
const q = { isLoading: false, error: null, refetch: async () => undefined };

describe('Operations legend', () => {
  const view = () => render(<OperationsSection s={{ model: buildOperationsModel([op('a', ['US', 'DE']), op('b', ['US', 'NL'])], []), q }} />);

  it('says where links radiate from, and drops the old "ASN ×count" wording', () => {
    view();
    expect(screen.getByText(/Links radiate from each operation.s busiest country/)).toBeInTheDocument();
    expect(screen.queryByText(/×count/)).not.toBeInTheDocument();
  });
  it('shows the link scale for 1, 3 and 5+ operations', () => {
    view();
    const scale = screen.getByTestId('ops-edge-scale');
    expect(scale.textContent).toContain('1');
    expect(scale.textContent).toContain('3');
    expect(scale.textContent).toContain('5+');
    expect(scale.textContent).toContain('operations share a link');
  });
});
