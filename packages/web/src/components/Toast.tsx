import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * Confirmation that something happened, without a dialog to dismiss.
 *
 * Every action in this app now has a consequence somewhere else — a run starting, a key
 * saved, weights written to disk. Silence after a click reads as a broken button, and the
 * one thing worse than an editor not trusting the pipeline is an editor not trusting the app.
 */

type Tone = 'ok' | 'bad' | 'info';
interface Toast {
  id: number;
  tone: Tone;
  message: string;
}

const ToastCtx = createContext<(message: string, tone?: Tone) => void>(() => {});

export function useToast() {
  return useContext(ToastCtx);
}

export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((message: string, tone: Tone = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'bad' ? 9000 : 4500);
  }, []);

  const value = useMemo(() => push, [push]);

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex w-[min(32rem,90vw)] -translate-x-1/2 flex-col gap-2"
        role="status"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-start gap-2 rounded-md border px-3 py-2 text-[13px] shadow-sm ${
              t.tone === 'ok'
                ? 'border-[#cbe2d4] bg-[#eaf3ed] text-(--color-ok)'
                : t.tone === 'bad'
                  ? 'border-[#e8cdcd] bg-[#f8e9e9] text-(--color-bad)'
                  : 'border-(--color-rule) bg-white text-(--color-ink-2)'
            }`}
          >
            <span aria-hidden>{t.tone === 'ok' ? '✓' : t.tone === 'bad' ? '!' : 'i'}</span>
            <span className="flex-1">{t.message}</span>
            <button
              type="button"
              onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}
              className="text-(--color-ink-3) hover:text-(--color-ink)"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
