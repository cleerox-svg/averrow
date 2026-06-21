# Shared Login Spec — Averrow ↔ FarmTrack

**Purpose:** keep the login + profile + PWA install + biometric flows
identical across Averrow and FarmTrack so users get the same experience
on both products. Each product carries the parent brand and ships
independent backends; only the deltas listed at the bottom of this
document are allowed to differ.

If you change anything in the "Required parity" sections below, update
this doc and ping the sibling platform.

---

## 1. Login page

**The Login page is now a single canonical component shared by all
products.** Both averrow-ops's `/v2/login` and (future) FarmTrack's
`/login` render `<LoginPage>` from `@averrow/shared/login`. Each
product passes branding deltas and adapter callbacks via props.
Edit the shared component, NOT per-product wrappers.

```
packages/shared/src/login/
  LoginPage.tsx         — composition + adaptive primary CTA
                           state machine
  lastSignInMethod.ts   — per-device localStorage hint helper
                           (key namespace passed in by host)
  types.ts              — LoginPageProps, LoginBranding,
                           LoginApiClient, PasskeyLoginAdapter,
                           LastSignInMethodAdapter, SignInMethod
  index.ts              — public exports
```

Per-product wrapper:

```tsx
// packages/averrow-ops/src/pages/Login.tsx
import { LoginPage, makeLastSignInMethodAdapter } from '@averrow/shared/login';

export function Login() {
  return (
    <LoginPage
      branding={{
        brandLetters:  'AV',
        productName:   'Averrow',
        tagline:       'AI-First Threat Intelligence',
        footerPillars: 'Detect · Analyze · Correlate · Respond',
      }}
      apiClient={...}
      passkeyAdapter={...}
      lastSignInMethod={makeLastSignInMethodAdapter('averrow.lastSignInMethod')}
      returnTo="/v2/"
    />
  );
}
```

### Layout

```
┌─────────────────────────────────────┐
│        ┌──────┐                     │
│        │ AV │ (rounded square)      │  ← brand tile
│        └──────┘                     │     56×56, gradient amber
│                                     │     fontSize 20, "AV"/"FT" label
│         Averrow                     │  ← product name
│                                     │     28px bold
│  AI-FIRST THREAT INTELLIGENCE       │  ← tagline
│                                     │     mono uppercase, 9px,
│                                     │     letter-spacing 0.24em,
│                                     │     amber color
│                                     │
│  ┌─────────────────────────────┐    │  ← passkey button (green)
│  │  🔒 SIGN IN WITH PASSKEY    │    │     only when isPasskeySupported
│  └─────────────────────────────┘    │     min-height 48
│                                     │
│  ┌─────────────────────────────┐    │  ← Google button (amber)
│  │  SIGN IN WITH GOOGLE        │    │     min-height 48
│  └─────────────────────────────┘    │
│                                     │
│  ─────────  OR  ─────────────       │  ← divider
│                                     │
│  EMAIL ME A SIGN-IN LINK            │  ← magic-link label
│  ┌──────────────────┐ ┌──────────┐  │
│  │ you@example.com  │ │ SEND LINK│  │
│  └──────────────────┘ └──────────┘  │
│                                     │
│  Works with any email — Microsoft   │  ← helper text
│  365, Outlook, Yahoo, custom        │
│  domain. No password needed.        │
│                                     │
│  DETECT · ANALYZE · CORRELATE       │  ← footer pillars
│         · RESPOND                   │     mono uppercase, 10px,
│                                     │     letter-spacing 0.22em
└─────────────────────────────────────┘
```

### Required parity (do not deviate without updating this doc)

| Element | Spec |
|---|---|
| Card max-width | `max-w-md` (~448px) |
| Card padding | `40px 32px` |
| Card background | `linear-gradient(160deg, var(--bg-card) 0%, var(--bg-card-deep) 100%)` |
| Card backdrop-filter | `blur(20px)` |
| Card top rim | 1px gradient, transparent → `var(--amber-border)` 25%–75% → transparent |
| Brand tile | 56×56, `border-radius: 14`, gradient `var(--amber)` → `var(--amber-dim)`, `box-shadow: 0 0 24px var(--amber-glow)` |
| Brand tile letters | 2-character product abbreviation, `fontSize: 20`, `fontWeight: bold`, color `var(--text-on-amber)` |
| Product name | `fontSize: 28`, `fontWeight: bold`, `letterSpacing: -0.5`, color `var(--text-primary)` |
| Tagline | mono uppercase, `fontSize: 9`, `letterSpacing: 0.24em`, `fontWeight: 700`, color `var(--amber)` |
| Auth button order | passkey (green, conditional on support) → Google (amber) → divider → magic-link |
| Auth button height | `min-height: 48` |
| Auth button padding | `14px 24px` |
| Auth button radius | `12` |
| Passkey button gradient | `linear-gradient(135deg, var(--green), rgba(60,184,120,0.7))` |
| Google button gradient | `linear-gradient(135deg, var(--amber), var(--amber-dim))` |
| Magic-link helper text | "Works with any email — Microsoft 365, Outlook, Yahoo, custom domain. No password needed." |
| Footer pillars | mono uppercase, `fontSize: 10`, `letterSpacing: 0.22em`, `fontWeight: 700`, color `var(--text-muted)` |
| Conditional UI | Started on mount when `isPasskeySupported()`. Email input has `autoComplete="username webauthn"`. |

### Per-product deltas (allowed)

- **Brand tile letters:** Averrow uses `AV`, FarmTrack uses `FT`.
- **Product name:** "Averrow" / "FarmTrack".
- **Tagline:** Averrow uses `AI-FIRST THREAT INTELLIGENCE`. FarmTrack uses `AN AVERROW PRODUCT` (parent-brand attribution since Averrow is the parent).
- **Footer pillars:** Averrow uses `DETECT · ANALYZE · CORRELATE · RESPOND`. FarmTrack uses `PROJECTIONS · CAPTURE · TRANSPORT · QA`.
- **OAuth `return_to`:** points to each product's main interior route (`/v2/` for Averrow, which lands on the Home / Command Center; `/` for FarmTrack).

### Forbidden deltas

- Removing auth options. All three (passkey, Google, magic-link) must always be reachable.
- Replacing the magic-link helper copy.
- Showing the Google profile picture anywhere. Initials only — see §3.
- Adding extra auth options without updating this spec.

### Adaptive primary CTA (added 2026-05)

The Login page now picks the **primary** auth method based on a
per-device `localStorage` hint (`averrow.lastSignInMethod` /
`farmtrack.lastSignInMethod`) recorded the moment a user clicks
their chosen method. The hint is one of `passkey | google |
magic-link`, and is cleared on logout.

| Hint state | Primary | Secondary | Notes |
|---|---|---|---|
| _null_ (first-time) | Google (amber) | magic-link below divider | **No standalone passkey button.** Conditional UI still runs in the email autofill so registered passkeys appear there silently. We don't push first-timers toward a "Sign in with passkey" CTA they have no passkey for. |
| `passkey` | Passkey (green) | "Other ways to sign in →" disclosure | Welcome-back pill above the button: _"Welcome back · sign in with passkey"_. |
| `google` | Google (amber) | "Other ways to sign in →" disclosure | Welcome-back pill: _"Welcome back · sign in with Google"_. |
| `magic-link` | Email field + amber "Send link" | "Other ways" exposes Google + passkey above divider | Top-button block hidden by default. |
| Sign-in error (`?error=…`) | Full menu (every supported method) | — | `showAll` is forced; user picks again. |

When the user clicks **Other ways to sign in →**, every supported
method becomes visible at once (passkey ⊕ Google as primary +
secondary; the magic-link block stays below the divider regardless).

Rationale: the previous always-on three-button menu showed a green
"Sign in with passkey" CTA to brand-new visitors who had no
registered passkey. Clicking it took them to a "no passkey found"
OS prompt — confusing first-time UX. The new flow matches the
pattern Google / Microsoft / GitHub use: invisible conditional UI
on first visit, last-used method as primary on return visits, full
menu always one click away.

This deviation from the original "passkey → Google → magic-link"
fixed order is intentional. **FarmTrack must mirror this behavior**
to keep parity. The button styling (green passkey, amber Google,
neutral Send-link) is unchanged.

### Brand-locked theme (added 2026-06, login audit F2)

The login is a **brand surface** and renders in the **dark brand theme
regardless of the OS / stored preference** (which only governs the look
*inside* the app). `<LoginPage>` sets `data-theme="dark"` on mount and
restores the prior value on unmount. Rationale: without it, a light-OS
device gets a white, off-brand login card — the only light surface in an
otherwise dark, dark-first product. **FarmTrack must mirror this.**

---

## 2. Profile page

**The Profile page is now a single canonical component shared by
both products.** Both `/v2/profile` (averrow-ops) and
`/tenant/profile` (averrow-tenant) render
`<ProfilePage>` from `@averrow/shared/profile`. Per-product deltas
flow through props (api client, feature flags, callbacks, brand
text). Edit the shared component, NOT the per-product wrappers.

```
packages/shared/src/profile/
  ProfilePage.tsx       — composition + section order
  sections.tsx          — IdentitySection, AccountSection, …
  primitives.tsx        — Card, Button, Input, Pill, helpers
  types.ts              — ProfilePageProps, ProfileApiClient,
                          PasskeyAdapter, ProfileFeature
  index.ts              — public exports
```

### Section order (canonical, enforced inside ProfilePage)

1. **Identity** — avatar (initials only) + display_name + email + role badge + org pill.
2. **Account** — display_name editor + read-only email.
3. **Preferences** — theme toggle (Dark / Light) + timezone select.
4. **Passkeys** — per-device list with `BIOMETRIC` badge when `transports` includes `"internal"`. Add-on-this-device + per-row remove.
5. **Notifications** — single-row card linking to the host app's notifications-preferences route.
6. **Billing** (tenant only) — single-row card linking to `/settings/billing`. Plan badge inline.
7. **Security** — active-sessions count + "Revoke other sessions" button + per-session list (top 5).
8. **Sign out** — closing card with red button.

Skipped sections render `null` based on the `features` prop. Future sections (e.g. **Install**, **Organization**, **2FA / TOTP**) plug into the same composition without changing per-product wrappers.

### Per-product feature flags

| Feature      | /v2 (staff) | /tenant (customer) |
|---|---|---|
| `identity`     | ✓ | ✓ |
| `account`      | ✓ | ✓ |
| `preferences`  | ✓ | ✓ |
| `passkeys`     | ✓ | ✓ |
| `notifications`| ✓ | ✓ |
| `billing`      | ✗ | ✓ |
| `security`     | ✓ | (deferred — needs tenant-scoped sessions endpoint) |

### Required parity

| Element | Spec |
|---|---|
| Avatar size on Profile | 64×64, `border-radius: 50%`, background `SELF_AVATAR_COLOR` (`var(--amber)`) |
| Avatar initials font | `fontSize: 24`, `fontWeight: bold`, color `var(--text-on-amber)` |
| Each section | Wrapped in `<Card>` with `mb-4` |
| Section headers | `<SectionLabel>` mono uppercase |
| Display-name save | `PATCH /api/profile { display_name: <string\|null> }` |
| Theme save | `PATCH /api/profile { theme_preference: 'dark'\|'light' }` |
| Timezone save | `PATCH /api/profile { timezone: <IANA> }` |
| Notification row icon | `Bell` from lucide-react |
| BIOMETRIC badge | `<Badge variant="success">Biometric</Badge>`, only when `pk.transports.includes('internal')` |

---

## 3. Avatars — initials only, never Google profile picture

### Rules

- **Source:** `display_name` parsed as `(first word, last word)`.
  - `"Claude Leroux"` → `"CL"`
  - `"Claude Marc Leroux"` → `"CL"` (first + last word, drops middle)
  - `"Claude"` → `"C"`
  - `null` + email → first char of email local-part
  - `null` + `null` → `"?"`

- **Self-avatar color:** always static `SELF_AVATAR_COLOR` (`var(--amber)`). Top-bar pill, profile dropdown, profile identity card.

- **Other-user avatar color:** deterministic via `colorForUserId(userId)`. Same user → same color across the app. Used in admin lists, attribution rows, comment authors. Picks from `[amber, red, green, blue, violet, cyan, pink, yellow]`.

- **Never render the Google profile picture.** Drop `pictureUrl` / `avatar_url` from any `<Avatar>` props or `<img>` tags that previously rendered Google's hosted image.

### Implementation

`packages/averrow-ops/src/lib/avatar.ts` is the source of truth. Both
platforms should share an identical file (re-pasted, since the
platforms are independent repos for now).

---

## 4. PWA install affordances

### Two surfaces

- **`<InstallAppBanner />`** — always-visible CTA on the Home page.
  - Hidden when `isStandalone()`.
  - Dismissible per-device via `localStorage` key `<product>.install.dismissed`.
  - Android Chrome / Edge: captured `beforeinstallprompt` → native install button.
  - iOS Safari: four-step Share → Add to Home Screen instructions inline.

- **`<InstallAppCard />`** — always-visible affordance on Profile.
  - Hidden when `isStandalone()`.
  - **Not dismissible** — user can always reach it from Profile.
  - Includes a "Show manual steps" expander for desktop browsers that didn't fire `beforeinstallprompt`.

### Required parity

| Element | Spec |
|---|---|
| iOS step icons | 24×24 amber circles with white number, `box-shadow: 0 0 10px rgba(229,168,50,0.45)` |
| iOS step text | 13px, `lineHeight: 1.5`, color `var(--text-secondary)` |
| Manual-steps fallback | Bullet list of `Chrome / Edge (desktop)`, `Chrome (Android)`, `Firefox (Android)`, `Safari / Chrome (iOS)` |
| LocalStorage dismiss key | `<product>.install.dismissed` (e.g. `averrow.install.dismissed`) |

---

## 5. Biometric (passkey) auto-prompt

### `<FirstSignInPasskeyPrompt />`

Mounted at the Shell layout root. Self-gates internally on:
- WebAuthn supported (`isPasskeySupported()`)
- `user.passkey_count === 0`
- localStorage key `<product>.passkey-prompt.dismissed` not set

### Buttons

- **"Set up biometric"** → calls `registerPasskey()`. On success: marks dismissed + refreshes `/me` so `passkey_count` flips 0 → 1.
- **"Maybe later"** → closes WITHOUT marking dismissed (re-prompts on next page load).
- **Click outside / × / dismiss** → marks dismissed (won't re-prompt).

### Required parity

| Element | Spec |
|---|---|
| Dialog backdrop | `rgba(4,9,18,0.78)` + `backdrop-filter: blur(8px)` |
| Dialog max-width | `440px` |
| Dialog rendering | `createPortal(..., document.body)` so it escapes Shell stacking contexts |
| Header icon | 56×56 green gradient lock-with-shackle SVG |
| Title | "Sign in faster next time?" |
| Body copy | Mentions Touch ID, Face ID, Windows Hello, fingerprint. Reassurance that biometric stays on-device. |
| Primary button | "Set up biometric" (green gradient) |
| Secondary button | "Maybe later" (transparent) |
| Footer note | "You can add or remove passkeys anytime from your Profile." |
| Auto-prompt delay | 1000ms after Shell mount (so it doesn't slam in mid-paint) |

---

## 6. Backend contract

### `/api/auth/me` response shape

```ts
interface MeResponse {
  id: string;
  email: string;
  /** Computed: display_name ?? name. Existing callers reading `name` keep working. */
  name: string;
  role: string;
  status: string;
  created_at: string;
  last_login: string | null;
  last_active: string | null;
  /** Editable in Profile; null falls back to the Google name. */
  display_name: string | null;
  /** IANA timezone; null means "auto-detect from browser." */
  timezone: string | null;
  /** Null means "follow OS / app default." */
  theme_preference: 'dark' | 'light' | null;
  /** Drives FirstSignInPasskeyPrompt — auto-prompts when 0. */
  passkey_count: number;
  /**
   * H-3 (AUTH_AUDIT_2026-06): true when this session is restricted to
   * passkey enrollment — a privileged user (admin/super_admin) who signed
   * in via a non-passkey method (Google/magic-link). The host renders a
   * mandatory enrollment gate (`<PasskeyEnrollmentGate>`) and blocks the
   * app until the user registers a passkey and signs in with it. The
   * backend returns 403 `passkey_enrollment_required` on every protected
   * route for such sessions; only the passkey-bootstrap endpoints
   * (register begin/finish, /me, logout, passkey list) remain reachable.
   * Always falsy for non-privileged users and passkey-authenticated
   * privileged sessions.
   */
  passkey_required: boolean;
  organization: {
    id: number;
    name: string;
    slug: string;
    plan: string;
    role: string;
  } | null;
}
```

### `/api/profile`

- `GET /api/profile` → `{ profile: { id, email, name, role, display_name, timezone, theme_preference } }`
- `PATCH /api/profile` body: `{ display_name?: string | null, timezone?: string | null, theme_preference?: 'dark' | 'light' | null }`
  - Empty-string `display_name` normalizes to `null`.
  - Timezone validated against `Intl.DateTimeFormat`.
  - theme_preference enum-checked.

### `/api/notifications/*` (Web Push)

| Method | Path | Auth | Body / params |
|---|---|---|---|
| `GET` | `/config` | none | — |
| `POST` | `/subscribe` | session | `{ subscription: { endpoint, keys: { p256dh, auth } }, device_label? }` |
| `DELETE` | `/unsubscribe` | session | `{ endpoint }` |
| `GET` | `/subscriptions` | session | — |
| `DELETE` | `/subscribe/:id` | session | path param |
| `POST` | `/test` | session | — |

**Subscribe payload follows `PushSubscription.toJSON()` exactly** — the
W3C spec output. No flat-shape variant accepted. Both platforms speak
this canonical shape.

### `/api/passkeys/*`

- `POST /register/begin` + `/register/finish`
- `POST /auth/begin` + `/auth/finish`
- `GET /api/passkeys` (or `/list`) returns `{ passkeys: [{ id, device_label, transports, ... }] }` with `transports` parsed as `string[]` (not the raw JSON-encoded TEXT column). UI checks `transports.includes('internal')` for the BIOMETRIC badge.
- `DELETE /api/passkeys/:id`

---

## 7. Files to keep aligned

When making changes to either platform, the following files should be
diffed against the sibling repo and kept structurally identical:

| File | Notes |
|---|---|
| `pages/Login.tsx` (or `src/app/pages/Login.tsx`) | Brand tile letters + tagline + footer pillars are the only allowed deltas |
| `features/settings/Profile.tsx` | Section order must match. Card composition identical. |
| `components/InstallAppCard.tsx` | Verbatim, swap product name |
| `components/InstallAppBanner.tsx` | Verbatim, swap product name + dismiss key |
| `components/PasskeysCard.tsx` | Verbatim |
| `components/FirstSignInPasskeyPrompt.tsx` | Verbatim, swap product name in copy + dismiss key |
| `hooks/useInstallPrompt.ts` | Verbatim |
| `lib/avatar.ts` | Verbatim |
| `lib/passkeys.ts` | Verbatim (route paths included) |
| `lib/pwa.ts` | Verbatim |
| `lib/push.ts` | Verbatim — both speak `/api/notifications/*` |

---

## 8. Security model — `@averrow/shared`

The shared package carries the auth-critical surfaces (Profile,
Login UI, Auth context, Passkeys). The architecture deliberately
keeps the shared package side-effect-light and host-driven:

### Token storage model (H5 — updated 2026-06-10; FarmTrack must mirror)

**This is a required-parity delta from the previous model. FarmTrack
must adopt the same scheme.**

| Token | Where it lives | Never |
|---|---|---|
| Refresh token | HttpOnly cookie (`radar_refresh` on Averrow; FarmTrack picks its own name) — `HttpOnly; Secure; SameSite=Strict; Path=/api/auth` | In localStorage, sessionStorage, JSON response bodies, or URL fragments. JS never sees it. |
| Access token | Host-app **memory only** (module variable / class field) | In localStorage or sessionStorage. |

Flow:

1. **Login (all methods — Google, magic-link, passkey):** the backend's
   session-issuing path sets the refresh cookie via `Set-Cookie` and
   delivers ONLY the short-lived access token to the SPA (URL hash for
   browser-navigation flows, JSON envelope for the passkey XHR flow).
   **Passkey host-hydration (login audit F3):** the passkey adapter takes an
   `onSuccess(accessToken, expiresIn, returnTo)` callback; when provided,
   `signInWithPasskey` hands the token to the host instead of doing a
   `window.location.assign` hard-nav. The host sets the token in memory
   (`api.setTokens`), calls `refreshUser()`, and SPA-navigates. This replaced
   the prior hard-nav, which could be a same-path hash change (no reload) that
   left the login spinner hanging until a manual refresh. **FarmTrack must
   adopt the same host-hydration wiring** (build the passkey adapter inside the
   Login component with `useNavigate` + `refreshUser`).
2. **Page reload:** the access token is gone (memory-only). The shared
   `AuthProvider` POSTs `/api/auth/refresh` with
   `credentials: 'same-origin'`; the cookie mints a fresh access token
   and the rotated refresh token comes back ONLY via `Set-Cookie`.
   `loading` stays `true` until this settles — hosts must not redirect
   to login while `loading` is set.
3. **Mid-session 401** (access token expired in a long-lived tab): the
   host HTTP client retries once after the same cookie-based refresh.
4. **Logout:** `POST /api/auth/logout` revokes the session row and
   clears the cookie server-side; the client drops the in-memory token
   + cached user.

Both products run the AuthProvider with `refreshMode: 'cookie-refresh'`
(the default). `'token-only'` exists only for hosts that genuinely
never receive the refresh cookie — neither Averrow surface uses it.

Migration: both SPAs perform a one-time purge of the legacy
localStorage token keys (`averrow_token`, `averrow_refresh`) at module
load. No body-token fallback exists on `/api/auth/refresh` — every
live session already carries the cookie because every session-issuing
flow has always set it. Do not add one.

### Trust contract
- The host app (averrow-ops or averrow-tenant) owns the HTTP
  client. The shared package only sees URLs that come back from
  the adapter + URL-bar tokens read from `window.location`.
- The host app owns localStorage keys (`averrow-user` /
  `averrow-tenant-user`, `averrow-theme`,
  `averrow.lastSignInMethod`). Different products MUST use
  different keys to prevent state cross-leak on shared devices.
- Backend JWT signature verification is the hard gate. Anything
  the shared package surfaces (cached user, tokens from URL
  hash) is treated as untrusted until /api/auth/me succeeds.

### Defense-in-depth boundaries

| Concern | Mitigation |
|---|---|
| URL hash callback tokens | `replaceState` immediately strips the hash. Hash is read once on mount, then the URL bar is rewritten (either to a validated `return_to` or to the bare path). |
| Malicious `return_to` from URL | `isSafeReturnTo(returnTo, prefix)` requires the prefix to be followed by `/`, `?`, `#`, or end-of-string. Defends against `/v2evil/path` style attacks where `startsWith` would naively accept. Failing values fall through to `window.location.pathname`, never echoed back. |
| Cached user shape drift / poisoning | `isValidCachedUser(value)` does runtime type checks on `id`, `email`, `name`, `role`, and the optional `organization` block. Mismatches are treated as "no cache" and the offending entry is removed from localStorage. |
| Per-product redirect mistake | `loginPath` is a REQUIRED config field (no default). Each product's wrapper must explicitly state where the OAuth start URL goes. |
| CSRF | Bearer tokens for all state-changing API calls. The cookie-bearing requests are `/api/auth/refresh` (returns a new access token, not a state mutation) and `/api/auth/logout` (Bearer-authenticated; the cookie only identifies which session row to revoke). The cookie is `SameSite=Strict; Path=/api/auth`, so it never rides cross-site requests. |
| Token theft via XSS (H5) | Refresh token is HttpOnly-cookie-only — unreachable from JS. Access token is memory-only (never localStorage), so XSS exposure is bounded by the access-token TTL within the compromised tab, not a durable refresh credential. The shared package never injects HTML, never uses `dangerouslySetInnerHTML`, never `eval`s. React's auto-escaping handles all rendered user content. CSP headers on the worker are the defense against host-app XSS. |
| Adapter trust | `httpClient`, `passkeyAdapter`, `apiClient` are all host-supplied. By contract: a compromised host wrapper compromises everything. The shared package does NOT make raw `fetch` calls except for the cookie-refresh path. |
| Logout cleanup | `clearLastSignInMethod()` runs in `onLogoutCleanup`. `clearTokens()` drops the in-memory access token (and on ops, messages the SW to clear the API cache). The backend `/api/auth/logout` revokes the refresh-token cookie + sessions row server-side. |

### Storage namespacing (host-owned)

Each product MUST use distinct localStorage keys for all
user-scoped data:

| Key | averrow-ops | averrow-tenant |
|---|---|---|
| User cache | `averrow-user` | `averrow-tenant-user` |
| Theme | `averrow-theme` (shared OK; same domain) | `averrow-theme` (shared OK) |
| Last sign-in method | `averrow.lastSignInMethod` | `averrow.lastSignInMethod` |

Theme + `lastSignInMethod` share keys intentionally — they're
device-level preferences that should survive product switches
on the same browser. User cache is per-product so a customer's
session doesn't leak into the staff shell (or vice versa).

### Security helpers (public API)

```ts
import { isSafeReturnTo, isValidCachedUser } from '@averrow/shared/auth';
```

Both are pure functions, host-callable for additional defense
where needed. Unit-tested in
`packages/averrow-ops/src/lib/auth-validators.test.ts`.

### Reporting

Security issues in the shared package are tracked on
GitHub Issues with the `security` label and routed through the
sibling-product owners (averrow-ops + future FarmTrack). Don't
file public issues for unpatched vulnerabilities; email the
on-call instead.

---

## 9. Drift checklist (run before merging into either platform)

When changing any of the files above:

- [ ] Did the change touch a "Required parity" element from §1–§5? If yes, port it to the sibling repo or update this spec.
- [ ] Are the per-product deltas still limited to the list in §1?
- [ ] Does the avatar still come from `parseInitials(displayName, email)`? Did anyone reintroduce a `pictureUrl` / `avatar_url` `<img>`?
- [ ] Does `/api/auth/me` still return all the fields in §6's `MeResponse` shape?
- [ ] Is push subscribe still on the canonical W3C-shaped payload?

If any answer is "no," fix or update this doc first.
