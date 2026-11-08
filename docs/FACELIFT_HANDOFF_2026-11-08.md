# Facelift handoff — 2026-11-08

State of the 2026-11 facelift at the end of the session that ran Phases 3–5.
Read this first in a new session, then CLAUDE.md §1A / §9a.

## Done and live

| PR | Contents |
|---|---|
| #1885–#1892 | Phase 3: tokens, shared kit sweep, Geist, motion kit, R3 logo, account-synced Appearance, `FACELIFT = true` flip (v4.8.0) |
| #1893 | Icons (PWA and Android) |
| #1894 | Amber sweep: amber is status-only, held by the ratchet test |
| #1895 | Hero copy doc |
| #1896 | Phase 4: worker pages, emails, OG image, CSP, `/email/averrow-mark-r3.png` |
| #1897 | Marketing palette, self-hosted Geist, R3 logo, owner-approved `_headers` long-cache rules for `/fonts/*` and `/v2/email/*` |
| #1898 | Marketing CI job: `astro check`, Playwright, perf budgets |
| #1899 | H4A operation hero (canvas, auto-play steps, "Operation mapped" claim) |

Every deploy above succeeded (`deploy-radar.yml`).

## Outstanding, in order

1. **DONE (#1900 merged).** Motion PR. Was: open as a draft on branch `claude/averrow-p3-1-tokens-d36n7e`. This handoff doc is committed on the same branch.
   - Contents: M1 motion tokens, native cross-document view transitions with a Firefox fallback, and lazy GSAP core scroll sequences on home and `/platform`. The sequences live in `packages/averrow-marketing/src/lib/motion/`.
   - Local gate passed: 872 Chromium/mobile tests and 32 Firefox/WebKit tests. Code review and design review fixes are in.
   - To do: check CI. If it is green, set `draft:false`, then merge with `merge_method: "merge"` and `expectedHeadSha`. Then confirm the deploy.

2. **DONE (v4.9.0, #1902).** Phase 5 final PR: copy, changelog and docs. A content agent had started this in a worktree that will not survive the session. Redo it from fresh `master` after #1900 merges:
   - **Copy.** Replace "Fake profiles" with "Impersonation accounts" in `packages/averrow-marketing/src`. Known pages: `scan.astro`, the platform impersonation page, `solutions/brand-and-legal`, `solutions/index`. Grep for any other "fake profile" or "fake account". Flip, do not delete, any test that asserts the old string.
   - **Version.** Bump `/platform-version.json` from 4.8.0 to 4.9.0.
   - **Staff changelog.** Add a 4.9.0 entry to root `CHANGELOG.md`, detailed: everything in #1896–#1900.
   - **Public changelog.** Add an entry to `packages/averrow-marketing/src/data/changelog-entries.ts`. Keep it generic: no GSAP, Astro or infra names.
   - **Docs.** Update the BRAND_BRIEF rollout section (§12) and `packages/averrow-marketing/README.md`. The README should cover the motion loader and sequences, the hero runner `src/scripts/hero.ts`, and the Firefox/WebKit Playwright projects that run `hero.spec.ts` and `motion.spec.ts`.
   - After it merges, `tag-release.yml` creates the v4.9.0 tag.

3. **DONE (#1908).** L50 sample report, from the marketing review list.

4. **DONE.** Phase 4 test email sent to claude.leroux@averrow.com and confirmed by the owner.

5. **Phase 6: per-screen redesign.** Screen 1 (Shell) is done; Overview is next. One PR per screen, in this order:
   1. ~~Shell (`components/layout/ShellV4.tsx`)~~ DONE (#1909)
   2. Overview (`features/home/OverviewV4.tsx`) — next
   3. Alerts / Threats
   4. Tenant dashboard
   5. Login (facelift parity with FarmTrack is suspended by owner decision; see `docs/SHARED_LOGIN_SPEC.md`)
   6. Observatory controls

   Run each one through the full §1A pipeline: build, test, `qa-verifier`, then code and design review (plus appsec for Login). The owner asked for no previews: ship it like the flip and send screenshots afterwards.

## Also shipped 2026-11-08

- D1 overload fixes: #1901, #1904, #1907.
- Sign-in fixes: #1905.

## Owner action

- The abuse.ch feeds (urlhaus, threatfox, malwarebazaar) fail with 401/403. The `ABUSECH_AUTH_KEY` secret needs renewing.

## Owner decisions to keep

- Hover darkens.
- The self-avatar follows `--primary`.
- Accent, base and theme are saved to the account and follow the user across devices.
- Animations must work in every browser, which is why lazy GSAP is used with no ScrollTrigger.
- No count-up animations (BRAND_BRIEF §4).
- Merge each PR as it goes green (§9a), except for items on the owner-OK list: workflows, `wrangler.toml`, legal, destructive migrations.
- Force-push is blocked. Reset the branch from `origin/master` for each new PR. A plain push fast-forwards, because the merged branch is already an ancestor of `master`.
