# Shared Login & Account Spec — Averrow ↔ FarmTrack

**Purpose:** two things, with different rules.

1. **Login, PWA install prompts, biometric prompt, token model (§1, §3-§5, §8):**
   keep these identical across Averrow and FarmTrack so users get the same
   experience on both products. Only the per-product deltas listed in §1 may
   differ.
2. **Profile / account experience (§2):** Averrow is the **canonical reference
   that other products copy**. FarmTrack structural parity for profile/account was
   dropped by owner decision (2026-10-04): "make this the gold standard profile
   and I will copy it for other platforms." Averrow leads; other products adopt
   it (§2 "How another product adopts it"), not the other way round.

If you change anything in the "Required parity" sections of §1/§3/§4/§5, update
this doc and ping the sibling platform. Changes to the account experience are
specified in `docs/ACCOUNT_DESIGN_SPEC.md`.

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
| Brand tile | 56×56. Default = gradient `var(--amber)` → `var(--amber-dim)`, `border-radius: 14`, `box-shadow: 0 0 24px var(--amber-glow)`, holding the letter monogram. When the product passes `brandMark`, that self-contained ~56×56 logo tile renders instead. |
| Brand tile letters | Fallback glyph when no `brandMark`: 2-character product abbreviation, `fontSize: 20`, `fontWeight: bold`, color `var(--text-on-amber)` |
| Brand tile mark (optional) | `branding.brandMark` — each product's own logo tile (Averrow: red-triangle `AverrowMark`; FarmTrack: its mark). Overrides the monogram. Keeps the shared component parity-identical while letting each product show its real logo. |
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

### Typography (required parity)

Login, Profile and every shared surface use ONE font pair, supplied by the
shared theme tokens (`packages/shared/src/theme/tokens.css`):

| Role | Token | Family |
|---|---|---|
| Sans / display | `--font-sans` (`--font-display` aliases it) | Plus Jakarta Sans, then system-ui fallbacks |
| Mono (taglines, labels, buttons, data) | `--font-mono` | JetBrains Mono, then ui-monospace fallbacks |

`--font-display`, `--card-radius` and `--transition-*` are aliases that resolve at `:root`: a scoped override of `--font-sans`, `--radius-lg` or `--dur-*` on a descendant will not propagate to them. Override the alias itself. Programming ligatures (`calt`) are disabled globally so IOCs (`::`, `://`, `!=`) render literally.

Each host app's `index.html` must preconnect to Google Fonts and load
`Plus Jakarta Sans` (400-800) + `JetBrains Mono` (400/500/700/800; its max weight is 800, so 900 usages render 800). Components
reference the tokens (or the Tailwind `font-sans` / `font-mono` classes mapped
to them), never a literal family. **FarmTrack must adopt this pair (and the
same tokens) to stay identical to Averrow** — this replaces the previous
`IBM Plex Mono` / system-ui defaults.

### Per-product deltas (allowed)

- **Brand tile letters:** Averrow uses `AV`, FarmTrack uses `FT`. Used only as
  the fallback glyph when `brandMark` is not supplied.
- **Brand tile mark:** each product MAY pass `branding.brandMark` — its own
  ~56×56 logo tile — to render the real logo instead of the letter monogram.
  Averrow passes `<AverrowMark />` (the red-triangle logo, same mark as the
  in-app Sidebar + email lockup). FarmTrack passes its own mark, or omits it to
  keep the `FT` monogram. The mark is the ONLY brand-identity image allowed on
  the login; everything else stays structurally identical.
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

### Optional host props (added 2026-10 — FarmTrack vendoring gaps)

All optional. With them omitted, styles, text, element order and behaviour
are unchanged; the ONLY markup differences from before are: the stable
`data-testid`s below, `role="alert"` on error text, `tabIndex={-1}` +
`outline: none` on the page-level error, and `aria-invalid` /
`aria-describedby` on the email input while a magic-link error is showing.
They are host capabilities, not visual deltas, and do not widen §1's
per-product deltas.

| Prop | Effect |
|---|---|
| `onGoogleSignIn?: () => Promise<void>` | Replaces the `oauthLoginPath` redirect (native shells that can't use web OAuth). While pending the Google button is `disabled`, `aria-busy`, labelled "Signing in…". A rejection shows in the page error area and re-enables the button; a second click while pending is ignored. On success the button stays busy — **the host must navigate** (like passkey). |
| `googleErrorCopy?: (err: unknown) => string` | Maps a thrown error to text. Default: `Error.message`, else "Google sign-in failed. Try again." If it throws, the generic text is used. Always rendered as plain text, never HTML. |
| `footerLinks?: ReactNode` | Slot inside the card, under the footer pillars (e.g. Privacy / Delete account for Google Play). |
| `magicLinkSentCopy?: (email) => ReactNode` | Replaces the body of the "link sent" confirmation (not the "Use a different email" control). Invite-only products use it to avoid confirming an address exists. |

**Stable test ids** (fixed, not a prop): `login-page`, `login-google`,
`login-passkey`, `login-email`, `login-magic-link-submit`,
`login-magic-link-sent`, `login-magic-link-error`, `login-passkey-error`,
`login-error` (page-level error).

**Error accessibility:** every error element is `role="alert"`; the
magic-link error is linked to the email input via `aria-describedby`
(`useId`) + `aria-invalid`. The page-level error stays at the bottom of the
card (moving it above the form would change Averrow's layout). A `?error=`
from the URL is announced but NOT focused (unchanged behaviour); a NEW Google
error appearing after mount takes focus (`tabIndex={-1}`), which scrolls it
into view on phones. A Google error also forces the full method menu (like
`?error=`) and clears when the user starts passkey or magic-link sign-in.
`?error=` codes resolve only via own string properties of `errorCopy`
(`__proto__` / `constructor` fall through); an unknown code is echoed as
"Sign-in error: <code>" only if it matches `^[a-z0-9_]{1,40}$`, otherwise
"Sign-in failed. Try again." (no attacker-supplied sentences on the page).

### Brand-locked theme (added 2026-06, login audit F2)

The login is a **brand surface** and renders in the **dark brand theme
regardless of the OS / stored preference** (which only governs the look
*inside* the app). `<LoginPage>` sets `data-theme="dark"` on mount and
restores the prior value on unmount. Rationale: without it, a light-OS
device gets a white, off-brand login card — the only light surface in an
otherwise dark, dark-first product. **FarmTrack must mirror this.**

---

## 2. Account & profile experience (Averrow-canonical)

**Owner decision 2026-10-04:** Averrow's account experience is the gold-standard
reference other products copy. It is specified in
`docs/ACCOUNT_DESIGN_SPEC.md` (layout, copy, typography, touch floors) and built
from two shared pieces:

- the **kit** — `@averrow/shared/ui` (`packages/shared/src/ui/{forms,overlays,settings}/`);
  see `AVERROW_UI_STANDARD.md` "Account & Settings".
- the **pages** — `@averrow/shared/account` (`packages/shared/src/account/`).

The pages take data and callbacks only (no router, no api module), so each
product mounts them with its own adapters. Edit the shared pages, NOT the
per-product mounts.

```
packages/shared/src/account/
  ProfileSettings.tsx     — name, appearance (Auto/Dark/Light), time zone
  SecuritySettings.tsx    — passkeys + active sessions (security/ has the adapter + UA/session helpers)
  notifications/          — NotificationSettings: Channels | Events | Digest | Quiet hours tabs
  DevicesSettings.tsx     — install the app, push devices, version, clear cache
  SignOutRow.tsx          — mobile sign-out row
  sections.tsx            — getAccountSections / accountSectionIdFromPath (rail + list + menu stay in sync)
  summaries.ts            — securitySummary / notificationsSummary / devicesSummary (live list descriptions)
  index.ts                — public exports
```

The older `packages/shared/src/profile/` (`ProfilePage`) was deleted on
2026-10-05; its API-client type now lives in `account/api-types.ts`
(`AccountApiClient`).

### Where it is mounted

| | averrow-ops (staff) | averrow-tenant (customer) |
|---|---|---|
| Base path | `/settings/*` (`features/settings/SettingsLayout.tsx`) | `/tenant/account/*` (`features/account/AccountLayout.tsx`; `ACCOUNT_BASE_PATH`) |
| Sections | Profile, Security, Notifications (`/channels \| /events \| /digest \| /quiet-hours`), Devices & App | Profile, Security, Notifications. **No Devices & App** (needs a service worker; tenant ships none) |
| Route table | `App.tsx` | `features/account/routes.tsx` |
| Legacy redirects | `/profile` → `/settings/profile`; `/notifications/preferences` → `/settings/notifications/channels` | `/profile` → `/account/profile` |

Desktop is a sticky rail + pane; below 1024px `/settings` (`/account`) is a
grouped list that drills into each section. Both layouts come from
`<SettingsShell>`. The avatar menu, bell and inbox are ops-only chrome and are
not part of the portable account kit.

### Rules that carry over to any product

- **Initials-only avatars** (§3) — `AccountHero` never renders a photo.
- Autosave on change for toggles/selects (with an undo/failure toast); explicit
  Save only for multi-field forms (display name, quiet hours).
- Destructive actions go through `ConfirmDialog` and say what will happen.
- Sans for prose, mono only for data; 13px prose / 12px mono / 11px badge floors;
  44px touch targets; 16px input text on mobile (ACCOUNT_DESIGN_SPEC §6).
- Quiet hours live on notification preferences **v2** only; per-event toggles
  stay on the v1 endpoint (partial update). See `docs/API_REFERENCE.md`.

### How another product adopts it

1. **Dependencies and theme.** Depend on `@averrow/shared`; import
   `@averrow/shared/theme.css` (the kit reads CSS custom properties only —
   supply the same token file, including the account tokens listed in
   `AVERROW_UI_STANDARD.md`) and make sure the host's Tailwind content globs
   include `packages/shared/src/**` (`docs/LOGIN_AUDIT_2026-06.md` F1 — otherwise shared-only classes are purged).
2. **Mount the shell.** Wrap the routes in a layout that renders
   `<SettingsShell sections={getAccountSections({ basePath, descriptions, badges })} activeId={accountSectionIdFromPath(pathname, basePath)} basePath={basePath} …>`
   inside a `<ToastProvider>`, with `<AccountHero compact>` in the shell's `home` slot (mobile list; the desktop hero is rendered by `ProfileSettings` itself) and a sign-out `railFooter` / `homeFooter` (`SignOutRow`). `basePath`
   is yours (`/settings` default; tenant uses `/account`). Pass a `renderLink` (or `onNavigate`) adapter if your router needs its own link component; the default is a plain anchor.
3. **Mount each page with adapters.** Pages receive data + callbacks:
   - `ProfileSettings` — `user`, `apiClient` (`patch` → `PATCH /api/profile`), `theme` /
     `onThemeChange` (your `useTheme()`), `onUserUpdated` (refresh the session
     user), `onSignOut`.
   - `SecuritySettings` — `api` (`get`/`post`/`delete`), `passkeys` from
     `createStrictPasskeyAdapter({ api, isSupported, register })`,
     `requiresPasskey` (true only where a passkey is mandatory, e.g. staff admins),
     `onPasskeysChanged`, `onSignedOut`. Needs the caller-scoped
     `/api/auth/sessions*` endpoints.
   - `NotificationSettings` — `tab`/`onTabChange` (route segment), prefs, events,
     subscriptions, push state and the `onUpdate*` / push callbacks; backed by
     `/api/notifications/preferences` (events, partial PATCH) and
     `/api/notifications/preferences/v2` (channels, digest, quiet hours).
   - `DevicesSettings` — `install` state (`useInstallPrompt`), a `push` adapter
     (list/remove/send test), `version`, `onClearCache`.
4. **Optional sections.** Drop a section by not mounting its route and filtering
   it out of `sections`. Devices & App requires a service worker + web-push
   backend: omit it (as tenant does) until the product ships one. Notifications
   needs only the preferences endpoints; push controls degrade when
   `push.supported` is false.
5. **Backend contract.** The pages need `/api/profile`, `/api/auth/sessions*`
   (own sessions only), `/api/passkeys*`, `/api/notifications/preferences` +
   `/v2`, and the `sid` claim / `forced_logout` KV semantics so revoking a
   session also stops its live access tokens (see "Session revocation" in
   `docs/API_REFERENCE.md`).
6. **Redirect legacy routes** to the new section URLs, as the table above does.

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

- **`<InstallAppBanner />`** — always-visible CTA on the Home page (Averrow ops: Overview, `features/home/OverviewV4.tsx`, directly below the hero).
  - Hidden when `isStandalone()`.
  - Dismissible per-device via `localStorage` key `<product>.install.dismissed`.
  - Android Chrome / Edge: captured `beforeinstallprompt` → native install button.
  - iOS Safari: four-step Share → Add to Home Screen instructions inline.

- **Install card (Settings → Devices & App)** — the always-visible install affordance now lives in the shared `DevicesSettings` page (`packages/shared/src/account/DevicesSettings.tsx`, mounted by ops at `/settings/devices`), fed by `useInstallPrompt` and `IOS_INSTALL_STEPS` (`components/InstallSteps.tsx`). It replaced `<InstallAppCard />` on Profile (2026-10-04); that component was deleted on 2026-10-05.
  - Hidden/replaced by "installed" state when `isStandalone()`.
  - **Not dismissible** — always reachable from Settings.
  - Includes a manual-steps list for desktop browsers that didn't fire `beforeinstallprompt`.
  - Tenant has no Devices & App (no service worker).

### Required parity

| Element | Spec |
|---|---|
| iOS step icons | 24×24 amber circles with white number, `box-shadow: 0 0 10px rgba(229,168,50,0.45)` |
| iOS step text | 13px, `lineHeight: 1.5`, color `var(--text-secondary)` |
| Manual-steps fallback | `Chrome or Edge on a computer`, `Chrome on Android`, `Firefox on Android` (+ iOS Share steps) — `DevicesSettings` |
| LocalStorage dismiss key | `<product>.install.dismissed` (e.g. `averrow.install.dismissed`) |

---

## 5. Biometric (passkey) auto-prompt

### `<FirstSignInPasskeyPrompt />`

Mounted at the Shell layout root (Averrow ops: `components/layout/ShellV4.tsx`). Self-gates internally on:
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
| Footer note | "You can add or remove passkeys anytime in Settings → Security." (`FirstSignInPasskeyPrompt.tsx`) |
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

The account/profile pages are NOT in this table — they are Averrow-canonical (§2) and
live in `@averrow/shared/account`. For the login/PWA/biometric surfaces below, when
making changes to either platform, the following files should be
diffed against the sibling repo and kept structurally identical:

| File | Notes |
|---|---|
| `pages/Login.tsx` (or `src/app/pages/Login.tsx`) | Brand tile letters + tagline + footer pillars are the only allowed deltas |
| `components/InstallAppBanner.tsx` | Verbatim, swap product name + dismiss key |
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

- [ ] Did the change touch a "Required parity" element from §1 or §3–§5? (§2 account pages are Averrow-canonical: update `docs/ACCOUNT_DESIGN_SPEC.md` instead.) If yes, port it to the sibling repo or update this spec.
- [ ] Are the per-product deltas still limited to the list in §1?
- [ ] Does the avatar still come from `parseInitials(displayName, email)`? Did anyone reintroduce a `pictureUrl` / `avatar_url` `<img>`?
- [ ] Does `/api/auth/me` still return all the fields in §6's `MeResponse` shape?
- [ ] Is push subscribe still on the canonical W3C-shaped payload?

If any answer is "no," fix or update this doc first.
