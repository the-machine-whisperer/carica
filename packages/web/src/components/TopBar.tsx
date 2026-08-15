import type { ActiveRun, RunSummary, SystemStatus } from '../lib/api';
import type { Route } from '../lib/hooks';
import { Button } from './ui';

/**
 * The chrome that never changes: where you are, what is going on elsewhere, and the one
 * action worth having on every screen.
 *
 * The live indicator sits here rather than inside a run because "is anything happening?"
 * is a question people ask from wherever they are — including from Setup, where the
 * answer decides whether they should be changing anything.
 */
export function TopBar({
  route,
  runs,
  active,
  system,
  onNavigate,
  onNewRun,
}: {
  route: Route;
  runs: RunSummary[];
  active: ActiveRun | null;
  system: SystemStatus | null;
  onNavigate: (r: Route) => void;
  onNewRun: () => void;
}) {
  const activeRun = active?.run_id ? runs.find((r) => r.run_id === active.run_id) : null;
  const awaiting = runs.filter((r) => r.status === 'awaiting_human').length;
  const needsSetup = (system?.checks ?? []).some((c) => c.state === 'blocked');

  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-(--color-rule) bg-(--color-paper-2) px-4 py-2">
      <button
        type="button"
        onClick={() => onNavigate({ name: 'home' })}
        className="flex items-baseline gap-2 rounded text-start"
        aria-label="carica — all runs"
      >
        <span className="font-serif text-lg tracking-tight text-(--color-ink)">carica</span>
        <span className="hidden text-[11px] text-(--color-ink-3) sm:inline">caricature desk</span>
      </button>

      <nav className="flex items-center gap-1" aria-label="Main">
        <NavLink current={route.name === 'home' || route.name === 'run'} onClick={() => onNavigate({ name: 'home' })}>
          Runs
        </NavLink>
        <NavLink current={route.name === 'setup'} onClick={() => onNavigate({ name: 'setup' })}>
          Setup
          {needsSetup && (
            <span
              aria-label="needs attention"
              className="ms-1.5 inline-block size-1.5 rounded-full bg-(--color-bad) align-middle"
            />
          )}
        </NavLink>
      </nav>

      {/* What is happening elsewhere, from anywhere */}
      {active && (
        <button
          type="button"
          onClick={() => active.run_id && onNavigate({ name: 'run', runId: active.run_id })}
          className="flex items-center gap-2 rounded-full border border-(--color-rule) bg-white px-2.5 py-1 text-[11.5px] text-(--color-ink-2) hover:border-(--color-ink-3)/40"
        >
          <span className="live-dot inline-block size-1.5 rounded-full bg-(--color-live)" />
          {active.stopping ? 'stopping' : 'running'}
          <span className="max-w-[14rem] truncate text-(--color-ink-3)">
            {activeRun?.slug ?? active.run_id ?? 'starting…'}
          </span>
        </button>
      )}

      {!active && awaiting > 0 && route.name !== 'run' && (
        <button
          type="button"
          onClick={() => {
            const r = runs.find((x) => x.status === 'awaiting_human');
            if (r) onNavigate({ name: 'run', runId: r.run_id });
          }}
          className="rounded-full border border-[#ecdcb6] bg-[#faf2e0] px-2.5 py-1 text-[11.5px] text-(--color-warn)"
        >
          ⏸ {awaiting} waiting for your approval
        </button>
      )}

      <div className="ms-auto flex items-center gap-2">
        <Button size="sm" variant="primary" onClick={onNewRun} disabled={!!active}>
          New run
        </Button>
      </div>
    </header>
  );
}

function NavLink({ current, onClick, children }: { current: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={current ? 'page' : undefined}
      className={`rounded px-2.5 py-1 text-[13px] transition-colors ${
        current ? 'bg-white text-(--color-ink)' : 'text-(--color-ink-2) hover:bg-white/60'
      }`}
    >
      {children}
    </button>
  );
}
