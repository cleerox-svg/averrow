import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SecuritySection } from '../../../../shared/src/profile/sections';

const session = (id: string) => ({ id, created_at: '2026-01-01', last_used_at: '2026-01-02', user_agent: 'UA', ip_address: '1.1.1.1', current: false });

describe('SecuritySection revoke', () => {
  it('keeps the success toast and the old list when the post-revoke refresh fails', async () => {
    const onToast = vi.fn();
    const get = vi.fn()
      .mockResolvedValueOnce({ success: true, data: { total: 2, sessions: [session('a'), session('b')] } })
      .mockRejectedValueOnce(new Error('refresh 500'));
    const post = vi.fn().mockResolvedValue({ success: true });
    const apiClient = { get, post, patch: vi.fn(), delete: vi.fn() };

    render(<SecuritySection apiClient={apiClient as never} onToast={onToast} />);
    await screen.findByText('2 active sessions');

    await userEvent.setup().click(screen.getByRole('button', { name: 'Revoke other sessions' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/couldn't be refreshed/i));
    expect(onToast).toHaveBeenCalledWith('Other sessions revoked.', 'success');
    expect(onToast).not.toHaveBeenCalledWith(expect.anything(), 'error');
    // Old list is kept.
    expect(screen.getByText('2 active sessions')).toBeInTheDocument();
  });

  it('refreshes the list and shows no note when the refresh succeeds', async () => {
    const onToast = vi.fn();
    const get = vi.fn()
      .mockResolvedValueOnce({ success: true, data: { total: 2, sessions: [session('a'), session('b')] } })
      .mockResolvedValueOnce({ success: true, data: { total: 1, sessions: [session('a')] } });
    const apiClient = { get, post: vi.fn().mockResolvedValue({ success: true }), patch: vi.fn(), delete: vi.fn() };

    render(<SecuritySection apiClient={apiClient as never} onToast={onToast} />);
    await screen.findByText('2 active sessions');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Revoke other sessions' }));

    await screen.findByText('1 active session');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('a failing revoke POST still shows the error toast', async () => {
    const onToast = vi.fn();
    const get = vi.fn().mockResolvedValue({ success: true, data: { total: 1, sessions: [] } });
    const apiClient = { get, post: vi.fn().mockRejectedValue(new Error('nope')), patch: vi.fn(), delete: vi.fn() };
    render(<SecuritySection apiClient={apiClient as never} onToast={onToast} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Revoke other sessions' }));
    await waitFor(() => expect(onToast).toHaveBeenCalledWith('nope', 'error'));
  });
});
