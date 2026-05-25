// Shared state hook for the advanced Threats table.
//
// Owns the filter / sort / search / pagination state. Each app feeds
// `params` into its own React Query hook (different endpoints, same
// shape) and passes the results back into <ThreatsTable>.

import { useCallback, useMemo, useState } from 'react';
import type { SortDir, ThreatsTableState, ThreatsQueryParams } from './types';

export interface UseThreatsTableOptions {
  pageSize?:    number;
  initialSort?: { key: string; dir: SortDir };
  initial?:     Partial<ThreatsTableState>;
}

const DEFAULT: ThreatsTableState = {
  q: '', severity: '', type: '', status: '', brandId: '', country: '',
  sort: 'severity', dir: 'desc', page: 0,
};

export function useThreatsTable(opts: UseThreatsTableOptions = {}) {
  const pageSize = opts.pageSize ?? 50;
  const [state, setState] = useState<ThreatsTableState>({
    ...DEFAULT,
    ...(opts.initialSort ? { sort: opts.initialSort.key, dir: opts.initialSort.dir } : {}),
    ...opts.initial,
  });

  // Any filter/search change resets to page 0.
  const setFilter = useCallback((patch: Partial<ThreatsTableState>) => {
    setState((s) => ({ ...s, ...patch, page: 0 }));
  }, []);

  const setSearch = useCallback((q: string) => {
    setState((s) => ({ ...s, q, page: 0 }));
  }, []);

  const toggleSort = useCallback((key: string) => {
    setState((s) => s.sort === key
      ? { ...s, dir: s.dir === 'asc' ? 'desc' : 'asc', page: 0 }
      : { ...s, sort: key, dir: 'desc', page: 0 });
  }, []);

  const setPage = useCallback((page: number) => {
    setState((s) => ({ ...s, page: Math.max(0, page) }));
  }, []);

  const params: ThreatsQueryParams = useMemo(() => ({
    ...state, limit: pageSize, offset: state.page * pageSize,
  }), [state, pageSize]);

  return { state, params, pageSize, setFilter, setSearch, toggleSort, setPage };
}
