import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Shell } from './Shell';

// Facelift polish for the tenant shell: sentence-case sans labels (>= 12px),
// tokens instead of white-alpha / hex / rgba, mono only for facts.

vi.mock('@/lib/auth', () => ({
  useAuth: vi.fn(() => ({
    user: {
      id: 'u1', email: 'jane@acme.test', name: 'Jane Doe', display_name: 'Jane Doe',
      organization: { id: 'org1', name: 'Acme', role: 'admin', plan: 'professional' },
    },
    loading: false,
    logout: vi.fn(),
  })),
}));
vi.mock('@/lib/modules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/modules')>();
  return {
    ...actual,
    useTenantModules: () => ({
      data: { modules: [
        { module_key: 'social', status: 'trial', metrics: [] },
        { module_key: 'dark_web', status: 'not_entitled', metrics: [] },
      ] },
      isLoading: false,
    }),
  };
});
vi.mock('@/lib/auditLog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auditLog')>();
  return { ...actual, useCanViewAudit: () => false };
});
vi.mock('@/lib/useTheme', () => ({ useTheme: () => ({ theme: 'dark', cycle: vi.fn() }) }));

const FILES = ['TopBar.tsx', 'Sidebar.tsx', 'Shell.tsx'];
const src = (f: string) => readFileSync(resolve(__dirname, f), 'utf8');

describe('tenant shell facelift', () => {
  it.each(FILES)('%s uses tokens only (no uppercase, white-alpha, hex, rgba, amber text)', (f) => {
    const code = src(f);
    expect(code).not.toMatch(/\buppercase\b/);
    expect(code).not.toMatch(/text-white\//);
    expect(code).not.toMatch(/white\/\[/);
    expect(code).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(code).not.toMatch(/rgba?\(/);
    expect(code).not.toMatch(/\b(text|bg|border|ring)-amber\b/);
    expect(code).not.toMatch(/text-\[1[01]px\]/);
  });

  it.each(FILES)('%s keeps mono for facts only (email, version)', (f) => {
    // TopBar: email in the trigger + menu; Sidebar: version footer.
    const allowed: Record<string, number> = { 'TopBar.tsx': 2, 'Sidebar.tsx': 1, 'Shell.tsx': 0 };
    const monoLines = src(f).split('\n').filter((l) => l.includes('font-mono'));
    expect(monoLines.length).toBe(allowed[f]);
    for (const l of monoLines) expect(l).not.toMatch(/Organization|Upgrade|Trial|Loading/);
  });

  it('header establishes the stacking order so the user menu covers <main>', () => {
    expect(src('TopBar.tsx')).toMatch(/<header className="relative z-30 /);
  });

  it('renders sentence-case labels', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/console']}>
          <Routes>
            <Route element={<Shell />}>
              <Route path="*" element={<div>page</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    for (const t of ['Organization', 'Workspace', 'Modules', 'Unlock', 'Account', 'Trial', 'Upgrade']) {
      expect(screen.getByText(t)).toBeInTheDocument();
    }
  });
});
