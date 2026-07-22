// TODO: Refactor to use handler-utils (Phase 6 continuation)
// Averrow — Admin Handlers (barrel)
//
// S3.4a: this god-handler was split into cohesive per-domain modules
// under ./admin/. This file re-exports every symbol so all existing
// import paths (`../handlers/admin`) resolve unchanged. Do not add
// logic here — add it to the matching domain module.

export * from "./admin/health";
export * from "./admin/dashboard";
export * from "./admin/stats";
export * from "./admin/pipeline";
export * from "./admin/users";
export * from "./admin/backfills";
export * from "./admin/brand-candidates";
export * from "./admin/brands";
export * from "./admin/cubes";
export * from "./admin/metrics";
export * from "./admin/attribution";
