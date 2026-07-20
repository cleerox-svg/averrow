import React from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

// Mirrors averrow-ops's src/test/utils.tsx render-helper pattern — this
// file itself is new in averrow-tenant (EXEC_IMPERSONATION_2026-07 Stage
// 5, added alongside vitest.config.ts to wire up a runnable jsdom + RTL
// harness; `vitest` the package already existed, just unused). MemoryRouter
// (not BrowserRouter) so tests don't touch the real browser history/URL.
function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

interface WrapperProps {
  children: React.ReactNode;
}

function AllProviders({ children }: WrapperProps) {
  const queryClient = createTestQueryClient();
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

export function renderWithProviders(
  ui: React.ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>,
) {
  return render(ui, { wrapper: AllProviders, ...options });
}

export { render };
