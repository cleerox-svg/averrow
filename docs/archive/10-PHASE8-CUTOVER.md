> Archived 2026-06-10: completed — /v2 React is the live platform (cutover done).

# Phase 8 Cutover — /v2 as Default Route

## What This Means
- averrow.com/ → serves /v2 React app (not old SPA)
- All old SPA routes redirect to appropriate /v2 equivalents
- Old admin tabs (DASHBOARD/USERS/ORGANIZATIONS etc.) removed

## Pre-Cutover Checklist
- [ ] Trends → Platform Intelligence page live
- [ ] Spam Trap war room built
- [ ] Pre-cutover dashboard additions (email coverage, 4 admin buttons)
- [ ] Observatory responsive fixes merged
- [ ] Budget management deployed
- [ ] Full demo walkthrough — click every page
- [ ] Mobile test on iOS and Android

## Redirect Map
| Old Route | New Route |
|-----------|-----------|
| /admin/dashboard | /v2/admin |
| /admin/users | /v2/admin/users |
| /admin/organizations | /v2/admin/users |
| /admin/feeds | /v2/feeds |
| /admin/agent-config | /v2/agents |
| /admin/audit | /v2/admin/audit |
| /admin/spam-trap | /v2/spam-trap |
| /admin/takedowns | /v2/takedowns |

## Worker Change
In the main request handler, change the default route:
- Currently: / → serves old SPA
- After cutover: / → serves /v2 React app (dist/index.html)
- Keep /v2/* working (no breaking change)

## Rollback Plan
Keep old SPA code but gate behind /legacy route.
If anything breaks, change / back to old SPA in 30 seconds.
