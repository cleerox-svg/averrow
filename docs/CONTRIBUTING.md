# Contributing

Guidelines for contributing to Averrow.

## Development Setup

```bash
git clone https://github.com/cleerox-svg/averrow.git
cd averrow
pnpm install
pnpm dev
```

Requires Node.js 20+ and pnpm.

## Code Style

- **TypeScript strict mode** — all packages use `strict: true` in tsconfig
- **No `any` types** — use proper typing or `unknown` with type guards
- **Zod validation** — all API inputs validated with Zod schemas
- **Consistent error handling** — return `{ success: false, error: "..." }` responses

## Commit Messages

Follow conventional commits:

```
feat(scope): add new feature
fix(scope): fix a bug
refactor(scope): code restructuring without behavior change
chore(scope): maintenance tasks
docs(scope): documentation changes
```

Scopes: `scan`, `social`, `email`, `agents`, `api`, `site`, `docs`, `ci`

Examples:
```
feat(social): add impersonation scoring pipeline
fix(scanner): resolve false positive on safe domains
refactor(cron): consolidate scheduled handlers into orchestrator
docs: add API reference documentation
```

## Branch Naming

```
feature/description
fix/description
claude/description-sessionId   (Claude Code branches)
```

## Pull Requests

1. Create a feature branch from `master`
2. Make changes with descriptive commits
3. Ensure `pnpm typecheck` passes
4. Open a PR against `master`
5. PRs trigger CI (typecheck all packages)
6. Merge triggers auto-deploy for changed packages

## Project Structure

```
packages/
├── averrow-worker/        → Main Worker (TypeScript), deploy name `averrow`
│   ├── src/
│   │   ├── handlers/     → HTTP route handlers
│   │   ├── agents/       → AI agents (Analyst, Observer, etc.)
│   │   ├── scanners/     → Social monitor, lookalike domains
│   │   ├── feeds/        → Threat feed integrations
│   │   ├── cron/         → Scheduled job orchestrator
│   │   ├── lib/          → Shared utilities
│   │   ├── templates/    → HTML page templates
│   │   └── middleware/   → Auth, rate limiting, CORS, security
│   └── migrations/       → D1 SQL migrations
```

## Adding New Features

### New API Endpoint
1. Create handler in `src/handlers/`
2. Register route in `src/index.ts`
3. Add auth middleware if needed (`requireAuth`/`requireAdmin`)
4. Add rate limiting for public endpoints

### New D1 Migration
1. Create `migrations/XXXX_description.sql` (next sequential number)
2. Use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`
3. Migration runs automatically on deploy

### New AI Agent
1. Create agent in `src/agents/`
2. Use `callHaikuRaw` from `src/lib/haiku.ts`
3. Add cron trigger in `src/cron/orchestrator.ts` if scheduled

### New Threat Feed
1. Create feed module in `src/feeds/`
2. Register in `src/feeds/index.ts`
3. Add safe domain filtering via `loadSafeDomainSet`/`isSafeDomain`

## Testing

```bash
pnpm typecheck              # Type check all packages
pnpm dev                    # Test locally with Miniflare
```

## License

Proprietary — © 2026 LRX Enterprises Inc. All rights reserved.
