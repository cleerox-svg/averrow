import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RouterProvider, createMemoryRouter, useLocation } from 'react-router-dom';
import { PageHeader } from './PageHeader';

function Loc() { const l = useLocation(); return <div data-testid="loc">{l.pathname}</div>; }
function setup(entries: string[], index: number, back: Parameters<typeof PageHeader>[0]['back']) {
  const router = createMemoryRouter(
    [
      { path: '/prev', element: <Loc /> },
      { path: '/page', element: <><Loc /><PageHeader title="T" back={back} /></> },
      { path: '/parent', element: <Loc /> },
    ],
    { initialEntries: entries, initialIndex: index },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe('ops PageHeader back', () => {
  it('fallback: returns to the previous in-app screen when there is one', async () => {
    const router = setup(['/prev'], 0, { label: 'Back', fallback: '/parent' });
    await router.navigate('/page');
    fireEvent.click(await screen.findByRole('button', { name: /Back/ }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/prev'));
  });

  it('fallback: goes to the parent (replace) on a cold start', async () => {
    const router = setup(['/page'], 0, { label: 'Back', fallback: '/parent' });
    fireEvent.click(await screen.findByRole('button', { name: /Back/ }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/parent'));
    expect(router.state.historyAction).toBe('REPLACE');
  });

  it('legacy `to` still navigates to the fixed target', async () => {
    const router = setup(['/prev'], 0, { label: 'Back', to: '/parent' });
    await router.navigate('/page');
    fireEvent.click(await screen.findByRole('button', { name: /Back/ }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/parent'));
  });
});
