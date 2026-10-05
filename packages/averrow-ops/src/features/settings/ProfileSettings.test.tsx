import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProfileSettings, type ProfileSettingsProps, type ProfileSettingsUser } from '@averrow/shared/account';
import { ToastProvider } from '@averrow/shared/ui';
import { installDomStubs, stubViewport } from './settingsTestUtils';

const USER: ProfileSettingsUser = {
  id: 'usr_123',
  email: 'ada@averrow.com',
  name: 'Ada Lovelace',
  display_name: 'Ada Lovelace',
  role: 'super_admin',
  timezone: 'America/Toronto',
  passkey_count: 1,
  created_at: '2025-03-03 10:00:00',
  organization: null,
};

const ok = { success: true } as const;

function setup(over: Partial<ProfileSettingsProps> = {}) {
  const patch = vi.fn().mockResolvedValue(ok);
  const props: ProfileSettingsProps = {
    user: USER,
    apiClient: { patch },
    theme: 'dark',
    onThemeChange: vi.fn(),
    onUserUpdated: vi.fn(),
    onSignOut: vi.fn(),
    onDirtyChange: vi.fn(),
    ...over,
  };
  const utils = render(<ToastProvider><ProfileSettings {...props} /></ToastProvider>);
  return { ...utils, props, patch: (props.apiClient.patch as ReturnType<typeof vi.fn>), user: userEvent.setup() };
}

beforeEach(() => {
  installDomStubs();
  stubViewport(true);
});

describe('ProfileSettings — display name', () => {
  it('keeps Save disabled until the name changes, then saves and toasts', async () => {
    const { user, patch, props } = setup();
    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();

    const input = screen.getByLabelText('Display name');
    await user.clear(input);
    await user.type(input, 'Ada King');
    expect(save).toBeEnabled();
    expect(props.onDirtyChange).toHaveBeenLastCalledWith(true);

    await user.click(save);
    expect(patch).toHaveBeenCalledWith('/api/profile', { display_name: 'Ada King' });
    expect(await screen.findByText('Profile saved.')).toBeInTheDocument();
    expect(props.onUserUpdated).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled());
    expect(props.onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('sends null when the name is cleared (falls back to the Google name)', async () => {
    const { user, patch } = setup();
    await user.clear(screen.getByLabelText('Display name'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(patch).toHaveBeenCalledWith('/api/profile', { display_name: null });
  });

  it('shows an error toast on failure, keeps the edit, and Discard reverts it', async () => {
    const patch = vi.fn().mockResolvedValue({ success: false, error: 'An internal error occurred' });
    const { user, props } = setup({ apiClient: { patch } });
    const input = screen.getByLabelText('Display name');
    await user.clear(input);
    await user.type(input, 'Nope');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText("Couldn't save. Check your connection and try again.")).toBeInTheDocument();
    expect(props.onUserUpdated).not.toHaveBeenCalled();
    expect(input).toHaveValue('Nope');

    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(input).toHaveValue('Ada Lovelace');
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
  });

  it('treats a rejected request like a failure', async () => {
    const patch = vi.fn().mockRejectedValue(new Error('offline'));
    const { user } = setup({ apiClient: { patch } });
    await user.type(screen.getByLabelText('Display name'), '!');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/Couldn't save/)).toBeInTheDocument();
  });

  it('renders the email read-only with the Google note', () => {
    setup();
    expect(screen.getByLabelText('Email')).toHaveAttribute('readonly');
    expect(screen.getByText('Managed by your Google account.')).toBeInTheDocument();
  });
});

describe('ProfileSettings — appearance', () => {
  it('applies the theme through the host hook immediately and persists it', async () => {
    const { user, patch, props } = setup();
    await user.click(screen.getByRole('radio', { name: 'Light' }));
    expect(props.onThemeChange).toHaveBeenCalledWith('light');
    expect(patch).toHaveBeenCalledWith('/api/profile', { theme_preference: 'light' });
  });

  it('persists Auto as null', async () => {
    const { user, patch, props } = setup();
    await user.click(screen.getByRole('radio', { name: 'Auto' }));
    expect(props.onThemeChange).toHaveBeenCalledWith('auto');
    expect(patch).toHaveBeenCalledWith('/api/profile', { theme_preference: null });
  });

  it('reverts the theme and says why when saving fails', async () => {
    const patch = vi.fn().mockResolvedValue({ success: false });
    const { user, props } = setup({ apiClient: { patch } });
    await user.click(screen.getByRole('radio', { name: 'Light' }));
    expect(await screen.findByText(/Couldn't save your theme/)).toBeInTheDocument();
    expect(props.onThemeChange).toHaveBeenNthCalledWith(1, 'light');
    expect(props.onThemeChange).toHaveBeenNthCalledWith(2, 'dark');
  });

  it('does not revert a later theme choice when an earlier save fails afterwards', async () => {
    let failFirst: (v: { success: boolean }) => void = () => {};
    const patch = vi.fn()
      .mockImplementationOnce(() => new Promise((r) => { failFirst = r; }))
      .mockResolvedValue({ success: true });
    const { user, props } = setup({ apiClient: { patch } });
    await user.click(screen.getByRole('radio', { name: 'Light' }));
    await user.click(screen.getByRole('radio', { name: 'Auto' }));
    failFirst({ success: false });
    expect(await screen.findByText(/Couldn't save your theme/)).toBeInTheDocument();
    expect(props.onThemeChange).toHaveBeenCalledTimes(2);
    expect(props.onThemeChange).not.toHaveBeenCalledWith('dark');
  });

  it('saves the detected zone when the profile has none (picking the shown value is not a no-op)', async () => {
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockReturnValue({ timeZone: 'Asia/Tokyo' } as Intl.ResolvedDateTimeFormatOptions);
    try {
      const { user, patch } = setup({ user: { ...USER, timezone: null } });
      expect(screen.getByRole('button', { name: 'Time zone' })).toHaveTextContent('Tokyo');
      await user.click(screen.getByRole('button', { name: 'Time zone' }));
      await user.click(await screen.findByRole('option', { name: /Tokyo/ }));
      expect(patch).toHaveBeenCalledWith('/api/profile', { timezone: 'Asia/Tokyo' });
    } finally {
      spy.mockRestore();
    }
  });

  it('PATCHes the time zone from the picker and toasts', async () => {
    const { user, patch } = setup();
    await user.click(screen.getByRole('button', { name: 'Time zone' }));
    await user.click(await screen.findByRole('option', { name: /Tokyo/ }));
    expect(patch).toHaveBeenCalledWith('/api/profile', { timezone: 'Asia/Tokyo' });
    expect(await screen.findByText('Time zone saved.')).toBeInTheDocument();
  });

  it('reverts the time zone when the save fails', async () => {
    const patch = vi.fn().mockResolvedValue({ success: false });
    const { user } = setup({ apiClient: { patch } });
    await user.click(screen.getByRole('button', { name: 'Time zone' }));
    await user.click(await screen.findByRole('option', { name: /Tokyo/ }));
    expect(await screen.findByText(/Couldn't save your time zone/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Time zone' })).toHaveTextContent('Toronto'));
  });
});

describe('ProfileSettings — account facts + sign out', () => {
  it('shows role, access scope, member since and (staff) the copyable user id', () => {
    setup();
    const account = screen.getByRole('region', { name: 'Account' });
    expect(within(account).getByText('Super Admin')).toBeInTheDocument();
    expect(within(account).getByText('Averrow staff · Full platform access')).toBeInTheDocument();
    expect(within(account).getByText(/2025/)).toBeInTheDocument();
    expect(within(account).getByText('usr_123')).toBeInTheDocument();
  });

  it('hides the user id for customers and shows the org scope', () => {
    setup({ user: { ...USER, role: 'client', organization: { name: 'Acme', role: 'admin' } } });
    expect(screen.queryByText('usr_123')).toBeNull();
    // Hero + Account both carry the scope line on desktop.
    expect(screen.getAllByText('Acme · Admin').length).toBeGreaterThan(0);
  });

  it('desktop: hero actions; no mobile Sign out row. Sign out calls the host', async () => {
    const { user, props } = setup();
    expect(screen.getByRole('button', { name: 'Edit profile' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(props.onSignOut).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('button', { name: 'Sign out' })).toHaveLength(1);
  });

  it('mobile: no hero, a Sign out row instead', async () => {
    stubViewport(false);
    const { user, props } = setup();
    expect(screen.queryByRole('button', { name: 'Edit profile' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(props.onSignOut).toHaveBeenCalledTimes(1);
  });

  it('never renders a profile picture', () => {
    const { container } = setup({ user: { ...USER, avatar_url: 'https://lh3.googleusercontent.com/x' } as ProfileSettingsUser });
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('AL')).toBeInTheDocument();
  });
});

describe('ProfileSettings — states', () => {
  it('shows a loading state without a user', () => {
    setup({ user: null });
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('Display name')).toBeNull();
  });

  it('shows an error card with retry', async () => {
    const onRetry = vi.fn();
    const { user } = setup({ user: null, error: true, onRetry });
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(onRetry).toHaveBeenCalled();
  });
});
