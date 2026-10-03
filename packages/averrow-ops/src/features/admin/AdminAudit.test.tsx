import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/utils';
import { AdminAudit } from './AdminAudit';
import type { AuditEntry } from '@/hooks/useAuditLog';

const ENTRIES: AuditEntry[] = [
  {
    id: 'evt-1', timestamp: '2026-10-01 10:00:00', user_id: 'usr_1', action: 'brand.update',
    resource_type: 'brand', resource_id: 'b1', details: '{"k":1}', ip_address: '10.0.0.1',
    user_agent: 'UA', outcome: 'success',
  },
  {
    id: 'evt-2', timestamp: '2026-10-01 09:00:00', user_id: null, action: 'login',
    resource_type: null, resource_id: null, details: null, ip_address: null,
    user_agent: null, outcome: 'denied',
  },
];

vi.mock('@/hooks/useAuditLog', () => ({
  useAuditLog: () => ({
    data: { entries: ENTRIES, total: 2, stats: null, resourceTypes: [] },
    isLoading: false, isError: false, isPlaceholderData: false, refetch: vi.fn(),
  }),
}));

describe('AdminAudit table rows', () => {
  it('keeps rows as native rows with a labelled disclosure button that toggles on Enter and Space', async () => {
    renderWithProviders(<AdminAudit />);
    expect(screen.getByRole('table')).toBeInTheDocument();

    // Rows are not buttons: cell + row semantics survive.
    expect(screen.getAllByRole('row').length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByRole('cell').length).toBeGreaterThan(0);

    const toggle = screen.getByRole('button', { name: /brand\.update success.*expand details/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', 'audit-detail-evt-1');
    expect(screen.queryByText('Event ID')).toBeNull();

    toggle.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByText('Event ID')).toBeInTheDocument();
    const open = screen.getByRole('button', { name: /brand\.update success.*collapse details/ });
    expect(open).toHaveAttribute('aria-expanded', 'true');
    // aria-controls points at the expansion row
    expect(document.getElementById(open.getAttribute('aria-controls')!)).toContainElement(screen.getByText('Event ID'));

    await userEvent.keyboard(' ');
    expect(screen.queryByText('Event ID')).toBeNull();
  });

  it('a mouse click on the row still toggles (once)', async () => {
    renderWithProviders(<AdminAudit />);
    await userEvent.click(within(screen.getByRole('table')).getByText('brand.update'));
    expect(screen.getByText('Event ID')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /brand\.update success.*collapse details/ }));
    expect(screen.queryByText('Event ID')).toBeNull();
  });

  it('keeps the resource link accessible and not toggling the row', async () => {
    renderWithProviders(<AdminAudit />);
    const link = screen.getByRole('link', { name: /brand: b1/ });
    await userEvent.click(link);
    expect(screen.queryByText('Event ID')).toBeNull();
  });

  it('renders outcome chips from theme-aware severity tokens', () => {
    renderWithProviders(<AdminAudit />);
    const table = within(screen.getByRole('table'));
    const chip = table.getByText('brand.update');
    expect(chip.style.color).toBe('var(--sev-info-text)');
    expect(chip.style.background).toContain('var(--sev-info-bg)');
    expect(table.getByText('login').style.color).toBe('var(--sev-medium-text)');
  });

  it('renders the expansion panel flat (no glass shadow)', async () => {
    renderWithProviders(<AdminAudit />);
    await userEvent.click(within(screen.getByRole('table')).getByText('brand.update'));
    const detail = document.getElementById('audit-detail-evt-1')!;
    const card = detail.querySelector('td > div') as HTMLElement;
    expect(card.style.boxShadow).toBe('none');
    expect(card.style.backdropFilter).toBe('');
  });
});
