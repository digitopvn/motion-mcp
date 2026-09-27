import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, isAbortError } from "./api.ts";
import { api } from "./client.ts";

export interface ApiState<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  /** Refetch; the previous data stays visible while the request runs. */
  reload: () => void;
  setData: (update: (current: T | undefined) => T | undefined) => void;
}

/** GETs `path` (skipped when null) and refetches whenever the path changes or `reload` is called. */
export function useApi<T>(path: string | null): ApiState<T> {
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(path !== null);
  const [nonce, setNonce] = useState(0);
  const lastPath = useRef(path);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `nonce` is a manual refetch trigger.
  useEffect(() => {
    // A different resource must not show the previous one's data or error while it loads.
    if (lastPath.current !== path) {
      lastPath.current = path;
      setDataState(undefined);
      setError(undefined);
    }
    if (path === null) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    api
      .get<T>(path, { signal: controller.signal })
      .then((result) => {
        setDataState(result);
        setError(undefined);
      })
      .catch((err: unknown) => {
        if (!isAbortError(err)) setError(errorMessage(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { data, error, loading, reload, setData: setDataState };
}

/** Tracks one in-flight mutation so buttons can disable themselves and show its error. */
export function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const run = useCallback(async <R>(action: () => Promise<R>): Promise<R | undefined> => {
    setPending(true);
    setError(undefined);
    try {
      return await action();
    } catch (err) {
      setError(errorMessage(err));
      return undefined;
    } finally {
      setPending(false);
    }
  }, []);

  return { pending, error, setError, run };
}

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · Motion MCP`;
  }, [title]);
}
