> Archived 2026-06-10: one-time post-deploy checklist for migration 0119; canonical spec is docs/SHARED_LOGIN_SPEC.md.

# Login + PWA + Biometric — On-Device Wiring Audit Checklist

**Purpose:** verify the FarmTrack-aligned login/profile/push/biometric
flows actually work on real devices after PR 1 + 2 ship. Run this after
deploying and applying migration `0119`.

---

## 0. Operator pre-flight

These need doing once before the rest of the audit makes sense.

- [ ] **Apply the migration** to the production D1:
      ```bash
      cd packages/trust-radar
      npx wrangler d1 migrations apply DB --remote
      ```
- [ ] **Confirm VAPID is bootstrapped** at `/v2/admin/push`:
      - Status panel should show `enabled` / `configured` / `configured`.
      - If not, follow the four-step bootstrap (Generate keypair → `wrangler secret put VAPID_PRIVATE_KEY` → flip toggle on → Send test push).

---

## 1. Login reachability

Verifies PR 1's `/v2/login` worker fix.

- [ ] Open `https://averrow.com/` (NOT signed in) → click Sign In → lands on `/v2/login`, **not** the Google consent screen.
- [ ] All three options visible above the fold on a 1440×900 desktop:
      - "Sign in with passkey" (green) — only if browser supports WebAuthn
      - "Sign in with Google" (amber)
      - Email field + "Send link" button
- [ ] Footer pillars visible: `DETECT · ANALYZE · CORRELATE · RESPOND`
- [ ] Tagline above footer: `AI-FIRST THREAT INTELLIGENCE`
- [ ] AV brand tile shows in amber gradient

---

## 2. Login responsive

Run all three at the actual viewport sizes (Chrome DevTools is fine for this; real-device for §4–§6).

| Viewport | Expected |
|---|---|
| 360×640 (mobile S) | Card max-w-full with 16px gutter, three buttons stack, footer pillars wrap to two lines if needed |
| 768×1024 (tablet) | Card centered max-w-md, three options stacked, single-line footer |
| 1440×900 (desktop) | Card centered max-w-md, generous whitespace, single-line footer |

- [ ] Mobile (360px)
- [ ] Tablet (768px)
- [ ] Desktop (1440px)

---

## 3. Avatar — initials only

- [ ] Click the top-right avatar pill on any signed-in page → dropdown shows initials on **amber** background, no Google picture anywhere.
- [ ] Set display_name to "Claude Leroux" in Profile → avatar shows `CL`.
- [ ] Set display_name to "Claude Marc Leroux" → avatar shows `CL` (first + last word).
- [ ] Set display_name to "Claude" → avatar shows `C`.
- [ ] Clear display_name (leave blank, save) → avatar falls back to first char of email local-part.
- [ ] Visit `/v2/profile` → identity card avatar is 64×64 amber circle with initials.

---

## 4. Biometric — `FirstSignInPasskeyPrompt`

Reset between tests:
```js
// Run in DevTools console
localStorage.removeItem('averrow.passkey-prompt.dismissed');
location.reload();
```

### iOS Safari (PWA installed to home screen)

- [ ] Open Averrow PWA on iPhone (post-install).
- [ ] Sign in with Google or magic link.
- [ ] Within ~1 second of landing: modal appears with green lock icon, "Sign in faster next time?" title.
- [ ] Tap "Set up biometric" → Face ID / Touch ID prompt fires from iOS.
- [ ] Approve → toast "Biometric sign-in is set up." → modal closes.
- [ ] Visit `/v2/profile` → Passkeys section shows new entry with `BIOMETRIC` badge.
- [ ] Sign out → return to `/v2/login` → "Sign in with passkey" → Face ID prompt → signs in.

### Android Chrome (PWA installed)

Same as iOS but with fingerprint sensor instead of Face ID.

- [ ] Modal appears post-sign-in
- [ ] "Set up biometric" → fingerprint prompt
- [ ] BIOMETRIC badge shows in Profile
- [ ] Sign-out / sign-in cycle works

### Desktop Chrome (Mac with Touch ID)

- [ ] Modal appears
- [ ] "Set up biometric" → Touch ID prompt
- [ ] BIOMETRIC badge shows

### Dismissal behavior

- [ ] "Maybe later" → modal closes → reload page → modal reappears (NOT dismissed).
- [ ] Click outside modal (or × button) → dismisses → reload → modal does NOT reappear.
- [ ] Re-clear localStorage to reset.

---

## 5. PWA install

### Android Chrome

- [ ] Open `https://averrow.com/v2` in Chrome (signed in, NOT installed).
- [ ] `InstallAppBanner` appears at top of Home page with native "Install" button (means `beforeinstallprompt` fired).
- [ ] Tap "Install" → Chrome's install dialog → confirm → app installs.
- [ ] Open Averrow from Android home screen → app opens in standalone mode (no Chrome chrome).
- [ ] In standalone mode: banner is hidden. `/v2/profile` Install card is also hidden.

### iOS Safari

- [ ] Open `https://averrow.com/v2` in Safari (NOT installed).
- [ ] `InstallAppBanner` appears with the four-step Add to Home Screen instructions.
- [ ] Tap Share → Add to Home Screen → Add → app icon appears on home screen.
- [ ] Open Averrow from iOS home screen → opens standalone.
- [ ] In standalone: banner + Install card both hidden.

### Desktop Chrome / Edge

- [ ] Open in Chrome → Install icon visible in address bar.
- [ ] `InstallAppBanner` shows on Home OR `InstallAppCard` "Show manual steps" reveals fallback instructions.
- [ ] Click install → app opens in PWA window.

### Dismissal

- [ ] Click "Not now" on the banner → dismiss flag in `localStorage` (`averrow.install.dismissed`) → banner stays hidden across reloads.
- [ ] To re-test: `localStorage.removeItem('averrow.install.dismissed')`.

---

## 6. Push end-to-end

After §0 confirms VAPID is bootstrapped + a passkey + standalone install (iOS only).

- [ ] In standalone PWA: navigate to `/v2/notifications/preferences`.
- [ ] Toggle subscribe → permission prompt fires → grant → toast "Subscribed."
- [ ] Confirm a row was created in D1:
      ```bash
      npx wrangler d1 execute trust-radar-v2 --remote \
        --command "SELECT user_id, device_label, endpoint FROM push_subscriptions ORDER BY created_at DESC LIMIT 3"
      ```
- [ ] At `/v2/admin/push` (super_admin) → Send test push → Notification appears on the device with the test message.
- [ ] Toggle unsubscribe → row disappears from `push_subscriptions`.

---

## 7. Profile page edits

- [ ] Edit display_name → Save → toast "Saved." → reload → value persists.
- [ ] Toggle theme Dark → Light → page re-styles immediately. Reload → light persists.
- [ ] Change timezone → Save → reload → persists.
- [ ] Notifications row → click → navigates to `/v2/notifications/preferences`.
- [ ] Security section: Active Sessions count visible. "Revoke other sessions" works (your current session stays signed in).

---

## 8. Sign-out + sign-in cycle

- [ ] Sign out → bounces to public homepage.
- [ ] Click Sign In → `/v2/login`.
- [ ] All three options surface, conditional UI dropdown shows registered passkey when focusing email.
- [ ] Sign in with passkey (no email needed) → biometric prompt → signs in to `/v2/observatory`.

---

## 9. Cross-platform consistency check

If you have FarmTrack open in another browser tab:

- [ ] Login layout side-by-side: brand tile + name + tagline area structure identical (only the letters/tagline/pillars differ).
- [ ] Profile section order identical.
- [ ] Avatar initials follow the same rule on both platforms.
- [ ] Install banners look identical (only product name differs).

If anything diverges that isn't in `docs/SHARED_LOGIN_SPEC.md` §1
deltas list, that's a bug — file it against whichever platform is
out of date.

---

## What to do if something fails

- **Modal doesn't appear** → check console for errors, verify `passkey_count` in `/api/auth/me` response.
- **Initials show wrong letter** → check `user.display_name` in `/api/auth/me`. Migration may not have run.
- **Push subscribe says "disabled by admin"** → §0 step 2 hasn't been done.
- **Old `/api/push/subscribe` 404** → expected; that's the rename. Re-subscribe via Profile.
- **Drift detected** → file an issue against the lagging platform with a link to `SHARED_LOGIN_SPEC.md` §1 row.
