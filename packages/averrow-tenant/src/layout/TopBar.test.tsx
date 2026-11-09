import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { TopBar } from './TopBar';
import { useAuth } from '@/lib/auth';

vi.mock('@/lib/auth', () => ({ useAuth: vi.fn() }));

function open(organization: Record<string, unknown>) {
  vi.mocked(useAuth).mockReturnValue({
    user: { id: 'u1', email: 'jane@acme.test', name: 'Jane', display_name: 'Jane', organization },
    logout: vi.fn(),
  } as unknown as ReturnType<typeof useAuth>);
  render(<MemoryRouter><TopBar /></MemoryRouter>);
  return userEvent.click(screen.getByRole('button', { expanded: false }));
}

describe('TopBar user menu role line', () => {
  it('shows "Admin · Professional" in sentence case', async () => {
    await open({ id: 'o', name: 'Acme', role: 'admin', plan: 'professional' });
    expect(screen.getByText('Admin · Professional')).toBeInTheDocument();
  });

  it('has no dangling separator when the plan is missing', async () => {
    await open({ id: 'o', name: 'Acme', role: 'owner' });
    expect(screen.getByText('Owner')).toBeInTheDocument();
  });
});
