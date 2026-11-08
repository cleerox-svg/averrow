// Sign-in failure codes — the ONLY values the worker puts in the login
// page's `?error=` parameter (handlers/auth.ts `redirectToLoginWithError`),
// and the customer-facing copy the shared LoginPage shows for each.
//
// One list so the two sides can't drift: the worker's redirect helper takes
// an `AuthErrorCode`, and `AUTH_ERROR_COPY` is a `Record<AuthErrorCode, …>`,
// so adding a code without copy (or copy for a code nobody sends) fails the
// typecheck. Codes are plain `[a-z0-9_]` so they pass the LoginPage's
// anti-spoofing pattern; free text never travels in the URL.
//
// Copy rules: plain language, no internal detail (no role names, no policy
// wording, no "staff"), say what the person can do next.

export const AUTH_ERROR_CODES = [
  // Magic link
  'invalid_link',
  'link_used_or_invalid',
  'link_expired',
  // Account state
  'account_deactivated',
  'no_account',
  // Google sign-in
  'oauth_failed',
  'email_unverified',
  // Invitations
  'invite_invalid',
  'invite_expired',
  'invite_email_mismatch',
  'invite_account_conflict',
  'invite_changed',
  // Catch-all
  'signin_failed',
] as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

export const AUTH_ERROR_COPY: Record<AuthErrorCode, string> = {
  invalid_link:            'That sign-in link looks malformed.',
  link_used_or_invalid:    'That sign-in link was already used or is invalid. Some email security scanners open links automatically — request a new one below.',
  link_expired:            'That sign-in link expired. Request a new one below.',
  account_deactivated:     'This account has been deactivated.',
  no_account:              'There is no Averrow account for that sign-in. Access is by invitation — ask your administrator to invite you.',
  oauth_failed:            'Google sign-in did not complete. Try again.',
  email_unverified:        'Your Google account email is not verified. Verify it with Google, then try again.',
  invite_invalid:          'That invitation is invalid or has already been used. Ask for a new invitation.',
  invite_expired:          'That invitation has expired. Ask for a new invitation.',
  invite_email_mismatch:   'That invitation was sent to a different email address. Sign in with the Google account for the invited email.',
  invite_account_conflict: 'This invitation cannot be accepted with this email address. Ask the person who invited you to send the invitation to a different address.',
  invite_changed:          'Your account changed while the invitation was being accepted. Open the invitation link again.',
  signin_failed:           'Sign-in failed. Try again.',
};

export function isAuthErrorCode(value: unknown): value is AuthErrorCode {
  return typeof value === 'string' && (AUTH_ERROR_CODES as readonly string[]).includes(value);
}
