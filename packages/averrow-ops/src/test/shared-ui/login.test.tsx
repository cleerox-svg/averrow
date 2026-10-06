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

afterEach(() => {
  vi.clearAllMocks();
  window.history.pushState({}, '', '/');
});

/** Replace window.location with a stub whose href setter is observable. */
function stubLocation(search = '') {
  const original = window.location;
  const assigned: string[] = [];
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      get href() { return `http://localhost/login${search}`; },
      set href(v: string) { assigned.push(v); },
    },
  });
  return { assigned, restore: () => Object.defineProperty(window, 'location', { configurable: true, value: original }) };
}

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
      // __proto__ etc. contain uppercase/underscores that fail the safe-code
      // pattern or resolve to the generic copy — never a prototype member.
      const text = screen.getByTestId('login-error').textContent ?? '';
      expect(text).toMatch(/^Sign-in (error: [a-z0-9_]+|failed\. Try again\.)$/);
      expect(text).not.toMatch(/function|\[object/);
    },
  );

  it('does not echo a sentence supplied in ?error=', () => {
    setup({}, `?error=${encodeURIComponent('Your account is locked, call 555-0100')}`);
    const err = screen.getByTestId('login-error');
    expect(err).toHaveTextContent('Sign-in failed. Try again.');
    expect(err).not.toHaveTextContent('555-0100');
  });

  it('echoes only well-formed codes (lowercase, digits, underscore, <=40)', () => {
    setup({}, '?error=weird_code_9');
    expect(screen.getByTestId('login-error')).toHaveTextContent('Sign-in error: weird_code_9');
  });

  it('rejects over-long codes', () => {
    setup({}, `?error=${'a'.repeat(41)}`);
    expect(screen.getByTestId('login-error')).toHaveTextContent('Sign-in failed. Try again.');
  });

  it('ignores non-string override values', () => {
    setup({ errorCopy: { bad: 42 as unknown as string } }, '?error=bad');
    expect(screen.getByTestId('login-error')).toHaveTextContent('Sign-in error: bad');
  });
});

describe('error accessibility', () => {
  it('URL error is role=alert but is NOT focused on mount', () => {
    setup({}, '?error=signin_failed');
    const err = screen.getByRole('alert');
    expect(err).toBe(screen.getByTestId('login-error'));
    expect(err).toHaveAttribute('tabindex', '-1');
    expect(err).not.toHaveFocus();
    expect(document.body).toHaveFocus();
  });

  it('typing in the email field with a URL error present keeps focus', async () => {
    setup({}, '?error=signin_failed');
    const input = screen.getByTestId('login-email');
    await userEvent.click(input);
    await userEvent.type(input, 'abc');
    expect(input).toHaveFocus();
    expect(input).toHaveValue('abc');
  });

  it('no alert renders without an error', () => {
    setup();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('magic-link error: role=alert, described-by + aria-invalid on the input, unique id', async () => {
    setup();
    await userEvent.click(screen.getByTestId('login-magic-link-submit'));
    const alert = await screen.findByTestId('login-magic-link-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert.id).toBeTruthy();
    expect(alert.id).not.toBe('login-email-error');
    const input = screen.getByTestId('login-email');
    expect(input).toHaveAttribute('aria-describedby', alert.id);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('id', 'login-email');
  });

  it('input has no aria-describedby / aria-invalid without an error', () => {
    setup();
    const input = screen.getByTestId('login-email');
    expect(input).not.toHaveAttribute('aria-describedby');
    expect(input).not.toHaveAttribute('aria-invalid');
  });
});

describe('onGoogleSignIn', () => {
  it('omitted: navigates to the default oauthLoginPath (with returnTo)', async () => {
    const loc = stubLocation();
    try {
      setup();
      await userEvent.click(screen.getByTestId('login-google'));
      expect(loc.assigned).toEqual(['/api/auth/login?return_to=%2Fv2%2F']);
      expect(lastSignInMethod.write).toHaveBeenCalledWith('google');
      expect(screen.getByTestId('login-google')).not.toHaveAttribute('aria-busy');
    } finally { loc.restore(); }
  });

  it('omitted: honours a custom oauthLoginPath', async () => {
    const loc = stubLocation();
    try {
      setup({ oauthLoginPath: '/custom/start' });
      await userEvent.click(screen.getByTestId('login-google'));
      expect(loc.assigned).toEqual(['/custom/start']);
    } finally { loc.restore(); }
  });

  it('set: calls the handler instead of navigating; stays busy on success', async () => {
    const loc = stubLocation();
    try {
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
      await Promise.resolve();
      // host navigates on success, so the button stays busy
      expect(screen.getByTestId('login-google')).toHaveAttribute('aria-busy', 'true');
      expect(loc.assigned).toEqual([]);
    } finally { loc.restore(); }
  });

  it('double click calls the handler once', async () => {
    const onGoogleSignIn = vi.fn(() => new Promise<void>(() => { /* pending */ }));
    setup({ onGoogleSignIn });
    const btn = screen.getByTestId('login-google');
    await userEvent.dblClick(btn);
    expect(onGoogleSignIn).toHaveBeenCalledTimes(1);
  });

  it('shows the thrown message as text (never HTML), focuses it, re-enables the button', async () => {
    const onGoogleSignIn = vi.fn().mockRejectedValue(new Error('<img src=x onerror=alert(1)>'));
    const { container } = setup({ onGoogleSignIn });
    await userEvent.click(screen.getByTestId('login-google'));
    const err = await screen.findByTestId('login-error');
    expect(err).toHaveAttribute('role', 'alert');
    expect(err.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(container.querySelector('img')).toBeNull();
    await waitFor(() => expect(err).toHaveFocus());
    const btn = screen.getByTestId('login-google');
    expect(btn).not.toBeDisabled();
    expect(btn).not.toHaveAttribute('aria-busy');
    expect(btn).toHaveTextContent('Sign in with Google');
  });

  it('can retry after a failure (in-flight guard released)', async () => {
    const onGoogleSignIn = vi.fn().mockRejectedValue(new Error('first'));
    setup({ onGoogleSignIn });
    await userEvent.click(screen.getByTestId('login-google'));
    await screen.findByText('first');
    await userEvent.click(screen.getByTestId('login-google'));
    await waitFor(() => expect(onGoogleSignIn).toHaveBeenCalledTimes(2));
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

  it('googleErrorCopy that throws falls back to generic copy', async () => {
    setup({
      onGoogleSignIn: vi.fn().mockRejectedValue(new Error('raw')),
      googleErrorCopy: () => { throw new Error('boom'); },
    });
    await userEvent.click(screen.getByTestId('login-google'));
    expect(await screen.findByTestId('login-error')).toHaveTextContent('Google sign-in failed. Try again.');
  });

  it('a Google error forces the full menu and clears when the magic link is requested', async () => {
    setup({
      onGoogleSignIn: vi.fn().mockRejectedValue(new Error('gfail')),
      passkeyAdapter: { ...passkeyAdapter, isSupported: () => true },
      lastSignInMethod: { read: () => 'magic-link', write: vi.fn() },
    });
    expect(screen.queryByTestId('login-google')).toBeNull();
    await userEvent.click(screen.getByText('Other ways to sign in →'));
    await userEvent.click(screen.getByTestId('login-google'));
    await screen.findByText('gfail');
    expect(screen.getByTestId('login-google')).toBeInTheDocument();
    expect(screen.getByTestId('login-passkey')).toBeInTheDocument();
    await userEvent.type(screen.getByTestId('login-email'), 'a@b.co');
    await userEvent.click(screen.getByTestId('login-magic-link-submit'));
    await waitFor(() => expect(screen.queryByText('gfail')).toBeNull());
  });

  it('typing in the email field after a Google error does not steal focus back', async () => {
    setup({ onGoogleSignIn: vi.fn().mockRejectedValue(new Error('gfail')) });
    await userEvent.click(screen.getByTestId('login-google'));
    await screen.findByText('gfail');
    const input = screen.getByTestId('login-email');
    await userEvent.click(input);
    await userEvent.type(input, 'abc');
    expect(input).toHaveFocus();
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
    expect(screen.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy');
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
