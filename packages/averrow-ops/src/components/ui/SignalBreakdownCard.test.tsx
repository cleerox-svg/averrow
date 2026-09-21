import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import {
  SignalBreakdownCard,
  PAGE_SIGNAL_WEIGHTS,
  SHADOW_SIGNAL_WEIGHTS,
} from './SignalBreakdownCard';

describe('SignalBreakdownCard', () => {
  it('renders the total score when provided', () => {
    render(<SignalBreakdownCard score={75} signals={['credential_form']} />);
    expect(screen.getByText('75 / 100')).toBeInTheDocument();
  });

  it('omits the score badge when score is null', () => {
    render(<SignalBreakdownCard score={null} signals={['credential_form']} />);
    expect(screen.queryByText(/\/ 100/)).not.toBeInTheDocument();
  });

  it('shows the "no scored signals" message when signals is empty', () => {
    render(<SignalBreakdownCard score={0} signals={[]} />);
    expect(screen.getByText(/No scored signals fired/i)).toBeInTheDocument();
  });

  it('parses a JSON string for signals (as the API actually returns it)', () => {
    render(<SignalBreakdownCard score={30} signals={JSON.stringify(['credential_form'])} />);
    expect(screen.getByText('Credential form present')).toBeInTheDocument();
  });

  it('degrades to empty on malformed JSON instead of throwing', () => {
    expect(() => render(<SignalBreakdownCard score={0} signals={'not json{'} />)).not.toThrow();
    expect(screen.getByText(/No scored signals fired/i)).toBeInTheDocument();
  });

  it('accepts an already-parsed array for signals', () => {
    render(<SignalBreakdownCard score={30} signals={['credential_form']} />);
    expect(screen.getByText('Credential form present')).toBeInTheDocument();
  });

  // ─── weight sort ──────────────────────────────────────────────────
  it('sorts live signals by weight descending', () => {
    render(
      <SignalBreakdownCard
        score={87}
        signals={['favicon_clone', 'offdomain_form_exfil', 'credential_form']}
      />,
    );
    const items = within(screen.getByTestId('scoring-signals')).getAllByRole('listitem');
    const labels = items.map((li) => li.textContent);
    // offdomain_form_exfil (45) > credential_form (30) > favicon_clone (12)
    expect(labels[0]).toMatch(/Off-domain form exfil/);
    expect(labels[1]).toMatch(/Credential form present/);
    expect(labels[2]).toMatch(/Favicon cloned from brand/);
  });

  it('renders the correct weight badge for each live signal', () => {
    render(<SignalBreakdownCard score={45} signals={['offdomain_form_exfil']} />);
    expect(screen.getByText(`+${PAGE_SIGNAL_WEIGHTS.offdomain_form_exfil}`)).toBeInTheDocument();
  });

  // ─── unknown-key fallback ─────────────────────────────────────────
  it('falls back to a humanized label for an unrecognized live key', () => {
    render(<SignalBreakdownCard score={5} signals={['some_future_signal_key']} />);
    expect(screen.getByText('some future signal key')).toBeInTheDocument();
  });

  it('renders a dash weight badge for an unrecognized live key instead of a fabricated number', () => {
    render(<SignalBreakdownCard score={5} signals={['some_future_signal_key']} />);
    const scoring = screen.getByTestId('scoring-signals');
    expect(within(scoring).getByText('—')).toBeInTheDocument();
  });

  it('falls back to a humanized label for an unrecognized shadow key', () => {
    render(
      <SignalBreakdownCard score={0} signals={[]} shadowSignals={['some_future_shadow_key']} />,
    );
    expect(screen.getByText('some future shadow key')).toBeInTheDocument();
  });

  // ─── live / shadow split ──────────────────────────────────────────
  it('renders shadow signals in a visually distinct, explicitly-labeled block', () => {
    render(
      <SignalBreakdownCard
        score={30}
        signals={['credential_form']}
        shadowSignals={['default_scaffold_title']}
      />,
    );
    expect(screen.getByText('Shadow signals — not scoring')).toBeInTheDocument();
    expect(screen.getByText(/computed and persisted for measurement only/i)).toBeInTheDocument();
  });

  it('does not render the shadow block when there are no shadow signals', () => {
    render(<SignalBreakdownCard score={30} signals={['credential_form']} />);
    expect(screen.queryByText('Shadow signals — not scoring')).not.toBeInTheDocument();
    expect(screen.queryByTestId('shadow-signals')).not.toBeInTheDocument();
  });

  it('a shadow signal never renders inside the scoring group', () => {
    render(
      <SignalBreakdownCard
        score={30}
        signals={['credential_form']}
        shadowSignals={['covert_exfil_sink']}
      />,
    );
    const scoring = screen.getByTestId('scoring-signals');
    const shadow = screen.getByTestId('shadow-signals');
    expect(within(shadow).getByText(/Covert exfil sink/)).toBeInTheDocument();
    expect(within(scoring).queryByText(/Covert exfil sink/)).not.toBeInTheDocument();
    // and the scoring group must not carry the shadow key's weight badge either
    expect(within(scoring).queryByText(`+${SHADOW_SIGNAL_WEIGHTS.covert_exfil_sink}`)).not.toBeInTheDocument();
  });

  it('a known shadow key passed through the live `signals` prop by mistake is filtered out of the scoring group, not scored', () => {
    render(<SignalBreakdownCard score={30} signals={['credential_form', 'covert_exfil_sink']} />);
    const scoring = screen.getByTestId('scoring-signals');
    // Only the genuine live signal renders in the scoring group.
    expect(within(scoring).getByText('Credential form present')).toBeInTheDocument();
    expect(within(scoring).queryByText(/Covert exfil sink/)).not.toBeInTheDocument();
    // It also must not silently appear in the shadow block, since it never
    // arrived via `shadowSignals` — it's simply dropped, not laundered.
    expect(screen.queryByTestId('shadow-signals')).not.toBeInTheDocument();
  });

  it('never shows a scoring "+N pts" style badge for a shadow signal', () => {
    render(
      <SignalBreakdownCard
        score={30}
        signals={['credential_form']}
        shadowSignals={['covert_exfil_sink', 'form_relay_sink']}
      />,
    );
    const shadow = screen.getByTestId('shadow-signals');
    // Shadow rows carry the literal "shadow" tag, never a "+N" badge.
    expect(within(shadow).getAllByText('shadow')).toHaveLength(2);
    expect(within(shadow).queryByText(`+${SHADOW_SIGNAL_WEIGHTS.covert_exfil_sink}`)).not.toBeInTheDocument();
  });

  it('shows the would-be shadow score delta as informational text, not as part of the live score', () => {
    render(
      <SignalBreakdownCard
        score={30}
        signals={['credential_form']}
        shadowSignals={['default_scaffold_title']}
        shadowScoreDelta={12}
      />,
    );
    expect(screen.getByText('would-be +12')).toBeInTheDocument();
    // The live score badge stays exactly what was passed — the shadow
    // delta is never folded into it.
    expect(screen.getByText('30 / 100')).toBeInTheDocument();
  });

  // ─── evidence literals ────────────────────────────────────────────
  it('renders the matched evidence literal alongside its fired signal', () => {
    render(
      <SignalBreakdownCard
        score={30}
        signals={['credential_form']}
        evidence={{ credential_form: 'type="password"' }}
      />,
    );
    expect(screen.getByText('“type="password"”')).toBeInTheDocument();
  });

  it('parses a JSON string for evidence too', () => {
    render(
      <SignalBreakdownCard
        score={30}
        signals={['credential_form']}
        evidence={JSON.stringify({ credential_form: 'type="password"' })}
      />,
    );
    expect(screen.getByText('“type="password"”')).toBeInTheDocument();
  });
});
