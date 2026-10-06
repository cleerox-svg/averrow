import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginPage } from '@averrow/shared/login';
import type {
  LoginPageProps, LastSignInMethodAdapter, PasskeyLoginAdapter,
} from '@averrow/shared/login';

const passkeyAdapter: PasskeyLoginAdapter = {
  isSupported: () => false,
  startConditionalUI: vi.fn().mockResolvedValue(undefined),
  signIn: vi.fn().mockResolvedValue(false),
};
const lastSignInMethod: LastSignInMethodAdapter = { read: () => null, write: vi.fn() };

function setup(over: Partial<LoginPageProps> = {}, search = '') {
  window.history.pushState({}, '', `/login${search}`);
  const post = vi.fn().mockResolvedValue({ success: true, data: { expires_in_minutes: 30 } });
  const utils = render(
    <LoginPage
      branding={{ brandLetters: 'AV', productName: 'Averrow', tagline: 'TAG', footerPillars: 'A · B' }}
      apiClient={{ post }}
      passkeyAdapter={passkeyAdapter}
      lastSignInMethod={lastSignInMethod}
      returnTo="/v2/"
      {...over}
    />,
  );
  return { ...utils, post };
}

afterEach(() => window.history.pushState({}, '', '/'));

describe('LoginPage test ids', () => {
  it('exposes stable ids on the kit controls', () => {
    setup();
    for (const id of ['login-page', 'login-google', 'login-email', 'login-magic-link-submit']) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
  });

  it('exposes the passkey button id when passkeys are supported and shown', () => {
    setup({ passkeyAdapter: { ...passkeyAdapter, isSupported: () => true }, lastSignInMethod: { read: () => 'passkey', write: vi.fn() } });
    expect(screen.getByTestId('login-passkey')).toBeInTheDocument();
  });
});

describe('errorCopy lookup', () => {
  it('uses default copy for a known code', () => {
    setup({}, '?error=link_expired');
    expect(screen.getByTestId('login-error')).toHaveTextContent('That sign-in link expired');
  });

  it('honours an errorCopy override', () => {
    setup({ errorCopy: { custom: 'Custom text' } }, '?error=custom');
    expect(screen.getByTestId('login-error')).toHaveTextContent('Custom text');
  });

  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    '?error=%s does not crash or resolve to a prototype member', (code) => {
      setup({}, `?error=${code}`);
      expect(screen.getByTestId('login-error')).toHaveTextContent(`Sign-in error: ${code}`);
    },
  );

  it('ignores non-string override values', () => {
    setup({ errorCopy: { bad: 42 as unknown as string } }, '?error=bad');
    expect(screen.getByTestId('login-error')).toHaveTextContent('Sign-in error: bad');
  });
});

describe('error accessibility', () => {
  it('page error is role=alert and receives focus', async () => {
    setup({}, '?error=signin_failed');
    const err = screen.getByRole('alert');
    expect(err).toBe(screen.getByTestId('login-error'));
    await waitFor(() => expect(err).toHaveFocus());
  });

  it('no alert renders without an error', () => {
    setup();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('magic-link error is role=alert and described-by the email input', async () => {
    setup();
    await userEvent.click(screen.getByTestId('login-magic-link-submit'));
    const alert = await screen.findByTestId('login-magic-link-error');
    expect(alert).toHaveAttribute('role', 'alert');
    const input = screen.getByTestId('login-email');
    expect(input).toHaveAttribute('aria-describedby', alert.id);
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('input has no aria-describedby without an error', () => {
    setup();
    expect(screen.getByTestId('login-email')).not.toHaveAttribute('aria-describedby');
  });
});

describe('onGoogleSignIn', () => {
  it('omitted: button is the plain, non-busy Google link-out', () => {
    setup();
    const btn = screen.getByTestId('login-google');
    expect(btn).toHaveTextContent('Sign in with Google');
    expect(btn).not.toBeDisabled();
    expect(btn).not.toHaveAttribute('aria-busy');
    expect(lastSignInMethod.write).not.toHaveBeenCalledWith('passkey');
  });

  it('set: calls the handler instead of navigating, with busy state', async () => {
    let resolve!: () => void;
    const onGoogleSignIn = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    setup({ onGoogleSignIn });
    await userEvent.click(screen.getByTestId('login-google'));
    expect(onGoogleSignIn).toHaveBeenCalledTimes(1);
    const btn = screen.getByTestId('login-google');
    expect(btn).toHaveTextContent('Signing in…');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
    resolve();
    await waitFor(() => expect(screen.getByTestId('login-google')).toHaveTextContent('Sign in with Google'));
    expect(screen.getByTestId('login-google')).not.toBeDisabled();
    expect(window.location.pathname).toBe('/login');
  });

  it('shows the thrown message as text (never HTML) and focuses it', async () => {
    const onGoogleSignIn = vi.fn().mockRejectedValue(new Error('<img src=x onerror=alert(1)>'));
    const { container } = setup({ onGoogleSignIn });
    await userEvent.click(screen.getByTestId('login-google'));
    const err = await screen.findByTestId('login-error');
    expect(err).toHaveAttribute('role', 'alert');
    expect(err.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(container.querySelector('img')).toBeNull();
    await waitFor(() => expect(err).toHaveFocus());
    expect(screen.getByTestId('login-google')).not.toBeDisabled();
  });

  it('falls back to generic copy for a non-Error rejection', async () => {
    setup({ onGoogleSignIn: vi.fn().mockRejectedValue('nope') });
    await userEvent.click(screen.getByTestId('login-google'));
    expect(await screen.findByTestId('login-error')).toHaveTextContent('Google sign-in failed. Try again.');
  });

  it('googleErrorCopy overrides the message', async () => {
    setup({
      onGoogleSignIn: vi.fn().mockRejectedValue(new Error('raw')),
      googleErrorCopy: (e) => `Custom: ${(e as Error).message}`,
    });
    await userEvent.click(screen.getByTestId('login-google'));
    expect(await screen.findByTestId('login-error')).toHaveTextContent('Custom: raw');
  });

  it('clears the previous error on retry', async () => {
    const onGoogleSignIn = vi.fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockResolvedValueOnce(undefined);
    setup({ onGoogleSignIn });
    await userEvent.click(screen.getByTestId('login-google'));
    await screen.findByText('first');
    await userEvent.click(screen.getByTestId('login-google'));
    await waitFor(() => expect(screen.queryByText('first')).toBeNull());
  });
});

describe('footerLinks', () => {
  it('omitted: no footer slot', () => {
    setup();
    expect(screen.queryByTestId('login-footer-links')).toBeNull();
  });

  it('set: renders inside the card after the pillars', () => {
    setup({ footerLinks: <a href="/privacy">Privacy</a> });
    const slot = screen.getByTestId('login-footer-links');
    const pillars = screen.getByText('A · B');
    expect(slot).toContainElement(screen.getByRole('link', { name: 'Privacy' }));
    expect(pillars.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('login-page')).toContainElement(slot);
  });
});

describe('magicLinkSentCopy', () => {
  async function sendLink(over: Partial<LoginPageProps> = {}) {
    setup(over);
    await userEvent.type(screen.getByTestId('login-email'), 'a@b.co');
    await userEvent.click(screen.getByTestId('login-magic-link-submit'));
    return screen.findByTestId('login-magic-link-sent');
  }

  it('omitted: default confirmation', async () => {
    const box = await sendLink();
    expect(box).toHaveTextContent('Check your inbox.');
    expect(box).toHaveTextContent('We sent a sign-in link to a@b.co');
    expect(box).toHaveTextContent('expires in 30 minutes');
  });

  it('set: replaces the body, keeps the reset control', async () => {
    const box = await sendLink({ magicLinkSentCopy: (e) => <span>If {e} can sign in, a link is on its way.</span> });
    expect(box).toHaveTextContent('If a@b.co can sign in, a link is on its way.');
    expect(box).not.toHaveTextContent('Check your inbox');
    expect(box).toHaveTextContent('Use a different email');
  });
});
