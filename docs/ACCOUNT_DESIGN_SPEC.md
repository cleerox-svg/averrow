<!-- Approved by the owner 2026-10-04 (design direction v1, Phase P1-1). Approved choices: Badge md text 10→11px; Tabs size="md" (13px); native <select> everywhere except the searchable TimezoneSelect (no react-select); new --violet / --violet-text tokens for Devices & App. Rendered review page: https://claude.ai/artifact/Tw9ZkgN2dWZivn5HytRyCj -->

# Averrow Account Experience — Design Spec (P1-1)

Scope: `packages/shared` (ui primitives + `AccountShell`), mounted in ops at `/settings/*`.
Grounded in: `shared/src/ui/{Card,Tabs,PageHeader,StatTile,Button,Badge,PageState}.tsx`,
`shared/src/theme/tokens.css`, `ops/components/layout/shell-v4.css`, `AVERROW_UI_STANDARD.md`.
Current-state sins this fixes: `shared/src/profile/primitives.tsx` re-implements Card (flat
`var(--bg-card)`, no gradient/rim/blur), Button, Input; labels are 10-11px mono uppercase;
`ProfilePage` is one 720px scroll of cards.

All values below are tokens from `tokens.css` unless marked NEW.

---

## 1. Principles

1. **Calm glass, loud only for risk.** Surfaces are the v4 `Card` (gradient + rim + blur). Amber is
   reserved for the primary action and the single active item. Red appears only in danger/failed states.
   No glow on neutral rows (Depth Rule 5).
2. **Say it in a sentence.** Every control has a human title and a one-line plain-language
   description in sans 13px. Mono is for data (times, IDs, counts), never prose.
3. **Instant, reversible, honest.** Toggles/selects save on change (optimistic, with undo toast).
   Only multi-field forms (Profile name, quiet hours) have an explicit Save. Destructive = ConfirmDialog
   that names the consequence. Failure always reverts the control and says why.
4. **One layout, two shapes.** Same routes and components; desktop = rail + pane, mobile = grouped list
   -> detail. Nothing is desktop-only; nothing is hidden behind hover.
5. **Portable.** Primitives take data/callbacks only, read CSS vars only, no router/api imports —
   so FarmTrack and tenant can mount the same kit with a different token file.

---

## 2. Settings shell (`AccountShell`)

### Routes (deep links, all real URLs, back-button safe)
```
/settings                       desktop: redirect -> /settings/profile ; mobile: settings home list
/settings/profile
/settings/security
/settings/notifications                 -> redirect to /settings/notifications/channels
/settings/notifications/channels | events | digest | quiet-hours
/settings/devices
/settings/access                        staff only (Users & Access), NOT in the account menu; reached from sidebar admin group
```
Legacy `/profile`, `/notifications/preferences`, `/organization` -> 301-style `<Navigate replace>`.
Sub-tabs are routes (not state) so "Quiet hours" is shareable and the menu can deep-link to it.

### Desktop (>= 1024px)
- Page: `max-width: 1040px`, centered, gutter 24px (matches `.v4-page--padded`). `PageHeader` title "Settings",
  subtitle "Your profile, security and notifications."
- Layout: CSS grid `grid-template-columns: 232px minmax(0, 1fr)`, `gap: 32px`.
- **Rail** (`position: sticky; top: 72px`, no card chrome — it must feel like sidebar not a panel):
  - Group label `SectionLabel`-style: sans 11px/600, `letter-spacing .08em`, uppercase, `--text-muted`...
    **use `--text-tertiary`** (muted fails AA). Groups: `ACCOUNT` (Profile, Security), `PREFERENCES`
    (Notifications, Devices & App). Group gap 20px, item gap 2px.
  - Item: height 40px, padding `0 12px`, radius 10px, 14px/500 `--text-secondary`, 18px icon (stroke 1.75) in a
    **28px rounded-8 tinted tile** (same tile as SettingsRow, 16px glyph) — ties rail to mobile list visually.
  - Hover: `background: var(--border-base)` @ 50%.
  - **Active**: reuse the shell nav treatment exactly — `background: linear-gradient(135deg,
    var(--nav-active-fill-v4-1), var(--nav-active-fill-v4-2))`, `box-shadow: inset 0 0 0 1px var(--nav-active-border),
    0 0 12px var(--nav-active-glow-v4)`, text `--text-primary` 600, plus the 3px amber left bar (`::before`,
    same as `.v4-item.active::before`). `aria-current="page"`.
  - Badges in rail: Notifications shows a `Badge size=xs` count only if inbox unread > 0 (no other badges).
  - Rail footer (above version line): ghost button "Sign out" (danger text on hover). Version line
    `vX.Y.Z · sha` mono 11px `--text-muted` stays in the sidebar, not duplicated.
- **Pane**: stack of `SettingsGroup`s, gap 24px. Sub-tabs (Notifications only) use the existing `Tabs
  variant="underline"` at the top of the pane, `activation="auto"`, with `aria-label="Notification settings"`.
  Raise the underline tab font to 13px for this surface (prop `size="md"`; current 11px is too small).

### Mobile (< 1024px) — iOS-Settings-like list -> detail
- `/settings` renders **Settings home**: identity hero (see §3, compact) then grouped list (§5.0).
  Page bg `--bg-page`; groups are `Card variant=base padding=none` inset 16px from edges, radius 16.
- Tapping a row `navigate('/settings/security')` -> **detail screen**: sticky top bar (56px + safe-area-top,
  `backdrop-filter: blur(20px)`, bottom border `--border-base`) with left `‹ Settings` back (44x44 hit area, chevron 20px
  + label 15px `--amber-text`), centered title 17px/700 (fades in after 24px scroll; large 28px/800 title sits
  in content at top like iOS), no right action unless page has Save.
- Content gutters 16px; bottom padding `calc(96px + env(safe-area-inset-bottom))` (clears the mobile nav).
- **Transition** (route-driven, CSS only): entering detail = new screen translates `100% -> 0` over
  `--dur-slow` (300ms) `--ease-emphasized`, list translates `0 -> -24%` and dims to 0.6 opacity; back reverses
  in `--dur-base`. Implement with `View Transition API` where available (`document.startViewTransition`),
  fallback to a 180ms opacity+8px translateY. **`prefers-reduced-motion`: cross-fade 120ms only.**
- Swipe-from-left-edge back is browser-native on iOS; do not hijack it. Android back works via router history.
- Notifications sub-tabs on mobile become a `SegmentedControl` (4 segments is too wide at 390; use horizontally
  scrollable `Tabs underline` with 44px height instead). Decision: **scrollable underline tabs**, edge-fade masks
  already supported by `Tabs`.
- At >= 1024 the mobile list route `/settings` is never shown (redirect), so desktop never sees a blank home.

---

## 3. Identity hero (`AccountHero`)

- Container: `Card variant="active" accent="var(--amber)" padding="lg"` — the only glowing card on the page.
  Glow is tied to meaning: "this is you / signed in". Not shown on sub-pages (only Profile page + settings home).
  Light mode inherits `--card-accent-*-pct` boosts automatically.
- Layout desktop: row, gap 20px, avatar left, text center, actions right. Mobile: avatar + text row,
  actions wrap below as 2 equal 44px buttons.
- **Avatar**: initials only, `parseInitials(name, email)`, color `SELF_AVATAR_COLOR` (`var(--amber)`). Never `avatar_url`.
  Size 72 desktop / 64 mobile, radius 22 (superellipse-ish, ~30%), the "DimensionalAvatar" recipe from the Standard
  (gradient `145deg, color -> color-mix(color 50%, black)`, 1px `color-mix(color 44%, transparent)` border, inset top rim
  `rgba(255,255,255,.28)`, bottom rim `rgba(0,0,0,.45)`, outer glow `0 0 32px color-mix(color 21%, transparent)`),
  initials 800 weight, 28px / 24px, `#0A0F1E` text (dark on amber is 8:1; white on amber is 2:1 — fails). Extend
  shared `Avatar` with `shape="squircle"`, `size` up to 72, `tone="self"`. No camera/edit affordance (no upload feature).
- Text block: name 22px/800 `--text-primary` letter-spacing -0.3px (28px on desktop >= 1280); below, email
  14px `--text-secondary` (truncate, `title` attr for full); below, chips row (gap 6): role `Badge` (map role ->
  tone: super_admin amber, admin amber, analyst blue, sales/support/billing neutral, auditor neutral + "Read-only"),
  then `Badge status` "Passkey on" (green) or "No passkey" (amber).
- **Scope line** (13px `--text-tertiary`, one line, icon 14px): staff -> "Averrow staff · Full platform access" (auditor:
  "Read-only access to all data"); tenant -> "{Org name} · {Org role}". Replaces "legacy org" jargon.
- Quick actions (right on desktop): `Button variant=secondary size=md` "Copy email" no; decision — keep to two that matter:
  **"Edit profile"** (anchor to Profile form / opens detail on mobile) and **"Sign out"** (`variant=ghost`).
  Theme switch is NOT a quick action (lives in Profile > Appearance).
- Hero skeleton: avatar circle + two shimmer bars at final dimensions (no layout shift).

---

## 4. Primitives (shared kit, `packages/shared/src/ui/settings/`)

Radix: `@radix-ui/react-switch`, `react-dropdown-menu`, `react-dialog`, `react-radio-group` (+ already `react-slot`).
Add `react-select`? **No** — use native `<select>` styled (best mobile UX: OS picker, 16px zoom-safe). Exception:
TimezoneSelect (searchable) is a Dialog/Popover combobox.
All primitives: inline-free, `cva` + Tailwind arbitrary values like `Button`; focus ring =
`focus-visible:ring-2 ring-[var(--amber)] ring-offset-2 ring-offset-[var(--bg-page)]` (shared convention).

### 4.0 Section tint tokens (NEW, add to `tokens.css`)
Tile = 32px (36 on mobile) square, radius 9px, bg `color-mix(in srgb, TINT 16%, transparent)`, 1px border
`color-mix(in srgb, TINT 30%, transparent)`, inset top rim `rgba(255,255,255,.10)`, glyph 18px stroke 1.75 in TINT-text.
```
Profile        TINT var(--amber)   glyph var(--amber-text)
Security       TINT var(--green)   glyph var(--sev-info-text)
Notifications  TINT var(--blue)    glyph var(--sev-low-text)
Devices & App  TINT var(--violet)  glyph var(--violet-text)     NEW: --violet:#8B7CF6; --violet-text:#C4B5FD (light: #6d28d9, = existing --nexus-text)
Danger         TINT var(--red)     glyph var(--sev-critical-text)
Neutral        TINT var(--text-secondary) (generic rows)
```
Light mode: tile bg % raised 16 -> 20, glyph uses the `-text` var (already AA-darkened). Accent hexes constant.

### 4.1 SettingsGroup
- `<section aria-labelledby>`: optional header above card: title 12px/600 uppercase `.06em` `--text-tertiary` (sans, NOT mono),
  padding `0 4px 8px`; optional footer under card: 13px `--text-tertiary` (help paragraph), padding `8px 4px 0`.
- Body: `Card variant="base" padding="none"`; rows separated by 1px `--border-base` hairline inset-left 60px (aligns after tile)
  — implemented as `::after` on each row except last.
- Variant `danger`: `Card variant="critical"` for DangerZone only (§4.12).
- Rows on mobile never exceed card edges; group margin-bottom 24px (28 desktop).

### 4.2 SettingsRow
Grid: `[tile 32] [text 1fr] [trailing auto]`, gap 12px, padding `12px 16px` (desktop) / `14px 16px` (mobile), **min-height 56px (desktop) / 60px (mobile)**.
- Title: 15px/600 `--text-primary`, line-height 1.3 (14px/600 if row is dense table-like, e.g. device list).
- Description: 13px/400 `--text-secondary`, lh 1.45, max 2 lines on mobile (`line-clamp-2`), max-width 56ch. Never mono. Never < 13px.
- Meta (optional, under description): 12px mono `--text-tertiary` (timestamps, IPs only).
- Trailing slot (`trailing`): Switch, value text + chevron, Select, Badge, or Button. Trailing text value 14px `--text-secondary`.
- **Layout rule**: if trailing is a Select/SegmentedControl wider than 40% of row on mobile (< 480px), it drops
  **below** the text (stacked), full-width, 44px. Switch/chevron/Badge always stay inline.
- Variants: `static` (div), `button`/`link` (whole row is the hit target, chevron 16px `--text-tertiary` appended; hover bg
  `color-mix(var(--text-primary) 4%, transparent)`, active bg 8%, `:focus-visible` inset ring), `toggle` (whole row is a `<label>` that toggles its Switch — big hit area).
- **Disabled**: opacity .5 on tile+text (not on description alone), `cursor: not-allowed`, description replaced by reason
  ("Turn on Push to use this" — always say why). `aria-disabled`.
- **Loading** (row-level save in flight): trailing control shows 16px spinner replacing chevron/knob-adjacent; control stays
  visible & disabled-looking at .7; row text unchanged (no skeleton flicker). Initial load: row-shaped skeleton
  (tile square + two bars) at final height.
- Error: description turns `--sev-critical-text` with the message, 13px, `role="alert"` once.

### 4.3 Switch (Radix)
- Track 52x32 (mobile) / 44x26 (desktop >= 1024), radius pill. Hit target extends to 44px high via `::before` inset -6px,
  and the whole `SettingsRow variant=toggle` is the real target.
- Off: track `color-mix(var(--text-primary) 14%, transparent)`, 1px `--border-strong`; knob white-ish `#fff` 24/20px with
  `0 1px 3px rgba(0,0,0,.4)`. On: track `linear-gradient(135deg, var(--amber), var(--amber-dim))`, knob `#fff`; subtle
  `0 0 12px var(--amber-glow)` (the one allowed glow — it is "active state").
- Contrast: off-track vs card >= 3:1 via border (`--border-strong` raised in light mode already). State is also conveyed
  by knob position (not color alone). Motion: knob `translateX` `--dur-base` `--ease-standard`; reduced-motion: no transition.
- Rules: label via row (`aria-labelledby` title, `aria-describedby` description). Keyboard Space.

### 4.4 SegmentedControl (Radix RadioGroup; theme Auto / Dark / Light)
- Container: height 40 (44 on mobile), padding 3, radius 12, bg `var(--bg-card-deep)`, 1px `--border-base`. Segments equal width, `min-width: 72px`.
- Segment: 13px/600 `--text-secondary`, icon 16px left (Auto=monitor, Dark=moon, Light=sun), radius 9.
  Selected: bg `linear-gradient(135deg, var(--pill-active-fill-1), var(--pill-active-fill-2))`, 1px `--pill-active-border`,
  inset `0 1px 0 var(--pill-active-rim)`, text `--amber-text` (same recipe as Tabs pills — no new look).
- Roving arrow keys (RadioGroup native). `aria-label` on group. Theme change applies instantly with a 200ms color transition
  on `body` only (not per-element) unless reduced-motion.
- Also used for: digest frequency (Off / Hourly / Daily / Weekly: 4 segments, stacks under title on mobile).

### 4.5 Field / Label / HelpText / Input
- `Field`: label 13px/600 `--text-primary` (sans, sentence case, NOT mono uppercase), `mb 6px`; control; help 13px `--text-tertiary` mt 6px; error 13px `--sev-critical-text` with 14px alert icon (never color alone).
- Input: height 44 (all breakpoints; 40 allowed only in dense desktop tables), padding `0 14px`, radius 10, bg `--bg-input`, 1px `--border-base`,
  text **16px on < 768 / 15px >= 768** (16 prevents iOS zoom), placeholder `--text-muted`... use `--text-tertiary`.
  Focus: border `--amber`, ring `0 0 0 3px var(--amber-glow)`. Error: border `--sev-critical-border`. Read-only (email): bg transparent, dashed border... decision: **bg `--bg-card-deep`, text `--text-secondary`, trailing lock icon, help "Managed by your Google account."**
- Form layout: single column <= 640px content width; two-column grid (gap 16) for short pairs (Start/End).

### 4.6 Select
- Native `<select>` with custom chevron, same metrics as Input (44 high, 16px on mobile). Options text plain, no "Medium and above" mush: see copy §8.
- Inline variant (in a row trailing slot): auto width, `min-width 148`, height 40 desktop, 44 mobile, right-aligned value, bg `--bg-card-deep`.

### 4.7 TimeInput
- Native `<input type="time">` wrapped: Input metrics, 16px, `font-variant-numeric: tabular-nums`, mono NOT used. Paired as "From [22:00] to [07:00]".
  Show derived summary under: "Quiet for 9 hours overnight" (13px tertiary). Minute step 15.

### 4.8 TimezoneSelect (searchable)
- Trigger looks like Select ("Toronto (EST, UTC-5)" with current offset, 16px). Opens `Dialog` as bottom Sheet on mobile / 360px popover on desktop.
- Content: sticky search Input (autofocus on desktop, NOT on mobile to avoid keyboard jump... decision: autofocus both; sheet is full-height 85dvh so keyboard fits), "Detected: {Intl tz}" pinned first row with a "Use this" check, then list grouped by region, row 48px, selected = amber check + `aria-selected`. Listbox/combobox ARIA; typeahead. Empty search: PageState `empty compact` "No timezone matches '{q}'".

### 4.9 DangerZone
- `SettingsGroup variant=danger` titled "Danger zone"? Decision: title "Sign out & reset" for Security (not scary-by-default). Card `critical` variant (red wash, light mode pale red from `--card-critical-bg`).
  Rows: "Sign out everywhere" (Button `outline` w/ red text `--sev-critical-text`, border `--sev-critical-border`), always opens ConfirmDialog. Primary red gradient `Button variant=danger` appears ONLY inside the dialog confirm.
  No glow beyond the Card critical variant's own.

### 4.10 ConfirmDialog (Radix Dialog)
- Desktop: centered, width 440, `Card variant="elevated" padding="lg"`, overlay `rgba(4,7,14,.62)` + 4px blur (light: `rgba(15,20,35,.35)`), z `--z-modal`.
  Mobile: bottom sheet (see 4.14), buttons full-width stacked, destructive on top, Cancel below (44px, gap 8).
- Anatomy: 40px tinted tile (danger/amber), title 18px/700 (a question: "Sign out of all devices?"), body 14px `--text-secondary` stating the consequence in one sentence + what will NOT happen ("You'll stay signed in here."), optional typed-confirm never (overkill), buttons right-aligned: `Cancel` secondary, action (`danger` | `primary`). Focus lands on Cancel for destructive; Esc/overlay click cancels; confirm shows spinner + disabled; stays open on error with inline message.
- Enter/exit: 180ms scale .98->1 + fade; sheet 300ms translateY(100%->0). Reduced motion: fade 100ms.

### 4.11 Toast
- Reuse ops `Toast` behavior, move to shared. Position: bottom-center on mobile (above mobile nav: `bottom: calc(76px + env(safe-area-inset-bottom))`), bottom-right 24px on desktop. Max 1 visible + queue, width `min(420px, 100vw - 32px)`.
- Look: `Card elevated`, padding `12px 14px`, 14px text, leading 18px icon (green check / red alert / blue info), optional trailing action text button ("Undo" 14px/700 `--amber-text`, 44px hit). Duration: success 3.5s, error 6s (stays on hover/focus), with action 6s. `role="status"` (success/info), `role="alert"` (error). Pause timer on hover/focus. Motion: slide-up 12px + fade `--dur-base`.
- Save feedback rule: toggles toast only on failure or when Undo is meaningful; otherwise a 1.5s inline "Saved" check beside the control (no toast spam).

### 4.12 Menu (Radix DropdownMenu) — see §5.5 for content
- Panel: `Card variant="elevated" padding="none"`, width 296 (min(296, 100vw-24)), radius 16, `box-shadow` per variant, `align="end"` `sideOffset=8`, z `--z-dropdown`.
- Item: height 44, padding `0 12px`, radius 10 (inset 6px from panel), 14px/500, icon 18 in neutral 28px tile; `data-highlighted` bg 6% text-primary; destructive item text `--sev-critical-text`.
- Separators 1px `--border-base` with 6px vertical margin. Keyboard: arrows/typeahead/Esc via Radix. Enter 140ms scale .96->1 + fade, origin top-right.
- Trigger: the avatar button 36px (44px hit area via padding), `aria-label="Account menu for {name}"`, `aria-haspopup`.

### 4.13 (see 4.10 mobile) Sheet (Radix Dialog variant)
- Bottom sheet on < 768: radius `24px 24px 0 0`, `Card elevated`, max-height 85dvh, grab handle 36x4 `--border-strong` centered 8px from top, safe-area bottom padding, overlay as ConfirmDialog, drag-to-dismiss on handle (threshold 80px/velocity) + tap overlay + Esc. Used for: avatar menu on mobile, TimezoneSelect, ConfirmDialog, account chooser.
- Focus trapped, `aria-modal`, scroll-lock body. Motion 300ms `--ease-emphasized`.

### 4.14 Other small pieces
- `Badge` for every status (never ad-hoc pills). Min badge size on this surface = `md` (10px is current floor; raise `md` text to 11px in Badge or use label sizes >= 11).
- `InlineBanner` (info/warn/error, 14px text, tinted using `--sev-*-bg/border`) for "Push blocked in this browser".
- `CopyField` for read-only IDs: mono 13px, 44px row, copy button 44x44.

---

## 5. Pages

### 5.0 Settings home (mobile list) / rail items
```
[Identity hero compact]
 ACCOUNT
 [amber tile] Profile          Name, language, appearance   >
 [green tile] Security         Passkeys and sessions        >
 PREFERENCES
 [blue  tile] Notifications    Push and email alerts   2 new?  >
 [violet tile] Devices & App   Install, push devices        >
 (staff only, GROUP "ADMIN")  [neutral] Users & Access      >   <- also in sidebar; row optional
 [ Sign out ]  (full-width Card row, red text, centered)
 vX.Y.Z · sha  (mono 12px muted, centered)
```
Row descriptions are live summaries where cheap: Security "Passkey on · 3 sessions", Notifications "Push on · High and above", Devices "2 devices · App installed".

### 5.1 Profile (`/settings/profile`)
Order:
1. `AccountHero` (§3) — desktop only at top of pane; on mobile it is on Settings home, detail starts with group 2.
2. Group **Personal info**: Field "Display name" (editable, maxLength 60), Field "Email" (read-only + lock + "Managed by Google"),
   Save row: `Button primary` "Save changes" appears right-aligned/ full-width mobile only when dirty (`disabled` otherwise hidden: decision — **visible but disabled when clean**, avoids layout jump), "Discard" ghost when dirty. Enter submits. Unsaved-changes guard on navigate (ConfirmDialog "Discard changes?").
3. Group **Appearance**: Row "Theme" -> SegmentedControl Auto/Dark/Light (stacked below title on mobile); Row "Language" Select (only if >1 supported; else omit); Row "Time zone" -> TimezoneSelect trailing value, links to same tz used by quiet hours (single source).
4. Group **Account** (read-only facts): "Role" (Badge), "Access" (scope line), "Member since" (mono date), "User ID" CopyField (staff only; helpful for support).
5. Group **Sign out** (single row, danger text) — mobile only (desktop has rail footer + hero action).
Empty/err: hero skeleton; load error -> `PageState kind=error layout=card onRetry`.

### 5.2 Security (`/settings/security`)
1. **Status card** (`Card active accent=var(--green)` when passkey present, `variant=base` + amber banner otherwise): shield tile 40, title "Your account is protected" / "Add a passkey to secure your account", 14px description, summary chips: "N passkeys", "N active sessions", "Signed in with Google".
2. Group **Passkeys**: header action `Button secondary sm` "+ Add passkey" (44px on mobile, full-width in group footer). Each passkey `SettingsRow`: tile (key glyph), title = label ("MacBook Touch ID"), description "Added Mar 3 · Last used 2 days ago" (13px, relative time with title=absolute), trailing: overflow icon button (44) -> Menu: Rename, Remove (destructive -> ConfirmDialog "Remove this passkey?"; if it's the last passkey and no other sign-in method, dialog warns). Empty: inline `PageState kind=empty compact` "No passkeys yet — Sign in with Face ID, Touch ID or a security key" + Add button. Unsupported browser: InlineBanner info, disables Add with reason.
3. Group **Active sessions**: row per session: tile (laptop/phone glyph by UA class), title "Chrome on macOS" + **`Badge status="active" ` "This device"** (green, sits after title), description "Toronto, CA · Active now" / "Last active 3 h ago", meta mono 12px IP (masked last octet). Trailing: "Sign out" ghost sm for non-current rows (44 min on mobile via overflow Menu if narrow); current row has none. Sorted: this device first, then recency. Cap 5 visible + "Show N more".
4. **DangerZone** group: Row "Sign out everywhere" — "Ends every session, including this one. You'll need to sign in again." trailing outline-red Button -> ConfirmDialog (copy §8). Secondary row "Sign out other devices" (keeps this one) — **primary recommended action, listed first**, standard (non-red) outline button.
5. Footer text: "Averrow never stores your Google password. Sign-in is handled by Google."

### 5.3 Notifications (`/settings/notifications/*`)
Pane top: summary strip (Card flat, 14px): "Push on this device · Email on · Quiet hours 22:00–07:00" each as Badge-like status text; below, `Tabs underline`.
- **Channels** (default):
  - Group **Push** (global master): Row "Push notifications" Switch (+ browser permission state; blocked -> InlineBanner with how-to-unblock, Switch disabled w/ reason). Row "Send me" -> Select severity floor (Everything / Medium and above / High and above / Critical only), with live count hint "About 4 a day at this level" if data exists (omit otherwise). Row "Send a test notification" -> `Button secondary sm` "Send test" (loading spinner; success inline "Sent — check your device", failure with reason).
  - Group **Email**: Switch "Email notifications"; Select "Send me" floor; Row "Email address" read-only value.
  - Group **In app** (bell): floor Select (default Everything).
  - Mobile: each group = card; floors are stacked full-width Selects.
- **Events**: Group per category (Threats, Takedowns, Brands & monitoring, Platform & system — staff-only categories hidden for tenants). Each event = toggle `SettingsRow` (title human event name, description one sentence "When a new critical threat targets a brand you watch"). Header actions per group: "Turn all on / off" text button (14px/600 `--amber-text`). Search not needed (<= ~14 events). Per-brand subscriptions: Group "Brand overrides": rows brand name + Select Watching/Default/Muted; "+ Add brand" opens Sheet w/ search.
- **Digest**: Row SegmentedControl "How often" (Off / Hourly / Daily / Weekly; Realtime lives in Channels). When not Off: Row "Delivery time" TimeInput (daily/weekly) + Row "Day" Select (weekly), Row "Include" floor Select, Row "Send via" Select Email/Push. Preview line: "Next digest: tomorrow 08:00 (Toronto)". Off state: other rows disabled with reason "Choose a frequency to schedule digests."
- **Quiet hours**: Switch "Quiet hours" (description "Hold push until you're back. Critical alerts still come through" — only if that is true in backend; else "Pause push notifications during these hours."). When on: From/To TimeInput pair, Days chips (M T W T F S S, 44px toggle chips, `role=group`), TimezoneSelect (inherits profile tz), "Let critical alerts through" Switch (default on). Explicit Save (multi-field) with dirty bar; summary under: "Quiet 22:00–07:00 · Mon–Sun · Toronto".
- **Not in v1:** days of week, digest delivery time/day, send-via (no backend support). Quiet hours is a start/end window + time zone only; the summary strip and the inputs render times in the user's locale (12h/24h) so they always match.
- Save semantics: Channels/Events switch+select autosave per control; Digest and Quiet hours autosave per control too EXCEPT quiet-hours time/day group = explicit Save. Failure reverts + error row text.
- Loading: row skeletons x4 per group. Error: PageState error card with retry. Not-supported push: Channels shows only email/in-app.

### 5.4 Devices & App (`/settings/devices`)
1. **Install card** (hidden when installed; `Card active accent=var(--violet)`): phone/app tile 48, title "Install Averrow", 14px "Faster launch, full-screen, and reliable notifications", `Button primary` "Install app" (or iOS: "Add to Home Screen" opens Sheet with 3 numbered steps + share glyph). Dismissal not offered here (always available). Installed: collapses to a single row "Averrow is installed" + green Badge.
2. Group **Push devices**: rows: tile (device glyph), title "iPhone — Safari" + "This device" Badge, description "Registered Sep 28 · Last push 2 h ago", trailing: overflow Menu (Send test, Remove). Remove -> ConfirmDialog "Stop sending notifications to this device?". Empty: PageState empty compact + "Turn on push" button -> Channels.
3. Group **Sign-in on this device**: Row "Face ID / Touch ID" (biometric/passkey auto-prompt) Switch — "Offer to sign in with {Face ID} when you open the app"; shows "Not available on this device" disabled with reason if unsupported. Label uses platform noun (Face ID, Touch ID, Windows Hello, "fingerprint").
4. Group **About**: App version row (mono `vX.Y.Z · sha`, Copy), "Check for updates" row (SW update state: "Up to date" / "Update ready — Reload" amber), "Clear local cache" ghost (ConfirmDialog).

### 5.5 Avatar menu contents
Trigger 36px avatar (SELF_AVATAR_COLOR) in top bar. Desktop popover / mobile bottom Sheet. Order:
```
[avatar 40] Claude Leroux                (15/700)
            claude@example.com           (13 secondary, truncate)
            [Super admin] [Passkey on]   (Badge xs-> md)
-----
 Profile
 Security
 Notifications                    [3]     (unread Badge if any)
 Devices & App
-----
 Appearance   [Auto|Dark|Light]   inline compact SegmentedControl (3x 36px; 44 in sheet)
-----
 Switch account…   (opens Google account chooser: `prompt=select_account`, full-page redirect w/ return_to; label sub "Use a different Google account")
 Sign out                         (danger text)
-----
 vX.Y.Z · sha   (mono 11px muted, non-interactive, centered)
```
- No "Organization" entry. Staff "Users & Access" lives in the sidebar admin group.
- Switch account: ConfirmDialog is not needed; show full-screen "Opening Google…" interstitial (PageState loading) to avoid blank flash. Previous session kept until the new OAuth completes; failure/cancel returns to the same page with toast "Still signed in as {email}."
- Hover/focus order follows visual order; `Esc` returns focus to trigger.

### 5.6 Notification inbox / bell adjustments
- Bell button: 44x44 hit, 20px glyph; unread dot -> **count Badge** (red `critical` only when unread critical exists, otherwise amber), `99+` cap, `aria-label="Notifications, 3 unread"`; live region announces new arrivals politely (debounced 2s).
- Panel: desktop popover 400x min(560, 100dvh-96) `Card elevated`; mobile = full-height Sheet (100dvh, top bar with "Notifications" + "Mark all read" + gear -> `/settings/notifications`). Header filter: SegmentedControl "All | Unread" (40/44).
- Item: 56px+ min, severity dot 8px (+ text severity in `sr-only` and Badge on wide), title 14px/600 (2-line clamp), body 13px secondary (2-line clamp), time 12px mono tertiary right-aligned, unread = 3px amber left bar + title 700 (not just bg color). Swipe actions on mobile: skip (no hidden gestures); instead row tap = open + mark read; overflow-free.
- Group by day headers (Today / Yesterday / date) sticky 12px/600 uppercase tertiary.
- Empty: `PageState kind=clear compact` "You're all caught up" + "Notification settings" link. Loading: 5 row skeletons. Error: inline error with Retry (keeps stale list visible beneath, `layout=inline`).
- Footer: "View all" -> full inbox page (existing); "Notification settings" link.

---

## 6. Typography, spacing, touch

Font: `--font-sans` (Plus Jakarta Sans) for all prose and titles; `--font-mono` ONLY for: timestamps, IDs, IPs, version, counts, keyboard hints, section eyebrows on the dashboards (not on settings).
```
Role                 Mobile(<768)  Desktop   Weight  Color
Page title (h1)      28/1.1        24/1.1    800     primary   (-0.5px)
Hero name            22/1.2        28/1.15   800     primary
Group header         12 caps .06em 12 caps   600     tertiary
Row title            16/1.3        15/1.3    600     primary
Row description      14/1.45       13/1.45   400     secondary   (floor 13)
Body / dialog        15/1.5        14/1.5    400     secondary
Field label          14/600        13/600            primary
Input text           16            15
Help / error         13/1.45       13/1.45   400     tertiary / sev-critical-text
Button               15 (md/lg)    13-14     600
Meta mono            12            12        500     tertiary    (floor 12; NEVER 9-11 for readable content)
Badge text           11 (raise md from 10)  11  700
```
Hard floors on this surface: prose 13px, mono 12px, badge 11px. Remove all 9-11px mono descriptions in `profile/*`.
Contrast: description `--text-secondary` (dark .60 on card ~7:1; light .74 OK). `--text-tertiary` only for help/meta, never required info alone. `--text-muted` only decorative/disabled.

Spacing scale: 4/8/12/16/20/24/32. Row padding 12-16; group gap 24 (28 desktop); page gutters 16 mobile / 24 desktop; hero padding 24 (20 mobile); form field gap 16. Radius: tiles 9, inputs/buttons 10, segmented 12, cards 16 (`--card-radius`), sheets 24.

Touch: every interactive element >= 44x44 CSS px on touch (hit area may extend with pseudo-element); rows >= 56; adjacent targets >= 8px apart. Inputs/Selects 44 tall, **16px font on < 768** (no iOS zoom). Pointer-coarse media query governs, not just width.

---

## 7. Motion, themes, states

Motion (tokens already exist): hover/press `--dur-fast` 120ms; toggles, selects, menu open `--dur-base` 180ms; sheet/page transitions `--dur-slow` 300ms; easing `--ease-standard` for state changes, `--ease-emphasized` for enter, `--ease-out` for exit (exit durations ~70% of enter). Only animate transform/opacity/background-color/box-shadow.
Press feedback: rows scale none; bg-darken only (lists must not jitter). Buttons keep existing brightness shift.
`@media (prefers-reduced-motion: reduce)`: transitions -> 0 except opacity <= 120ms; no slide, no scale, no spinner-to-pulse… spinners remain (functional) but at slower rate is fine; toast just fades.

Light/dark parity rules:
1. Only CSS vars; zero hex in components (the lone exceptions: `#0A0F1E` on-amber text — promote to `--text-on-amber` token, already referenced in primitives; `#fff` switch knob).
2. Accent + severity hex constant across themes; any text in accent color uses the `-text` var (`--amber-text`, `--sev-*-text`, `--violet-text`).
3. Tints use `color-mix` with % tokens; raise tint % ~1.25x in light (add `--tile-tint-pct: 16%` / light `20%`).
4. Verify in both: Switch off-state >= 3:1, input borders >= 3:1 (`--border-strong`), focus ring visible on `#FFF` (amber ring on white is 2.1:1 -> use `--amber-text` ring in light via `--focus-ring` token: dark `var(--amber)`, light `var(--amber-text)`).
5. Overlays/scrim and glow shadows have theme variants (`--scrim`). Hero glow reduces automatically via `--card-accent-glow-pct`.

States (always via `PageState`, `kind` required):
- Initial load: layout-shaped skeleton (rows at final height) — `kind=loading layout=card`. No spinners on whole page.
- Empty: `kind=empty compact` with one action (Add passkey / Turn on push). Good-empty (no unread, no sessions beyond this one): `kind=clear`.
- Error: `kind=error layout=card onRetry`; inline row errors for single-control failures; never blank. Offline: InlineBanner "You're offline — changes will not save" and disable writes.
- Locked: `kind=locked` for staff-only sections viewed by non-staff ("Ask an admin for access").
- Saving: per-control spinner (row loading), Save buttons show spinner + keep width.

---

## 8. Copy tone + rewrites

Tone: plain, second person, active, sentence case, no jargon, no vendor names, no exclamation marks, no "legacy/tenant/v2/store/prefs". Say what happens and when. Titles are noun phrases; descriptions are one sentence ending with period. Errors: what failed + what to do ("Couldn't save. Check your connection and try again."). Confirm buttons repeat the verb ("Sign out everywhere", not "OK"). Time zones in the user's language: "Toronto (UTC-5)".

| Today (internal) | Rewrite |
|---|---|
| Tenant brand-event digest | **Brand activity summary** — "A summary of new threats and takedowns for the brands you watch." |
| legacy Digest | **Email summary** — "A scheduled roundup of everything above your chosen level." (remove "legacy" entirely; one digest) |
| via Resend / "Send via Resend" | **Send to** your email address (never name the provider) |
| Realtime — every notification individually | **Instantly** — "As each alert happens." |
| Include severities / severity floor | **Only notify me about…** options: Everything / Medium and above / High and above / Critical only |
| Off — never send | **Off** |
| High and critical only | **High and above** |
| Watching / Default / Ignored | **Follow closely / Normal / Muted** with descriptions "Every alert for this brand." / "Follows your level above." / "No alerts for this brand." |
| Quiet hours (Start/End/Timezone) | **Quiet hours** — "Pause push notifications overnight." Fields: "From", "To", "Time zone" |
| Remove subscription | **Stop following this brand** |
| Unknown device | **Unnamed device** (+ browser/OS parsed) |
| Passkeys section / Biometric | **Passkeys** — "Sign in with Face ID, Touch ID or a security key." |
| Force logout / revoke | **Sign out everywhere** — confirm: "This ends all your sessions, including this one. You'll need to sign in again." Buttons: "Cancel" / "Sign out everywhere". |
| Remove passkey | Title "Remove this passkey?" Body "You won't be able to use it to sign in. You can add it again anytime." |
| Switch account | **Switch account…** sub "Use a different Google account" |
| Profile (page title "Averrow Profile" + AI-FIRST... subtitle) | **Profile** / "How you appear to your team." |
| Organization (staff) | **Users & Access** / "Manage staff, invites and API keys." |
| Push permission denied | "Notifications are blocked in this browser. Allow them in your browser's site settings, then come back." |
| Test push | "Send test notification" -> success "Sent. It should arrive in a few seconds." |
| Empty bell | "You're all caught up." |
Error/empty micro-copy: lead with the fact, then the next step, max 2 short sentences.

---

## 9. Wireframes (ASCII)

### 9.1 Menu — mobile (390px), bottom sheet
```
+--------------------------------------+
|        (dimmed page, 62% scrim)      |
|                                      |
+--------------------------------------+  radius 24 top
|               ====                   |  grab handle
|  (CL)  Claude Leroux                 |
|  amber claude@example.com            |
|        [Super admin] [Passkey on]    |
|--------------------------------------|
| [A] Profile                       >  |  44px rows
| [G] Security                      >  |
| [B] Notifications            (3)  >  |
| [V] Devices & App                 >  |
|--------------------------------------|
|  Appearance                          |
|  [ Auto ][ Dark ][ Light ]           |  44px segmented
|--------------------------------------|
| [ ] Switch account...                |
| [ ] Sign out                (red)    |
|        v4.0.0 . a1b2c3d              |
+--------------------------------------+  safe-area pad
```
### 9.1b Menu — desktop (1280px), popover 296px anchored to top bar avatar
```
 ... top bar ......................... (bell) (CL) <- trigger
                                   +--------------------------+
                                   | (CL) Claude Leroux       |
                                   |      claude@example.com  |
                                   |      [Super admin][Key]  |
                                   |--------------------------|
                                   | Profile                  |
                                   | Security                 |
                                   | Notifications        (3) |
                                   | Devices & App            |
                                   |--------------------------|
                                   | Theme [Auto|Dark|Light]  |
                                   |--------------------------|
                                   | Switch account...        |
                                   | Sign out                 |
                                   |      v4.0.0 . a1b2c3d    |
                                   +--------------------------+
```

### 9.2 Settings home — mobile (390px)
```
+--------------------------------------+
| Settings                             |  28/800 large title
|                                      |
| +----------------------------------+ |
| | (CL)  Claude Leroux              | |  Card active (amber glow)
| |       claude@example.com         | |
| |       [Super admin] [Passkey on] | |
| |       Averrow staff . Full access| |
| +----------------------------------+ |
| ACCOUNT                              |
| +----------------------------------+ |
| |[A] Profile                     > | |
| |    Name, appearance, time zone   | |
| |  ----------------------------    | |
| |[G] Security                    > | |
| |    Passkey on . 3 sessions       | |
| +----------------------------------+ |
| PREFERENCES                          |
| +----------------------------------+ |
| |[B] Notifications           (2) > | |
| |    Push on . High and above      | |
| |  ----------------------------    | |
| |[V] Devices & App               > | |
| |    2 devices . App installed     | |
| +----------------------------------+ |
| +----------------------------------+ |
| |          Sign out        (red)   | |
| +----------------------------------+ |
|        v4.0.0 . a1b2c3d              |
+--------------------------------------+
```
### 9.2b Settings home — desktop: not shown; /settings redirects to /settings/profile (rail below).

### 9.3 Profile — mobile (390px) detail
```
+--------------------------------------+
| < Settings          Profile          |  sticky 56px
|--------------------------------------|
| Profile                              |  28/800
| PERSONAL INFO                        |
| +----------------------------------+ |
| | Display name                     | |
| | [ Claude Leroux               ]  | |  44px, 16px text
| | Email                            | |
| | [ claude@example.com      (lock)]| |
| | Managed by your Google account.  | |
| | [ Save changes ]  (disabled)     | |  full width 44
| +----------------------------------+ |
| APPEARANCE                           |
| +----------------------------------+ |
| |[A] Theme                         | |
| |    [ Auto ][ Dark ][ Light ]     | |
| |  ----------------------------    | |
| |[A] Time zone    Toronto (UTC-5)>| |
| +----------------------------------+ |
| ACCOUNT                              |
| +----------------------------------+ |
| | Role                [Super admin]| |
| | Access        Full platform ...  | |
| | Member since        Mar 3, 2025  | |
| +----------------------------------+ |
| +----------------------------------+ |
| |          Sign out        (red)   | |
| +----------------------------------+ |
+--------------------------------------+
```
### 9.3b Profile — desktop (1280px)
```
+-sidebar-+--------------------------------------------------------------+
|         | Settings                                                     |
|         | Your profile, security and notifications.                    |
|         |                                                              |
|         | ACCOUNT          +----------------------------------------+  |
|         | |#| Profile  *   | (CL)  Claude Leroux        [Edit][Out] |  |
|         | [G] Security     |  amber  claude@example.com             |  |
|         | PREFERENCES      |  [Super admin][Passkey on]             |  |
|         | [B] Notifications|  Averrow staff . Full platform access  |  |
|         | [V] Devices&App  +----------------------------------------+  |
|         |                  PERSONAL INFO                              |
|         |  (rail 232)      +----------------------------------------+  |
|         |                  | Display name   [ Claude Leroux      ]  |  |
|         |                  | Email          [ claude@... (lock)  ]  |  |
|         |                  |                  [Discard][Save changes]| |
|         |                  +----------------------------------------+  |
|         |                  APPEARANCE                                 |
|         |                  | Theme              [Auto|Dark|Light]   |  |
|         |                  | Time zone        Toronto (UTC-5)     >  |  |
|         | [Sign out]       ACCOUNT ...                                |
+---------+--------------------------------------------------------------+
```
(# = 3px amber active bar; * = active gradient fill.)

### 9.4 Notifications — mobile (390px)
```
+--------------------------------------+
| < Settings       Notifications       |
|--------------------------------------|
| Notifications                        |
| Push on . Email on . Quiet 22-07     |  13px summary
| Channels|Events|Digest|Quiet hours >  |  underline tabs, scrollable
|--------------------------------------|
| PUSH                                 |
| +----------------------------------+ |
| |[B] Push notifications     (O--)  | |  Switch 52x32
| |    Alerts on this device.        | |
| |  ----------------------------    | |
| |[B] Send me                       | |
| |    [ High and above         v ]  | |  stacked, 44px
| |  ----------------------------    | |
| |[B] Send a test notification      | |
| |    [ Send test ]                 | |
| +----------------------------------+ |
| EMAIL                                |
| +----------------------------------+ |
| |[B] Email notifications    (O--)  | |
| |    Sent to claude@example.com    | |
| |[B] Send me  [ Critical only  v]  | |
| +----------------------------------+ |
| IN APP                               |
| |[B] Show in the bell [Everything v]| |
+--------------------------------------+
```
### 9.4b Notifications — desktop (1280px)
```
+-sidebar-+--------------------------------------------------------------+
|         | Settings                                                     |
|         | ACCOUNT        Notifications                                  |
|         |  Profile       Push on . Email on . Quiet hours 22:00-07:00   |
|         |  Security      Channels | Events | Digest | Quiet hours        |
|         | PREFERENCES    ----------------------------------------------|
|         | |#|Notifications PUSH                                        |
|         |  Devices & App +----------------------------------------+   |
|         |                |[B] Push notifications          (--O)   |   |
|         |                |    Alerts on this device.              |   |
|         |                |----------------------------------------|   |
|         |                |[B] Send me      [High and above    v]  |   |
|         |                |    Only alerts at this level or higher.|   |
|         |                |----------------------------------------|   |
|         |                |[B] Send a test notification [Send test]|   |
|         |                +----------------------------------------+   |
|         |                EMAIL ...                                    |
+---------+--------------------------------------------------------------+
```

---

## Implementation notes for frontend-engineer (non-binding)
- New in shared: `ui/settings/{SettingsGroup,SettingsRow,Switch,SegmentedControl,Field,Select,TimeInput,TimezoneSelect,ConfirmDialog,Sheet,Menu,Toast}.tsx`, `account/{AccountShell,AccountHero}.tsx`; tokens: `--violet*`, `--tile-tint-pct`, `--focus-ring`, `--scrim`, `--text-on-amber`.
- Extend `Avatar` (squircle, size 72, self tone), `Tabs` (`size="md"` 13px), `Badge` md -> 11px (check other call sites; opt-in prop `legible` if risky).
- Delete `profile/primitives.tsx` re-implementations once migrated; no ad-hoc Card/Button/Input.
- Verify with Lighthouse a11y at 390 and 1280 in both themes; no horizontal body scroll.

---

## As built (2026-10-05) — deltas from the design above

Factual notes only; the sections above remain the design intent.

- **Shell name and location.** The shell is `SettingsShell` (`packages/shared/src/ui/settings/SettingsShell.tsx`), not `account/AccountShell`. Its props include `sections`, `activeId`, `basePath`, `home`, `homeFooter`, `railFooter`, `renderLink`, `onNavigate`. `getAccountSections` / `accountSectionIdFromPath` (`packages/shared/src/account/sections.tsx`) describe the rail/list/menu entries once.
- **Kit layout.** Primitives are split across `ui/forms/` (Switch, SegmentedControl, Field/Label/HelpText/FieldError, Input, Select, TimeInput), `ui/overlays/` (Sheet, Dialog, ConfirmDialog, Menu/ResponsiveMenu/MenuRadioGroup/MenuRadioItem, ToastProvider/useToast, TimezoneSelect) and `ui/settings/` (SettingsShell, SettingsGroup, SettingsRow, IconTile, AccountHero, DangerZone, InlineBanner, CopyField), all re-exported from `@averrow/shared/ui`. Pages are in `packages/shared/src/account/` (`@averrow/shared/account`).
- **Extra tokens beyond §4.0:** `--text-help`, `--card-shadow-elevated`, `--card-rim-elevated`, `--z-popover`, `--switch-off-border`, `--switch-knob-off` (`theme/tokens.css`).
- **Opt-in props shipped:** `Badge font="sans"`, `Tabs size="md"`, `FilterBar size="md"`, `Card overflow`, `SheetContent labelledBy`, `Avatar shape="squircle"` / `tone="self"`.
- **Mounts.** Ops: `/settings/{profile,security,notifications/:tab,devices}` (`features/settings/`). Tenant: `/tenant/account/{profile,security,notifications/:tab}` (`features/account/`, `ACCOUNT_BASE_PATH = '/account'`; there is no Devices & App because the tenant has no service worker). Legacy `/profile` and `/notifications/preferences` redirect in ops; `/profile` redirects in tenant. `/notifications` (the inbox) is unchanged in ops.
- **Users & Access** is `/admin/users` (`features/admin/UsersAccess.tsx`, sidebar admin group), not `/settings/access`. No `/organization` redirect exists in ops `App.tsx` (the old page and route are gone).
- **Install card.** The old `InstallAppCard` was deleted; install lives in `DevicesSettings` (`/settings/devices`). `InstallAppBanner` (Overview) and `FirstSignInPasskeyPrompt` (ShellV4) are unchanged.
- **Notifications data.** Quiet hours are read/written on preferences v2; per-event toggles stay on `/api/notifications/preferences` (partial PATCH). Delivery's `resolveQuietHours` uses the v2 window whenever a v2 row exists (migration 0281 backfills v1 windows).
- **Sessions.** The Security page uses the caller-scoped `/api/auth/sessions*` endpoints (`handlers/account-sessions.ts`); revoking a session also rejects its live access tokens via the `sid` claim + `forced_logout:<id>` (`lib/forced-logout.ts`).
- **Old profile code.** `packages/shared/src/profile/` was deleted (2026-10-05); the API-client type moved to `account/api-types.ts`.
