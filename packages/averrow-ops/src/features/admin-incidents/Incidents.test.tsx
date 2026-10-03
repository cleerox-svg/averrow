import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';

const mocks = vi.hoisted(() => ({ incidents: [] as unknown[] }));
vi.mock('./useIncidents', () => ({
  useIncidents: () => ({ data: mocks.incidents, isLoading: false }),
  useCreateIncident: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}));

import { AdminIncidents } from './Incidents';

const base = {
  id: 'i1', title: 'Feed ingestion degraded', severity: 'high', status: 'investigating',
  created_at: new Date().toISOString(), affected_components: [], visibility: 'internal', source: 'manual',
};

describe('AdminIncidents', () => {
  it('associates every create-panel label with its control', () => {
    mocks.incidents = [];
    renderWithProviders(<AdminIncidents />);
    fireEvent.click(screen.getByRole('button', { name: 'New incident' }));
    expect(screen.getByLabelText('Title')).toBeInstanceOf(HTMLInputElement);
    expect(screen.getByLabelText('Description (optional)')).toBeInstanceOf(HTMLInputElement);
    expect(screen.getByLabelText('Severity')).toBeInstanceOf(HTMLSelectElement);
    expect(screen.getByLabelText(/Affected components/)).toBeInstanceOf(HTMLInputElement);
  });

  it('colours status pills with theme-aware tokens, not raw hex', () => {
    mocks.incidents = [base, { ...base, id: 'i2', status: 'resolved' }];
    renderWithProviders(<AdminIncidents />);
    const pill = screen.getByText('investigating');
    expect(pill.style.color).toBe('var(--sev-critical-text)');
    expect(pill.style.background).toContain('var(--sev-critical-bg)');
    expect(screen.getByText('resolved').style.color).toBe('var(--sev-info-text)');
  });
});
