import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { WorkspaceEmbedProvider } from '@averrow/shared/ui';
import { PageHeader } from './PageHeader';

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname}</div>;
}

function renderAt(ui: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={['/agents/run-1']}>
      <Routes>
        <Route path="*" element={<>{ui}<Where /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ops PageHeader adapter', () => {
  it('renders the shared header (one h1, subtitle, actions)', () => {
    renderAt(<PageHeader title="Agents" subtitle="Fleet health" actions={<button type="button">Refresh</button>} />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('Fleet health')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });

  it('maps back.to to a router navigation', async () => {
    renderAt(<PageHeader title="Run" back={{ label: 'Agents', to: '/agents' }} />);
    await userEvent.click(screen.getByRole('button', { name: /Agents/ }));
    expect(screen.getByTestId('where')).toHaveTextContent('/agents');
  });

  it('back.onClick wins over back.to and does not navigate', async () => {
    const onClick = vi.fn();
    renderAt(<PageHeader title="Run" back={{ label: 'Back', to: '/agents', onClick }} />);
    await userEvent.click(screen.getByRole('button', { name: /Back/ }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('where')).toHaveTextContent('/agents/run-1');
  });

  it('renders no back control when `back` is omitted', () => {
    renderAt(<PageHeader title="Agents" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('drops the h1 and subtitle inside a workspace but keeps actions and the back control', () => {
    renderAt(
      <WorkspaceEmbedProvider>
        <PageHeader
          title="Agents"
          subtitle="Fleet health"
          back={{ label: 'Up', to: '/' }}
          actions={<button type="button">Refresh</button>}
        />
      </WorkspaceEmbedProvider>,
    );
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.queryByText('Fleet health')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Up/ })).toBeInTheDocument();
  });
});
