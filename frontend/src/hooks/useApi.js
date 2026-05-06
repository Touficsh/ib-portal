import { useEffect, useState, useCallback, useRef } from 'react';
import { api, clearSession, ApiError } from '../api.js';

/**
 * Fetch hook for portal endpoints.
 *
 * const { data, error, loading, refetch, dataAt } = useApi('/clients', { query: {...} });
 *
 * - Auto-fetches on mount and whenever `deps` change.
 * - `refetch()` returns a promise so callers can await it after mutations.
 * - On 401/403, clears the session + reloads (kicks user back to /login).
 * - `dataAt` is a Date set every time data updates — handy for showing
 *   a "last updated X ago" badge with auto-refresh.
 */
export function useApi(path, opts = {}, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  // If path is null/false, the hook idles — useful for gating a request on a
  // feature flag or a condition ("only fetch if I'm an agent"). Starts with
  // loading=false in that case so UIs don't show a spinner that never resolves.
  const [loading, setLoading] = useState(!!path);
  const [dataAt, setDataAt] = useState(null);
  const mounted = useRef(true);

  const run = useCallback(async () => {
    if (!path) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const res = await api(path, opts);
      if (mounted.current) {
        setData(res);
        setDataAt(new Date());
      }
      return res;
    } catch (err) {
      // Only 401 = bad/expired token → log out and bounce to /login.
      // 403 = authenticated but missing permission for THIS resource → keep
      // the session, surface the error to the caller so it can render an
      // "access denied" state instead of kicking the user out entirely.
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        window.location.assign('/portal/login');
        return;
      }
      if (mounted.current) setError(err);
      throw err;
    } finally {
      if (mounted.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    mounted.current = true;
    run().catch(() => {});
    return () => { mounted.current = false; };
  }, [run]);

  return { data, error, loading, refetch: run, dataAt };
}

/**
 * Imperative API call — for form submissions / mutations. Returns [call, state].
 *
 * const [save, { loading, error }] = useMutation();
 * save('/shares', { method: 'POST', body: {...} });
 */
export function useMutation() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const call = useCallback(async (path, opts = {}) => {
    setLoading(true);
    setError(null);
    try {
      return await api(path, opts);
    } catch (err) {
      setError(err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return [call, { loading, error }];
}

/**
 * Periodically calls `refetch` so a useApi-backed view stays fresh without
 * a manual reload. Pauses while the document is hidden (browser tab in the
 * background) so we don't churn the network for nothing, and re-fires once
 * on the visibilitychange back to "visible" so the user sees current data
 * the moment they return to the tab.
 *
 *   const { data, refetch } = useApi('/dashboard');
 *   useAutoRefresh(refetch, 30_000);   // keep dashboard fresh every 30s
 */
export function useAutoRefresh(refetch, intervalMs = 30_000) {
  useEffect(() => {
    if (!refetch || !intervalMs) return;
    let timer = null;
    function start() {
      if (timer) return;
      timer = setInterval(() => {
        // Skip silently if the call fails — the next tick will retry.
        Promise.resolve(refetch()).catch(() => {});
      }, intervalMs);
    }
    function stop() {
      if (timer) { clearInterval(timer); timer = null; }
    }
    function onVisibility() {
      if (document.hidden) {
        stop();
      } else {
        // Fire once immediately on tab focus so the user doesn't wait
        // up to intervalMs to see fresh data.
        Promise.resolve(refetch()).catch(() => {});
        start();
      }
    }
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refetch, intervalMs]);
}
