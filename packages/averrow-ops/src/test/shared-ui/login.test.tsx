import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LoginPage } from '@averrow/shared/login';
import { AUTH_ERROR_CODES, AUTH_ERROR_COPY } from '@averrow/shared';
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

const GOOGLE_FAILED = 'Google sign-in failed. Try again or use another method.';

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

  it.each(['__proto__', 'constructor'])('?error=%s shows the generic copy, not the code', (code) => {
    setup({}, `?error=${code}`);
    const err = screen.getByTestId('login-error');
    expect(err).toHaveTextContent('Sign-in failed. Try again.');
    expect(err).not.toHaveTextContent(code);
  });

  it('does not echo a sentence supplied in ?error=', () => {
    setup({}, `?error=${encodeURIComponent('Your account is locked, call 555-0100')}`);
    const err = screen.getByTestId('login-error');
    expect(err).toHaveTextContent('Sign-in failed. Try again.');
    expect(err).not.toHaveTextContent('555-0100');
  });

  it('shows generic copy for a well-formed but unknown code (no spoofable echo)', () => {
    setup({}, '?error=account_locked_call_support');
    const err = screen.getByTestId('login-error');
    expect(err).toHaveTextContent('Sign-in failed. Try again.');
    expect(err).not.toHaveTextContent('account_locked_call_support');
    expect(err).not.toHaveTextContent('Sign-in error:');
  });

  it('rejects over-long codes', () => {
    setup({}, `?error=${'a'.repeat(41)}`);
    expect(screen.getByTestId('login-error')).toHaveTextContent('Sign-in failed. Try again.');
  });

  it('ignores non-string override values', () => {
    setup({ errorCopy: { bad: 42 as unknown as string } }, '?error=bad');
    expect(screen.getByTestId('login-error')).toHaveTextContent('Sign-in failed. Try again.');
  });
});

// The worker redirects every sign-in failure to /v2/login?error=<code>
// (handlers/auth.ts redirectToLoginWithError); each code it can send must
// render its own customer copy, never the raw "Sign-in error: <code>".
describe('worker sign-in error codes', () => {
  it.each([...AUTH_ERROR_CODES])('?error=%s renders its shared copy', (code) => {
    setup({}, `?error=${code}`);
    const err = screen.getByTestId('login-error');
    expect(err).toHaveTextContent(AUTH_ERROR_COPY[code]);
    expect(err).not.toHaveTextContent(`Sign-in error: ${code}`);
  });

  it('renders the new invite / oauth copy in plain language', () => {
    setup({}, '?error=invite_account_conflict');
    const text = screen.getByTestId('login-error').textContent ?? '';
    expect(text).toMatch(/cannot be accepted with this email address/);
    expect(text).not.toMatch(/staff|role/i);
  });

  it('oauth_failed shows the Google retry copy', () => {
    setup({}, '?error=oauth_failed');
    expect(screen.getByTestId('login-error')).toHaveTextContent('Google sign-in did not complete. Try again.');
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

  it('shows fixed copy (never the thrown message), focuses it, re-enables the button', async () => {
    const onGoogleSignIn = vi.fn().mockRejectedValue(new Error('<img src=x onerror=alert(1)>'));
    const { container } = setup({ onGoogleSignIn });
    await userEvent.click(screen.getByTestId('login-google'));
    const err = await screen.findByTestId('login-error');
    expect(err).toHaveAttribute('role', 'alert');
    expect(err.textContent).toBe('Google sign-in failed. Try again or use another method.');
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
    await screen.findByText(GOOGLE_FAILED);
    await userEvent.click(screen.getByTestId('login-google'));
    await waitFor(() => expect(onGoogleSignIn).toHaveBeenCalledTimes(2));
  });

  it('falls back to generic copy for a non-Error rejection', async () => {
    setup({ onGoogleSignIn: vi.fn().mockRejectedValue('nope') });
    await userEvent.click(screen.getByTestId('login-google'));
    expect(await screen.findByTestId('login-error')).toHaveTextContent('Google sign-in failed. Try again or use another method.');
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
    expect(await screen.findByTestId('login-error')).toHaveTextContent('Google sign-in failed. Try again or use another method.');
  });

  it('a Google error forces the full menu and clears when the magic link is requested', async () => {
    setup({
      onGoogleSignIn: vi.fn().mockRejectedValue(new Error('gfail')),
      passkeyAdapter: { ...passkeyAdapter, isSupported: () => true },
      lastSignInMethod: { read: () => 'magic-link', write: vi.fn() },
    });
    expect(screen.queryByTestId('login-google')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Other ways to sign in' }));
    await userEvent.click(screen.getByTestId('login-google'));
    await screen.findByText(GOOGLE_FAILED);
    expect(screen.getByTestId('login-google')).toBeInTheDocument();
    expect(screen.getByTestId('login-passkey')).toBeInTheDocument();
    await userEvent.type(screen.getByTestId('login-email'), 'a@b.co');
    await userEvent.click(screen.getByTestId('login-magic-link-submit'));
    await waitFor(() => expect(screen.queryByText(GOOGLE_FAILED)).toBeNull());
  });

  it('typing in the email field after a Google error does not steal focus back', async () => {
    setup({ onGoogleSignIn: vi.fn().mockRejectedValue(new Error('gfail')) });
    await userEvent.click(screen.getByTestId('login-google'));
    await screen.findByText(GOOGLE_FAILED);
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
    expect(box).toHaveTextContent('Sign-in link requested');
  });

  it('set: a block-level <p> renders in the body without nesting warnings', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const box = await sendLink({ magicLinkSentCopy: (e) => <p>If {e} can sign in, a link is on its way.</p> });
      expect(box.querySelector('p')).not.toBeNull();
      expect(box.querySelector('span p')).toBeNull();
      expect(box).toHaveTextContent('a link is on its way.');
      expect(err).not.toHaveBeenCalled();
    } finally { err.mockRestore(); }
  });

  it('magicLinkSentTitle overrides the title', async () => {
    const box = await sendLink({ magicLinkSentTitle: () => 'Done', magicLinkSentCopy: () => 'body' });
    expect(box).toHaveTextContent('Done');
    expect(box).not.toHaveTextContent('Sign-in link requested');
  });
});

describe('facelift structure', () => {
  const clickOther = () => userEvent.click(screen.getByRole('button', { name: 'Other ways to sign in' }));
  const supported: PasskeyLoginAdapter = { ...passkeyAdapter, isSupported: () => true };
  const primaries = () => [...document.querySelectorAll('[data-testid="login-page"] button')]
    .filter((b) => b.className.includes('ds-btn-primary'));

  it('has a main landmark and an h1 with the product name', () => {
    setup();
    expect(screen.getByRole('main')).toBe(screen.getByTestId('login-page'));
    expect(screen.getByRole('heading', { level: 1, name: 'Averrow' })).toBeInTheDocument();
  });

  it('first visit: exactly one primary CTA (Google); Send link is secondary', () => {
    setup();
    expect(primaries()).toEqual([screen.getByTestId('login-google')]);
  });

  it('returning passkey: only passkey is primary', () => {
    setup({ passkeyAdapter: supported, lastSignInMethod: { read: () => 'passkey', write: vi.fn() } });
    expect(primaries()).toEqual([screen.getByTestId('login-passkey')]);
  });

  it('returning magic-link: Send link is the only primary, with the welcome line', async () => {
    setup({ lastSignInMethod: { read: () => 'magic-link', write: vi.fn() } });
    expect(primaries()).toEqual([screen.getByTestId('login-magic-link-submit')]);
    expect(screen.getByText('Welcome back. Use your email to sign in.')).toBeInTheDocument();
    await clickOther();
    expect(primaries()).toEqual([screen.getByTestId('login-magic-link-submit')]);
  });

  it('error state with every method shown: still one primary', () => {
    setup({ passkeyAdapter: supported }, '?error=signin_failed');
    expect(screen.getByTestId('login-passkey')).toBeInTheDocument();
    expect(primaries()).toEqual([screen.getByTestId('login-google')]);
  });

  it('renders the brandLetters monogram when brandMark is absent', () => {
    setup();
    expect(screen.getByText('AV')).toBeInTheDocument();
  });

  it('returning passkey: Send link is secondary on first render (no flip)', () => {
    setup({ passkeyAdapter: supported, lastSignInMethod: { read: () => 'passkey', write: vi.fn() } });
    expect(screen.getByTestId('login-magic-link-submit').className).not.toContain('ds-btn-primary');
  });

  it('focuses a newly revealed PRIMARY (passkey-unsupported returning-passkey user)', async () => {
    setup({ lastSignInMethod: { read: () => 'passkey', write: vi.fn() } });
    expect(screen.queryByTestId('login-google')).toBeNull();
    await clickOther();
    expect(screen.getByTestId('login-google')).toHaveFocus();
    expect(primaries()).toEqual([screen.getByTestId('login-google')]);
  });

  it('moves focus to "Use a different email" when the link is sent', async () => {
    setup();
    await userEvent.type(screen.getByTestId('login-email'), 'a@b.co');
    await userEvent.click(screen.getByTestId('login-magic-link-submit'));
    const btn = await screen.findByRole('button', { name: 'Use a different email' });
    await waitFor(() => expect(btn).toHaveFocus());
  });

  it('page error renders before the CTAs, role=alert, not focused for URL errors', () => {
    setup({}, '?error=signin_failed');
    const err = screen.getByRole('alert');
    expect(err).toBe(screen.getByTestId('login-error'));
    expect(err).not.toHaveFocus();
    expect(err.compareDocumentPosition(screen.getByTestId('login-google')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(err.compareDocumentPosition(screen.getByTestId('login-magic-link-submit')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('moves focus to the first newly shown control after "Other ways to sign in"', async () => {
    setup({ passkeyAdapter: supported, lastSignInMethod: { read: () => 'google', write: vi.fn() } });
    expect(screen.queryByTestId('login-passkey')).toBeNull();
    await clickOther();
    expect(screen.queryByRole('button', { name: 'Other ways to sign in' })).toBeNull();
    expect(screen.getByTestId('login-passkey')).toHaveFocus();
  });

  it('falls back to the email field when nothing new is revealed', async () => {
    setup({ lastSignInMethod: { read: () => 'google', write: vi.fn() } });
    await clickOther();
    expect(screen.getByTestId('login-email')).toHaveFocus();
  });

  it('"Use a different email" returns focus to the email field', async () => {
    setup();
    await userEvent.type(screen.getByTestId('login-email'), 'a@b.co');
    await userEvent.click(screen.getByTestId('login-magic-link-submit'));
    await userEvent.click(await screen.findByRole('button', { name: 'Use a different email' }));
    expect(screen.getByTestId('login-email')).toHaveFocus();
  });

  it('sent state is a status region with a single primary (Google) still present', async () => {
    setup();
    await userEvent.type(screen.getByTestId('login-email'), 'a@b.co');
    await userEvent.click(screen.getByTestId('login-magic-link-submit'));
    expect((await screen.findByTestId('login-magic-link-sent'))).toHaveAttribute('role', 'status');
    expect(primaries()).toHaveLength(1);
  });

  it('passkey busy state sets aria-busy', async () => {
    let finish!: (v: boolean) => void;
    const signIn = vi.fn(() => new Promise<boolean>((r) => { finish = r; }));
    setup({
      passkeyAdapter: { ...supported, signIn },
      lastSignInMethod: { read: () => 'passkey', write: vi.fn() },
    });
    const btn = screen.getByTestId('login-passkey');
    expect(btn).not.toHaveAttribute('aria-busy');
    await userEvent.click(btn);
    expect(screen.getByTestId('login-passkey')).toHaveAttribute('aria-busy', 'true');
    finish(false);
    await waitFor(() => expect(screen.getByTestId('login-passkey')).not.toHaveAttribute('aria-busy'));
  });

  it('keeps the security-critical email input attributes', () => {
    setup();
    const input = screen.getByTestId('login-email');
    expect(input).toHaveAttribute('id', 'login-email');
    expect(input).toHaveAttribute('type', 'email');
    expect(input).toHaveAttribute('inputmode', 'email');
    expect(input).toHaveAttribute('autocomplete', 'username webauthn');
  });
});

describe('fixed failure copy (server / exception text is never rendered)', () => {
  const EVIL = '<b>pwned</b> internal stack';
  const supportedAdapter = (signIn: PasskeyLoginAdapter['signIn']): PasskeyLoginAdapter => ({
    isSupported: () => true,
    startConditionalUI: vi.fn().mockResolvedValue(undefined),
    signIn,
  });
  const submitLink = async () => {
    await userEvent.type(screen.getByTestId('login-email'), 'a@b.co');
    await userEvent.click(screen.getByTestId('login-magic-link-submit'));
    return screen.findByTestId('login-magic-link-error');
  };

  it.each([
    [400, 'Enter a valid email address.'],
    [429, 'Too many requests. Try again in a few minutes.'],
    [500, "We couldn't send the link. Try again."],
    [undefined, "We couldn't send the link. Try again."],
  ])('magic link envelope status %s shows fixed copy', async (status, copy) => {
    const post = vi.fn().mockResolvedValue({ success: false, error: EVIL, status });
    setup({ apiClient: { post } });
    const alert = await submitLink();
    expect(alert).toHaveTextContent(copy);
    expect(document.body.textContent).not.toContain('pwned');
    expect(document.body.textContent).not.toContain('internal stack');
    expect(alert.querySelector('b')).toBeNull();
  });

  it('magic link network failure shows fixed copy, not the exception message', async () => {
    const post = vi.fn().mockRejectedValue(new Error(EVIL));
    setup({ apiClient: { post } });
    const alert = await submitLink();
    expect(alert).toHaveTextContent("We couldn't send the link. Try again.");
    expect(document.body.textContent).not.toContain('pwned');
  });

  it('magic link thrown error carrying a 429 status maps to rate-limit copy', async () => {
    const post = vi.fn().mockRejectedValue(Object.assign(new Error(EVIL), { status: 429 }));
    setup({ apiClient: { post } });
    expect(await submitLink()).toHaveTextContent('Too many requests. Try again in a few minutes.');
    expect(document.body.textContent).not.toContain('pwned');
  });

  it('messages prop overrides the fixed copy', async () => {
    const post = vi.fn().mockResolvedValue({ success: false, error: EVIL, status: 429 });
    setup({ apiClient: { post }, messages: { rateLimited: 'Slow down.' } });
    expect(await submitLink()).toHaveTextContent('Slow down.');
  });

  const fail = async (err: unknown) => {
    const signIn = vi.fn().mockRejectedValue(err);
    setup({
      passkeyAdapter: supportedAdapter(signIn),
      lastSignInMethod: { read: () => 'passkey', write: vi.fn() },
    });
    await userEvent.click(screen.getByTestId('login-passkey'));
    return screen.findByTestId('login-passkey-error');
  };

  it.each([
    ['NotAllowedError', 'Passkey sign-in was cancelled. Try again or use another method.'],
    ['AbortError', 'Passkey sign-in was cancelled. Try again or use another method.'],
    ['InvalidStateError', 'This passkey cannot be used here. Try another method.'],
    ['SecurityError', 'Passkey sign-in is not available on this page. Use another method.'],
    ['TypeError', 'Passkey sign-in failed. Try again or use another method.'],
  ])('passkey %s shows fixed copy', async (name, copy) => {
    const err = Object.assign(new Error(EVIL), { name });
    const alert = await fail(err);
    expect(alert).toHaveTextContent(copy);
    expect(document.body.textContent).not.toContain('pwned');
  });

  // simplewebauthn v11 wraps a dismissed prompt as WebAuthnError whose cause is
  // the NotAllowedError DOMException, so production shows the cancelled copy.
  it('passkey wrapper error is classified by its cause', async () => {
    const err = new Error(EVIL, { cause: Object.assign(new Error('x'), { name: 'NotAllowedError' }) });
    expect(await fail(err)).toHaveTextContent('Passkey sign-in was cancelled.');
  });

  it('passkey plain server-style error and non-Error throws show generic copy', async () => {
    expect(await fail(new Error(EVIL))).toHaveTextContent('Passkey sign-in failed. Try again or use another method.');
    expect(document.body.textContent).not.toContain('pwned');
  });

  it('passkey non-Error throw shows generic copy', async () => {
    expect(await fail(EVIL)).toHaveTextContent('Passkey sign-in failed.');
    expect(document.body.textContent).not.toContain('pwned');
  });

  it('adapter returning false (dismissed) shows no error and re-enables the button', async () => {
    setup({
      passkeyAdapter: supportedAdapter(vi.fn().mockResolvedValue(false)),
      lastSignInMethod: { read: () => 'passkey', write: vi.fn() },
    });
    await userEvent.click(screen.getByTestId('login-passkey'));
    await waitFor(() => expect(screen.getByTestId('login-passkey')).not.toBeDisabled());
    expect(screen.queryByTestId('login-passkey-error')).toBeNull();
  });

  it('isSupported throwing does not crash; passkey is treated as unsupported', () => {
    const startConditionalUI = vi.fn();
    setup({
      passkeyAdapter: {
        isSupported: () => { throw new Error(EVIL); },
        startConditionalUI,
        signIn: vi.fn(),
      },
      lastSignInMethod: { read: () => 'passkey', write: vi.fn() },
    });
    expect(screen.getByTestId('login-page')).toBeInTheDocument();
    expect(screen.queryByTestId('login-passkey')).toBeNull();
    expect(startConditionalUI).not.toHaveBeenCalled();
  });

  it('Google sign-in with a hostile thrown message shows fixed copy', async () => {
    const onGoogleSignIn = vi.fn().mockRejectedValue(new Error(EVIL));
    setup({ onGoogleSignIn });
    await userEvent.click(screen.getByTestId('login-google'));
    expect(await screen.findByTestId('login-error')).toHaveTextContent('Google sign-in failed. Try again or use another method.');
    expect(document.body.textContent).not.toContain('pwned');
  });

  it('messages.googleFailed overrides the Google copy', async () => {
    const onGoogleSignIn = vi.fn().mockRejectedValue(new Error(EVIL));
    setup({ onGoogleSignIn, messages: { googleFailed: 'Google is unavailable.' } });
    await userEvent.click(screen.getByTestId('login-google'));
    expect(await screen.findByTestId('login-error')).toHaveTextContent('Google is unavailable.');
  });
});

describe('LoginPage.tsx source guard (token-only)', () => {
  const src = readFileSync(resolve(__dirname, '../../../../shared/src/login/LoginPage.tsx'), 'utf8');
  it.each([/#[0-9a-fA-F]{3,8}\b/, /rgba?\(/, /linear-gradient/, /backdropFilter/, /backdrop-blur/, /uppercase/, /--amber/, /--text-on-amber/, /font-mono/])(
    'contains no %s', (re) => { expect(src).not.toMatch(re); },
  );
});
