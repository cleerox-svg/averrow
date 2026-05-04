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

- Reordering or removing auth options. Passkey-Google-magic is the canonical sequence.
- Replacing the magic-link helper copy.
- Showing the Google profile picture anywhere. Initials only — see §3.
- Adding extra auth options without updating this spec.

---

## 2. Profile page

### Section order (must match top to bottom)

1. **Identity** — avatar (initials only) + display_name + email + role badge.
2. **Account** — display_name editor with "Save" + helper text "Shown instead of your Google name. Leave blank to use Google." + read-only email field.
3. **Preferences** — theme toggle (Dark / Light) + timezone select.
4. **Install** — `<InstallAppCard />`. Hidden when `isStandalone()`.
5. **Passkeys** — `<PasskeysCard />`. Per-device list with `BIOMETRIC` badge when `transports` includes `"internal"`.
6. **Notifications** — single-row card linking to `/notifications/preferences`.
7. **Security** — active sessions count + "Revoke other sessions" button + per-session list (top 5).

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

`packages/averrow-ui/src/lib/avatar.ts` is the source of truth. Both
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

## 8. Drift checklist (run before merging into either platform)

When changing any of the files above:

- [ ] Did the change touch a "Required parity" element from §1–§5? If yes, port it to the sibling repo or update this spec.
- [ ] Are the per-product deltas still limited to the list in §1?
- [ ] Does the avatar still come from `parseInitials(displayName, email)`? Did anyone reintroduce a `pictureUrl` / `avatar_url` `<img>`?
- [ ] Does `/api/auth/me` still return all the fields in §6's `MeResponse` shape?
- [ ] Is push subscribe still on the canonical W3C-shaped payload?

If any answer is "no," fix or update this doc first.
