import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Database } from 'lucide-react';
import { CollapsibleSection } from './CollapsibleSection';

// Lifted out of AdminDashboard.tsx (Tier 4 design-review fix) so every
// collapsible sub-section on the platform — including nested ones like
// AiSpend's "Cost-reduction levers" — gets identical chrome AND
// localStorage persistence instead of a one-off toggle that diverges
// visually and forgets its state on remount.

describe('CollapsibleSection', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders collapsed by default when defaultExpanded=false and no stored state exists', () => {
    render(
      <CollapsibleSection storageKey="test-key-1" icon={Database} label="Test Section" defaultExpanded={false}>
        <div>Hidden content</div>
      </CollapsibleSection>
    );

    const toggle = screen.getByRole('button', { name: /Test Section/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Hidden content')).not.toBeInTheDocument();
  });

  it('renders expanded by default when defaultExpanded=true and no stored state exists', () => {
    render(
      <CollapsibleSection storageKey="test-key-2" icon={Database} label="Test Section" defaultExpanded={true}>
        <div>Visible content</div>
      </CollapsibleSection>
    );

    expect(screen.getByRole('button', { name: /Test Section/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Visible content')).toBeInTheDocument();
  });

  it('toggles expand state on click and persists it to localStorage under storageKey', async () => {
    const user = userEvent.setup();
    render(
      <CollapsibleSection storageKey="test-key-3" icon={Database} label="Test Section" defaultExpanded={false}>
        <div>Content</div>
      </CollapsibleSection>
    );

    const toggle = screen.getByRole('button', { name: /Test Section/ });
    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(localStorage.getItem('test-key-3')).toBe('true');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(localStorage.getItem('test-key-3')).toBe('false');
  });

  it('reads persisted state on mount, overriding defaultExpanded', () => {
    localStorage.setItem('test-key-4', 'true');

    render(
      <CollapsibleSection storageKey="test-key-4" icon={Database} label="Test Section" defaultExpanded={false}>
        <div>Persisted-open content</div>
      </CollapsibleSection>
    );

    expect(screen.getByRole('button', { name: /Test Section/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Persisted-open content')).toBeInTheDocument();
  });
});
