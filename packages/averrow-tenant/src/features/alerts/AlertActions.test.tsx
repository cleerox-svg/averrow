import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AssigneeControl, StaffTriageNote, STAFF_READONLY_NOTE } from './AlertActions';
import type { Alert } from '@/lib/alerts';

vi.mock('@/lib/auth', () => ({ useAuth: vi.fn(() => ({ user: { id: 'usr_me' } })) }));

function alertWith(over: Partial<Alert>): Alert {
  return { id: 'a1', assigned_to: null, assigned_to_name: null, ...over } as Alert;
}

function r(ui: React.ReactElement) {
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('AssigneeControl — Averrow SOC assignee', () => {
  it('renders "Averrow SOC" read-only when assigned_to is null', () => {
    r(<AssigneeControl alert={alertWith({ assigned_to_name: 'Averrow SOC', handled_by_averrow: true })} canTriage={false} />);
    expect(screen.getByText('Averrow SOC')).toBeInTheDocument();
    expect(screen.queryByText(/unassigned/i)).not.toBeInTheDocument();
  });

  it('falls back to Averrow SOC when only handled_by_averrow is set', () => {
    r(<AssigneeControl alert={alertWith({ handled_by_averrow: true })} canTriage={false} />);
    expect(screen.getByText('Averrow SOC')).toBeInTheDocument();
  });

  it('shows the name chip for triagers', () => {
    r(<AssigneeControl alert={alertWith({ assigned_to_name: 'Averrow SOC', handled_by_averrow: true })} canTriage />);
    expect(screen.getByText('Averrow SOC')).toBeInTheDocument();
  });

  it('offers "Take over" when Averrow SOC holds the alert', () => {
    r(<AssigneeControl alert={alertWith({ assigned_to_name: 'Averrow SOC', handled_by_averrow: true })} canTriage />);
    expect(screen.getByText('Take over')).toBeInTheDocument();
    expect(screen.queryByText(/Reassign to me/)).not.toBeInTheDocument();
  });

  it('keeps "Reassign to me" for a customer-held alert', () => {
    r(<AssigneeControl alert={alertWith({ assigned_to: 'usr_x', assigned_to_name: 'Pat' })} canTriage />);
    expect(screen.getByText('Reassign to me')).toBeInTheDocument();
  });

  it('renders nothing for an unassigned read-only alert', () => {
    const { container } = r(<AssigneeControl alert={alertWith({})} canTriage={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('StaffTriageNote', () => {
  it('renders the read-only staff note', () => {
    render(<StaffTriageNote />);
    expect(screen.getByRole('note')).toHaveTextContent(STAFF_READONLY_NOTE);
  });
});
