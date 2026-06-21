# Login Experience Audit (2026-06)

Focused audit of the staff sign-in flow (`/v2/login`, shared `@averrow/shared/login`)
prompted by: "the auth flow seems clunky… disconnected, not consistently branded,
illogical in some areas," + a concrete bug — **passkey/biometric hangs on a
spinner; a manual refresh then lands in the platform.**

Method: read the governing `docs/SHARED_LOGIN_SPEC.md`, traced the passkey ↔
AuthProvider ↔ backend `issueSession` path, and **observed the live prod login
in a real browser** (chrome-devtools) to capture computed styles / theme / network.

> ⚠️ Login + Profile are a **single shared component** governed by
> `SHARED_LOGIN_SPEC.md` (Averrow ↔ FarmTrack parity). Fixes here must respect
> that spec or update it + the sibling product.

---

## Findings

### F1 — Layout is broken: Tailwind purges shared-only utility classes ✅ confirmed (fixed)

**Severity: High · universal (every user, every browser).**

The login `<section>` uses `min-h-screen items-center justify-center` to fill the
viewport and center the card. Live observation:

- `getComputedStyle(section).minHeight === "0px"` — `min-h-screen` **isn't applying**.
- A probe `<div class="min-h-screen">` also computes `min-height: 0px` → the class
  **has no CSS rule at all** (purged), while `max-w-md`, `flex`, `items-center` resolve fine.

**Root cause:** `@averrow/shared` resolves to **source** (`packages/shared/src/*`
per its `exports` map), but `tailwind.config.ts` `content` only scanned
`['./index.html','./src/**/*.{ts,tsx}']` — **not the shared package**. So any
utility class used *only* in a shared component (`min-h-screen` is used nowhere in
ops' own `src/`) gets purged. Result: the login section collapses to content
height, the card floats at the top, and the dark `<body>` shows through below the
short light section → the "disconnected / unfinished" look. **Also affects the
shared ProfilePage and every other shared-only class.**

**Fix (shipped):** add `'../shared/src/**/*.{ts,tsx}'` to `content` in **both**
`averrow-ops` and `averrow-tenant` tailwind configs (tenant renders the same
shared ProfilePage and had the identical gap). Build-config only — no component
or spec change. _Verify on next deploy that `min-h-screen` is present._

### F2 — Login follows the OS color scheme → white card, off-brand ✅ confirmed

**Severity: Med-High · conditional on the device's OS theme.**

Live: `<html data-theme="light">` with `localStorage 'averrow-theme' === null` and
the browser `prefers-color-scheme: light`. `main.tsx` only force-sets light when a
stored pref is `'light'`; with no stored pref the shared `bootstrapTheme`/`useTheme`
**follows the OS**. So on any light-OS device a staffer gets a **white login card**
(`--bg-card: #FFFFFF`, dark text) while the brand/body is dark navy (`#080E18`) —
the only light surface in an otherwise dark, dark-first security product. Combined
with F1, the result reads as broken + unbranded (see screenshot in the PR).

**Decision needed (product call):** the login is a **brand surface**. Options:
(a) **brand-lock the login to dark** regardless of OS (what most security products
do); (b) keep OS-respecting but ensure it looks intentional once F1 is fixed;
(c) default-to-dark when there's no stored preference (treat dark as the brand
default, not the OS default). _Recommend (a) or (c)._ Touches the theme bootstrap /
shared surface → confirm before changing.

### F3 — Passkey/biometric hangs on the spinner; refresh fixes it 🔬 mechanism diagnosed

**Severity: High · the reported bug.**

Traced the flow: `LoginPage.handlePasskey` → shared `signInWithPasskey` →
`auth/begin` → `startAuthentication` (biometric) → `auth/finish` (JSON envelope:
`{access_token, expires_in, return_to}`, refresh cookie via `Set-Cookie`) →
`window.location.assign(\`${return_to}#token=…\`)`. The `LoginPage` keeps the button
in **"Waiting…"** forever and relies *entirely* on that hard-nav to move the page
(`// On success, signIn navigates the page; this component unmounts.`), with **no
timeout / fallback**.

**What's certain:** the hang is **after `auth/finish`** — the refresh cookie is set
(that's why a manual reload's cookie-refresh logs you straight in), so the failure
is purely in the **post-success client navigation**, not auth itself. If
`window.location.assign(target)` does not actually reload the document into the app
(e.g. the hash-only same-path case, a `beforeunload`/SW interception, or `return_to`
collapsing), the AuthProvider — which reads the URL hash **once on mount** — never
consumes the token, and the spinner spins. A manual refresh re-runs the AuthProvider
→ cookie-refresh → `/me` → in.

**Contributing smell:** the page also starts a **conditional-UI passkey ceremony on
mount** (observed: `/api/passkeys/auth/begin → 200`, left pending). Clicking the
explicit passkey button starts a **second** ceremony; the two race via
simplewebauthn's shared abort service.

**Proposed fix (robust, trigger-independent):** stop depending on a fragile hard-nav.
The passkey XHR flow already has the access token *in JS*, so the host should
hydrate directly:
1. **Preferred:** give the passkey adapter an `onAuthenticated(accessToken, returnTo)`
   callback so the host sets the token in memory (`httpClient.setTokens`), calls
   `refreshUser()`, and SPA-navigates — no reload, no hash, no race. (Adapter
   contract change → update `SHARED_LOGIN_SPEC.md`.)
2. **Minimal:** in `signInWithPasskey`, after `assign(target)`, force
   `window.location.reload()` when `return_to` resolves to the current path (hash-only
   no-reload case); and abort the conditional ceremony before starting the explicit one.
3. Either way, add a **spinner timeout** in `handlePasskey` so it can never hang
   silently — show a retry on stall.

_I couldn't 100%-pin the exact trigger from prod without an account + a seeded
credential; offered to confirm with a WebAuthn **virtual authenticator** repro._

---

## UX / branding observations (the "clunky / illogical" framing)

- With **F1 + F2** fixed, the page is at least dark, full-height, branded, centered.
  The current breakage is most of the "disconnected" feeling.
- The **adaptive primary CTA** (first-time → Google + magic-link, no passkey button)
  is **per-spec and correct** — not a bug. Returning users get their last method.
- Per-spec the page is a single centered card. "Best of breed" security logins
  often use a **split brand panel + form** or a branded backdrop; that's an optional
  **elevation**, a design call, not a defect.

## Recommended order

1. **F1 (shipped)** — Tailwind content fix. Safe, universal, fixes the layout.
2. **F3** — passkey hang. The actual reported bug; ship the robust hydration fix
   (+ spinner timeout) after confirming the adapter-callback vs minimal approach.
3. **F2** — brand-lock/dark-default the login (product call).
4. *(optional)* design elevation of the login surface.

---

## Resolution (2026-06)

- **F1 — shipped** (PR #1532): Tailwind `content` now scans `@averrow/shared`.
- **F2 — shipped** (brand-lock dark): `<LoginPage>` forces `data-theme="dark"`
  on mount, restores prior on unmount. Spec §1 updated. _Operator choice:
  brand-lock to dark._
- **F3 — shipped** (robust callback hydration): added `onSuccess(token, expiresIn,
  returnTo)` to the passkey `SignInOptions`; when set, `signInWithPasskey` hands
  the token to the host instead of the fragile `window.location.assign` hard-nav.
  The ops Login wrapper now builds the passkey adapter inside the component and on
  success: `api.setTokens(token)` (memory, H5) → `refreshUser()` → SPA-`navigate`.
  No reload, no URL hash, no same-path no-op, no hanging spinner. Both the explicit
  button and the conditional-UI ceremony route through it. Spec §1+§8 updated.
  _Operator choice: robust callback fix._

Open/optional: design elevation of the login surface (split brand panel etc.) —
a future enhancement, not a defect.
