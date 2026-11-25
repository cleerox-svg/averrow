import { useCallback } from 'react';
import { useLocation, useSearchParams, type NavigateOptions, type URLSearchParamsInit } from 'react-router-dom';

type SetParams = (
  next: URLSearchParamsInit | ((prev: URLSearchParams) => URLSearchParamsInit),
  options?: NavigateOptions,
) => void;

/**
 * `useSearchParams` whose REPLACE writes keep the current entry's history state
 * (an open overlay's marker). A bare `setSearchParams(…, { replace: true })`
 * drops it, which makes the overlay read as closed and loses its pop. A push
 * starts a new entry, so it carries nothing unless `state` is passed.
 */
export function useSetSearchParamsKeepState(): [URLSearchParams, SetParams] {
  const [params, setParams] = useSearchParams();
  const { state } = useLocation();
  const set = useCallback<SetParams>((next, options) => {
    setParams(next, options?.replace && options.state === undefined ? { ...options, state } : options);
  }, [setParams, state]);
  return [params, set];
}
