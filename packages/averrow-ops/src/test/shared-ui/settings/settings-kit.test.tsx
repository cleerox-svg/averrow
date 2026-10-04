import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AccountHero, CopyField, DangerZone, IconTile, InlineBanner, SettingsGroup, SettingsRow,
  describeAccountScope,
} from '../../../../../shared/src/ui/settings';
import { TestSwitch, stubViewport } from './helpers';

beforeEach(() => stubViewport(true));

describe('IconTile', () => {
  it('is decorative and carries tone tint/glyph variables (no hex)', () => {
    const { container } = render(<IconTile tone="violet"><svg /></IconTile>);
    const el = container.firstElementChild as HTMLElement;
    expect(el).toHaveAttribute('aria-hidden', 'true');
    expect(el.style.getPropertyValue('--ds-tile-tint')).toBe('var(--violet)');
    expect(el.style.getPropertyValue('--ds-tile-glyph')).toBe('var(--violet-text)');
  });

  it('applies an explicit size', () => {
    const { container } = render(<IconTile tone="amber" size={48}><svg /></IconTile>);
    expect((container.firstElementChild as HTMLElement).style.getPropertyValue('--ds-tile-size')).toBe('48px');
  });
});

describe('SettingsGroup', () => {
  it('is a section labelled by its title, with footer text', () => {
    render(<SettingsGroup title="Appearance" footer="Applies on this device."><div>row</div></SettingsGroup>);
    expect(screen.getByRole('region', { name: 'Appearance' })).toBeInTheDocument();
    expect(screen.getByText('Applies on this device.')).toBeInTheDocument();
  });

  it('danger variant uses the critical card wash', () => {
    const { container } = render(<SettingsGroup title="Danger" variant="danger"><div /></SettingsGroup>);
    expect(container.querySelector('section')).toHaveAttribute('data-variant', 'danger');
    const card = container.querySelector('.ds-sgroup-body') as HTMLElement;
    expect(card.style.background).toContain('--card-critical-bg');
  });
});

describe('SettingsRow', () => {
  it('static: renders title, description and meta without a button role', () => {
    render(<SettingsRow title="Role" description="Your role." meta="usr_123" icon={<svg />} />);
    expect(screen.getByText('Role')).toBeInTheDocument();
    expect(screen.getByText('Your role.')).toBeInTheDocument();
    expect(screen.getByText('usr_123')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('button: whole row is the target and fires onClick', async () => {
    const onClick = vi.fn();
    render(<SettingsRow variant="button" title="Time zone" onClick={onClick} />);
    await userEvent.click(screen.getByRole('button', { name: /Time zone/ }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('link: default anchor, and renderLink lets a router Link in', () => {
    const { rerender } = render(<SettingsRow variant="link" href="/settings/security" title="Security" />);
    expect(screen.getByRole('link', { name: /Security/ })).toHaveAttribute('href', '/settings/security');
    rerender(
      <SettingsRow
        variant="link"
        href="/x"
        title="Security"
        renderLink={(p) => <a data-router-link href={`/app${p.href}`} className={p.className}>{p.children}</a>}
      />,
    );
    const link = screen.getByRole('link', { name: /Security/ });
    expect(link).toHaveAttribute('data-router-link');
    expect(link).toHaveAttribute('href', '/app/x');
  });

  it('toggle: clicking the label text toggles the switch', async () => {
    const onChange = vi.fn();
    render(
      <SettingsRow
        variant="toggle"
        title="Push notifications"
        description="Alerts on this device."
        trailing={({ labelId }) => <TestSwitch checked={false} onCheckedChange={onChange} labelledBy={labelId} />}
      />,
    );
    await userEvent.click(screen.getByText('Push notifications'));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole('switch', { name: 'Push notifications' })).toBeInTheDocument();
  });

  it('disabled: shows the reason instead of the description, aria-disabled, no click', async () => {
    const onClick = vi.fn();
    render(
      <SettingsRow
        variant="button"
        title="Send test"
        description="Normal description"
        disabled
        disabledReason="Turn on Push to use this."
        onClick={onClick}
      />,
    );
    const row = screen.getByRole('button', { name: /Send test/ });
    expect(row).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Turn on Push to use this.')).toBeInTheDocument();
    expect(screen.queryByText('Normal description')).toBeNull();
    await userEvent.click(row);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('disabled toggle passes disabled to the control', () => {
    render(
      <SettingsRow
        variant="toggle" title="Push" disabled disabledReason="Blocked in this browser."
        trailing={({ disabled }) => <TestSwitch checked={false} onCheckedChange={() => {}} disabled={disabled} />}
      />,
    );
    expect(screen.getByRole('switch')).toBeDisabled();
  });

  it('error: renders a role=alert message in place of the description', () => {
    render(<SettingsRow title="Email" description="Sent to you." error="Couldn't save. Try again." />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't save. Try again.");
    expect(screen.queryByText('Sent to you.')).toBeNull();
  });

  it('loading: shows a spinner, marks the trailing control busy and hides the chevron', () => {
    render(<SettingsRow variant="button" title="Save" loading trailing={<span>Value</span>} />);
    expect(screen.getByTestId('ds-spinner')).toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Value').parentElement?.className).toContain('ds-srow-trailing--busy');
  });

  it('stackTrailing adds the stacked-layout hook', () => {
    const { container } = render(<SettingsRow title="Send me" stackTrailing trailing={<select aria-label="Level" />} />);
    expect(container.firstElementChild?.className).toContain('ds-srow--stack');
  });
});

describe('DangerZone', () => {
  it('renders outline (never solid danger) action buttons that call onAction', async () => {
    const onAction = vi.fn();
    render(
      <DangerZone
        title="Sign out & reset"
        actions={[
          { id: 'others', title: 'Sign out other devices', actionLabel: 'Sign out others', onAction: vi.fn(), tone: 'safe' },
          { id: 'all', title: 'Sign out everywhere', description: 'Ends every session.', actionLabel: 'Sign out everywhere', onAction },
        ]}
      />,
    );
    expect(screen.getByRole('region', { name: 'Sign out & reset' })).toBeInTheDocument();
    const danger = screen.getByRole('button', { name: 'Sign out everywhere' });
    expect(danger.className).toContain('border-[var(--sev-critical-border)]');
    expect(danger.className).not.toContain('var(--red-dim)');
    expect(screen.getByRole('button', { name: 'Sign out others' }).className).not.toContain('sev-critical');
    await userEvent.click(danger);
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});

describe('InlineBanner', () => {
  it('error is role=alert, others are role=status', () => {
    const { rerender } = render(<InlineBanner tone="error">Push is blocked.</InlineBanner>);
    expect(screen.getByRole('alert')).toHaveTextContent('Push is blocked.');
    rerender(<InlineBanner tone="info" title="Heads up">Details</InlineBanner>);
    expect(screen.getByRole('status')).toHaveTextContent('Heads up');
  });

  it('dismiss button calls onDismiss', async () => {
    const onDismiss = vi.fn();
    render(<InlineBanner tone="warn" onDismiss={onDismiss}>Offline</InlineBanner>);
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe('CopyField', () => {
  it('copies via the Clipboard API and announces it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const onCopied = vi.fn();
    render(<CopyField value="usr_abc123" label="user ID" onCopied={onCopied} />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy user ID' }));
    expect(writeText).toHaveBeenCalledWith('usr_abc123');
    expect(onCopied).toHaveBeenCalled();
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('falls back to execCommand and reports failure when nothing works', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const exec = vi.fn().mockReturnValue(false);
    (document as unknown as { execCommand: typeof exec }).execCommand = exec;
    render(<CopyField value="v4.0.0" />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy value' }));
    expect(exec).toHaveBeenCalledWith('copy');
    expect(await screen.findByText(/Couldn't copy/)).toBeInTheDocument();
  });
});

describe('AccountHero', () => {
  it('shows name, email, role, passkey state and scope — initials only, no image', () => {
    const { container } = render(
      <AccountHero
        name="Claude Marc Leroux"
        email="claude@example.com"
        role="super_admin"
        passkey
        scope={describeAccountScope({ role: 'super_admin' })}
        actions={<button>Edit profile</button>}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Claude Marc Leroux' })).toBeInTheDocument();
    expect(screen.getByText('claude@example.com')).toHaveAttribute('title', 'claude@example.com');
    expect(screen.getByText('Super admin')).toBeInTheDocument();
    expect(screen.getByText('Passkey on')).toBeInTheDocument();
    expect(screen.getByText('Averrow staff · Full platform access')).toBeInTheDocument();
    expect(screen.getByText('CL')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit profile' })).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('flags a missing passkey and the auditor read-only role', () => {
    render(<AccountHero name="Ada" email="a@x.io" role="auditor" passkey={false} />);
    expect(screen.getByText('No passkey')).toBeInTheDocument();
    expect(screen.getByText('Read-only')).toBeInTheDocument();
  });

  it('loading renders a busy skeleton, not the content', () => {
    render(<AccountHero loading name="Hidden" />);
    expect(screen.getByLabelText('Loading your profile')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('Hidden')).toBeNull();
  });

  it('describeAccountScope maps staff, auditor and tenant users', () => {
    expect(describeAccountScope({ role: 'auditor' })).toBe('Read-only access to all data');
    expect(describeAccountScope({ role: 'client', orgName: 'Acme', orgRole: 'admin' })).toBe('Acme · Admin');
    expect(describeAccountScope({ role: 'client' })).toBeNull();
  });
});

describe('IconTile inside rows', () => {
  it('SettingsRow icon renders inside a tile', () => {
    const { container } = render(<SettingsRow title="Profile" icon={<svg data-testid="g" />} tone="amber" />);
    const tile = container.querySelector('.ds-tile') as HTMLElement;
    expect(within(tile).getByTestId('g')).toBeInTheDocument();
  });
});
