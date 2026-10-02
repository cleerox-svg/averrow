// Real hooks + real apiFetch: a JSON { success:false } 500 (and a 200 envelope
// reporting success:false) must surface Console's ErrorCard, not an all-clear.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/utils';
import { Console } from './Console';

vi.mock('@/lib/auth', () => ({
  useAuth: vi.fn(() => ({ user: { organization: { id: 'org1' } }, hasOrg: true })),
}));

function stubFetch(status: number) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ success: false, error: 'internal' }), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

describe('Console — API { success:false } responses', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it.each([500, 200])('shows the ErrorCard (status %i), not "all caught up"', async (status) => {
    stubFetch(status);
    renderWithProviders(<Console />);

    await waitFor(() =>
      expect(screen.getByText("Couldn't load items needing you")).toBeInTheDocument(),
    );
    expect(screen.queryByText("You're all caught up")).not.toBeInTheDocument();
  });
});
