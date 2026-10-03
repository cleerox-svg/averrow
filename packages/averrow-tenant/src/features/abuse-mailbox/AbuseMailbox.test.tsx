import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DeterminationPanel, DeterminationBadge } from './AbuseMailbox';

const d = {
  label: 'Needs human review',
  tone: 'review' as const,
  lead: 'We could not tell for certain.',
  analyst_note: 'Reviewed automatically.',
  next_steps: ['Do not click links', 'Wait for our reply'],
  action_label: 'Queued for analyst review',
};

describe('DeterminationPanel (tenant)', () => {
  it('renders verdict, note, steps, action and sent time', () => {
    render(<DeterminationPanel determination={d} sentAt="2026-10-01 10:00:00" />);
    expect(screen.getByText('Needs human review')).toBeInTheDocument();
    expect(screen.getByText(d.lead)).toBeInTheDocument();
    expect(screen.getByText('Analyst note')).toBeInTheDocument();
    expect(screen.getByText('Wait for our reply')).toBeInTheDocument();
    expect(screen.getByText('Queued for analyst review')).toBeInTheDocument();
    expect(screen.getByText(/2026-10-01 10:00:00/)).toBeInTheDocument();
  });

  it('shows "Not sent yet" and pending states', () => {
    const { unmount } = render(<DeterminationPanel determination={d} sentAt={null} />);
    expect(screen.getByText(/Not sent yet/)).toBeInTheDocument();
    unmount();
    render(<DeterminationPanel determination={undefined} sentAt={null} />);
    expect(screen.getByText(/Pending — no determination yet/)).toBeInTheDocument();
  });

  it('badge tolerates an unknown tone', () => {
    render(<DeterminationBadge determination={{ ...d, tone: 'bogus' as never }} />);
    expect(screen.getByTestId('determination-badge')).toHaveTextContent('Needs human review');
  });
});
