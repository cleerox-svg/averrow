// ESLint 9 flat config for @averrow/ops (averrow-ops).
//
// Scope (follow-up #34, deferred from S3.5): wire the
// `@typescript-eslint/no-explicit-any` gate without breaking the build
// against the ~193 pre-existing `any` usages already in the codebase.
// This is intentionally a MINIMAL ruleset — it is not an attempt to
// bring in a full style/lint regime in one shot. `tseslint.configs.recommended`
// surfaces hundreds of pre-existing violations of unrelated rules
// (no-unused-vars, no-empty-object-type, ban-ts-comment, etc.) across a
// codebase that has never been linted, which would either fail CI outright
// or bury the one rule we actually want in review noise. So instead of
// extending the recommended set, only `@typescript-eslint` core parsing is
// wired up and exactly one rule is turned on.
//
// `no-explicit-any` is set to 'warn', not 'error': flipping it to 'error'
// today would break `pnpm lint` against the existing backlog. Once the
// existing `any`s are paid down (tracked separately), flip this to 'error'
// so new `any` usage fails the build instead of just warning.
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      // Frozen components (CLAUDE.md §4) — never refactored, exempt from lint.
      'src/features/observatory/components/ThreatMap.tsx',
      'src/features/brands/components/ExposureGauge.tsx',
      'src/features/brands/components/PortfolioHealthCard.tsx',
      'src/features/brands/components/Sparkline.tsx',
      'src/components/ui/ActivitySparkline.tsx',
      'src/features/observatory/components/EventTicker.tsx',
    ],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      // Registered (rules NOT enabled) solely so ESLint can resolve the
      // handful of pre-existing `// eslint-disable-next-line
      // react-hooks/exhaustive-deps` comments already in src/ — without
      // this, ESLint hard-errors on any disable comment referencing an
      // unregistered rule ID ("Definition for rule '...' was not found"),
      // which broke `eslint src` before this rule was even considered.
      // Not in scope for this task to decide whether exhaustive-deps
      // should actually run — that's a separate follow-up.
      'react-hooks': reactHooks,
    },
    rules: {
      // TODO(follow-up #34 paydown): flip to 'error' once the ~193
      // pre-existing `any`s are cleared. Until then this only flags NEW
      // `any` usage for review/editor visibility without red-building CI.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
);
