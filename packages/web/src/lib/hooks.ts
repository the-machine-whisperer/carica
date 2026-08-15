import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { projectRun, type RunState } from '@carica/core/browser';
import { api } from './api';

/**
 * Live run state over SSE.
 *
 * The app holds no state of its own — it accumulates the event log and reprojects.
 * That is why a reload loses nothing and why a finished run replays identically: the
 * run directory is the only source of truth.
 *
 * EventSource reconnects on its own; we pass the last seq we saw so a reconnect resumes
 * instead of replaying, and a client joining an in-flight run still gets everything from t0.
 */
export function useRunStream(runId: string | null) {
  const [events, setEvents] = useState<any[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastSeq = useRef(0);

  useEffect(() => {
    setEvents([]);
    setError(null);
    lastSeq.current = 0;
    if (!runId) return;

    let closed = false;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed) return;
      es = new EventSource(api.eventsUrl(runId, lastSeq.current));

      es.onopen = () => {
        setConnected(true);
        setError(null);
      };

      es.onmessage = (ev) => {
        // Named events also arrive here only if no specific listener is attached;
        // we listen generically below instead.
        void ev;
      };

      const onAny = (ev: MessageEvent) => {
        try {
          const e = JSON.parse(ev.data);
          if (typeof e.seq === 'number') lastSeq.current = Math.max(lastSeq.current, e.seq);
          setEvents((prev) => [...prev, e]);
        } catch {
          /* ignore a malformed frame rather than tearing down the stream */
        }
      };

      for (const type of [
        'run.start', 'run.end', 'stage.start', 'stage.progress', 'stage.end', 'stage.error',
        'agent.spawn', 'agent.output', 'agent.retry', 'artifact.write', 'evidence.write',
        'gate.verdict', 'human.required', 'human.decision', 'message',
      ]) {
        es.addEventListener(type, onAny as EventListener);
      }

      es.onerror = () => {
        setConnected(false);
        es?.close();
        // EventSource's own retry is fine, but we rebuild to carry an updated lastEventId.
        if (!closed) retryTimer = setTimeout(connect, 2000);
      };
    };

    connect();
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      es?.close();
      setConnected(false);
    };
  }, [runId]);

  const state: RunState = useMemo(() => projectRun(events), [events]);
  return { events, state, connected, error };
}

/** Fetch an artifact once per (run, name); refetch when the stage completes again. */
export function useArtifact<T = any>(runId: string | null, name: string | null, version: unknown = 0) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!runId || !name) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .artifact<T>(runId, name)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) {
          setData(null);
          setError(String(e.message ?? e));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, name, version]);

  return { data, loading, error };
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const run = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    fn()
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(String(e.message ?? e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(run, [run]);
  return { data, error, loading, reload: run };
}

/**
 * Re-run `fn` on an interval as well as on mount.
 *
 * Used for the things SSE cannot tell us because they are not part of any one run:
 * whether a run is active at all, and whether this machine is set up to do a live one.
 * Polling stops while the tab is hidden — a newsroom leaves this open all day.
 */
export function usePoll<T>(fn: () => Promise<T>, ms: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const tick = useCallback(async () => {
    try {
      const d = await fnRef.current();
      setData(d);
      setError(null);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (!cancelled && !document.hidden) void tick();
    };
    run();
    const id = setInterval(run, ms);
    document.addEventListener('visibilitychange', run);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', run);
    };
  }, [tick, ms]);

  return { data, error, loading, reload: tick };
}

export type Route =
  | { name: 'home' }
  | { name: 'run'; runId: string; stageId?: string }
  | { name: 'setup' };

/** `#/run/<id>/<step>` — the step is part of the address so it can be linked and reloaded. */
export function routeHash(r: Route): string {
  if (r.name === 'home') return '#/';
  if (r.name === 'setup') return '#/setup';
  return `#/run/${encodeURIComponent(r.runId)}${r.stageId ? `/${r.stageId}` : ''}`;
}

/**
 * Hash routing, so the back button and a reload both do what a browser user expects
 * without pulling in a router. Three screens do not need more than this.
 */
export function useHashRoute(): [Route, (r: Route) => void] {
  const parse = (): Route => {
    const h = window.location.hash.replace(/^#\/?/, '');
    if (h.startsWith('run/')) {
      const [runId, stageId] = h.slice(4).split('/');
      return { name: 'run', runId: decodeURIComponent(runId), stageId: stageId || undefined };
    }
    if (h === 'setup') return { name: 'setup' };
    return { name: 'home' };
  };

  const [route, setRoute] = useState<Route>(parse);

  useEffect(() => {
    const onChange = () => setRoute(parse());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = useCallback((r: Route) => {
    const hash = routeHash(r);
    if (window.location.hash === hash) setRoute(r);
    else window.location.hash = hash;
  }, []);

  return [route, navigate];
}

export function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = useCallback(async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1600);
    } catch {
      /* clipboard blocked — the text is still selectable on screen */
    }
  }, []);
  return { copied, copy };
}
