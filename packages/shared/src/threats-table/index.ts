// Shared advanced Threats table — public surface. Used by both the ops
// SPA (all brands, full enrichment) and the tenant app (their brands,
// curated columns). Same module; only the data + chosen columns differ.

export { ThreatsTable } from './ThreatsTable';
export { useThreatsTable } from './useThreatsTable';
export type { UseThreatsTableOptions } from './useThreatsTable';
export type {
  ThreatRow, ThreatColumnKey, ThreatsTableState, ThreatsQueryParams,
  ThreatsTableProps, FilterControl, SelectOption, SortDir,
} from './types';
