import { useMediaQuery } from '../hooks/useMediaQuery';

/** Phones + coarse-pointer tablets in portrait: overlays become bottom sheets. */
export const COMPACT_QUERY = '(max-width: 767px), (pointer: coarse) and (max-width: 1023px)';

/** True when overlays should present as bottom sheets. */
export function useIsCompact(): boolean {
  return useMediaQuery(COMPACT_QUERY);
}
