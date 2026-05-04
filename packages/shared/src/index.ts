// @averrow/shared — code shared between the worker and the UI.
//
// Today: notification + alert registries. Future: any other type
// definitions or constants that drift between packages.
//
// Both `packages/trust-radar/` and `packages/averrow-ui/` import from
// here so we have one source of truth for things that absolutely must
// match across them (event keys, dedup windows, default severities,
// CHECK constraint clauses, etc.).

export * from './notification-events';
export * from './alert-types';
export * from './platform-status';
