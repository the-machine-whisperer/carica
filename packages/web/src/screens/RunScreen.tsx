import { useEffect, useMemo, useRef, useState } from 'react';
import { activeStage } from '@carica/core/browser';
import { api, type RunSummary, type StageInfo, type SystemStatus } from '../lib/api';
import { useRunStream, usePoll } from '../lib/hooks';
import { RUN_STATUS, STAGE_META } from '../lib/copy';
import { StageRail } from '../components/StageRail';
import { EventDrawer } from '../components/EventDrawer';
import { RunControls } from '../components/RunControls';
import { StageView } from '../views';
import { Badge, Button, Progress } from '../components/ui';
import { when } from '../lib/format';

/**
 * One run, live.
 *
 * The projection is still the only source of truth — this screen accumulates the event
 * stream and reprojects, exactly as before. What is new is that the run can be steered
 * from here rather than from a terminal in another window.
 */
export function RunScreen({
  runId,
  routeStageId,
  runs,
  system,
  stages,
  onBack,
  onOpenRun,
  onSelectStage,
  onRunsChanged,
}: {
  runId: string;
  /** The step in the address bar, if the user linked straight to one. */
  routeStageId?: string;
  runs: RunSummary[];
  system: SystemStatus | null;
  stages: StageInfo[];
  onBack: () => void;
  onOpenRun: (id: string) => void;
  onSelectStage: (stageId: string) => void;
  onRunsChanged: () => void;
}) {
  const { events, state, connected } = useRunStream(runId);
  const [stageId, setStageId] = useState<string | null>(routeStageId ?? null);
  const pinned = useRef(!!routeStageId);

  // Detail the event stream cannot carry: whether a process is still behind this run.
  const { data: detail, reload: reloadDetail } = usePoll(() => api.run(runId), 6000, [runId]);
  const summary = runs.find((r) => r.run_id === runId) ?? null;

  // Follow the run until the user picks a step themselves, then stop moving under them.
  const suggested = useMemo(() => (state.eventCount ? activeStage(state) : 'outlets'), [state]);
  useEffect(() => {
    if (!pinned.current) setStageId(suggested);
  }, [suggested]);

  // Linking straight to a step pins it; otherwise the panel follows the run.
  useEffect(() => {
    if (routeStageId && routeStageId !== stageId) {
      pinned.current = true;
      setStageId(routeStageId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeStageId]);

  const select = (id: string) => {
    pinned.current = true;
    setStageId(id);
    onSelectStage(id);
  };

  // A run that finishes or pauses changes what the controls should offer.
  useEffect(() => {
    reloadDetail();
    onRunsChanged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status]);

  const selected = stageId ?? suggested;
  const active = !!detail?.active;
  const interrupted = !!detail?.interrupted;
  const statusKey = interrupted ? 'interrupted' : state.status;
  const status = RUN_STATUS[statusKey] ?? RUN_STATUS.unknown;
  const done = state.order.filter((id) => ['ok', 'skipped'].includes(state.stages[id].status)).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ---- run header ---------------------------------------------------- */}
      <header className="border-b border-(--color-rule) bg-(--color-paper-2) px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button size="sm" variant="ghost" onClick={onBack}>
            ← All runs
          </Button>

          <div className="min-w-0">
            <h1 className="flex flex-wrap items-baseline gap-2">
              <span className="font-serif text-[17px] text-(--color-ink)">{summary?.slug ?? runId}</span>
              <Badge tone={status.tone} title={status.hint}>
                {status.label}
              </Badge>
              {state.mode === 'replay' && (
                <Badge tone="neutral" title="A rehearsal on saved data. No internet, no models, no cost.">
                  practice
                </Badge>
              )}
            </h1>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[11.5px] text-(--color-ink-3)">
              <span>{when(state.startedAt ?? summary?.created_at)}</span>
              <span className="tabular-nums">
                {done} of {state.order.length} steps done
              </span>
              {state.model && <span>{state.model}</span>}
              <span className="flex items-center gap-1.5" title={connected ? 'Following this run live' : 'Reconnecting…'}>
                <span className={`inline-block size-1.5 rounded-full ${connected ? 'bg-(--color-live) live-dot' : 'bg-[#c9c4b8]'}`} />
                {connected ? 'live' : 'offline'}
              </span>
            </div>
          </div>

          <div className="ms-auto">
            <RunControls
              run={summary}
              state={state}
              active={active}
              interrupted={interrupted}
              system={system}
              stages={stages}
              onOpenRun={onOpenRun}
              onChanged={() => {
                reloadDetail();
                onRunsChanged();
              }}
            />
          </div>
        </div>

        <div className="mt-2">
          <Progress done={done} total={state.order.length} tone={state.status === 'failed' ? 'bad' : state.status === 'complete' ? 'ok' : 'accent'} />
        </div>
      </header>

      {/* ---- what needs a human, said once, at the top ---------------------- */}
      {state.humanRequired && selected !== 'publish' && (
        <button
          type="button"
          onClick={() => select('publish')}
          className="flex items-center gap-2 border-b border-[#ecdcb6] bg-[#faf2e0] px-4 py-2 text-start text-[12.5px] text-(--color-warn) hover:bg-[#f7ecd6]"
        >
          <span className="live-dot">⏸</span>
          <span className="font-medium">This run is waiting for your approval.</span>
          <span className="text-(--color-ink-2)">{state.humanRequired.message}</span>
          <span className="ms-auto underline underline-offset-2">Go to the approval step →</span>
        </button>
      )}

      {interrupted && (
        <div className="border-b border-[#ecdcb6] bg-[#faf2e0] px-4 py-2 text-[12.5px] text-(--color-warn)">
          This run stopped when the app was last closed. Everything it finished is kept — use{' '}
          <span className="font-medium">Continue</span> to carry on from where it got to.
        </div>
      )}

      {state.status === 'failed' && (
        <div className="border-b border-[#e8cdcd] bg-[#f8e9e9] px-4 py-2 text-[12.5px] text-(--color-bad)">
          <span className="font-medium">
            {STAGE_META[state.failedStage ?? '']?.title ?? 'A step'} could not produce a usable result.
          </span>{' '}
          It was retried twice with the exact errors before stopping. Open that step to see what it was asked to fix.
        </div>
      )}

      {/* ---- rail + panel --------------------------------------------------- */}
      <div className="flex min-h-0 flex-1">
        <aside className="w-60 shrink-0 border-e border-(--color-rule) bg-(--color-paper-2)">
          <StageRail state={state} selected={selected} onSelect={select} />
        </aside>

        <main className="scrollbar-thin min-w-0 flex-1 overflow-y-auto px-6 py-5">
          <StageView stageId={selected} runId={runId} state={state} />
        </main>
      </div>

      <EventDrawer events={events} />
    </div>
  );
}
