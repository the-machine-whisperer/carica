import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { activeStage, type RunState } from '@carica/core/browser';
import { api, type ControlAction, type ControlTarget, type RunSummary, type StageInfo, type SystemStatus } from '../lib/api';
import { useRunStream, usePoll, useJobControl } from '../lib/hooks';
import { CONTROL_COPY, RUN_STATUS, STAGE_META, VIEW_COPY, jobTally } from '../lib/copy';
import { StageRail } from '../components/StageRail';
import { RunGraph } from '../components/RunGraph';
import { EventDrawer } from '../components/EventDrawer';
import { RunControls } from '../components/RunControls';
import { ResumePanel } from '../components/ResumePanel';
import { StageView } from '../views';
import { Badge, Button, Modal, Progress } from '../components/ui';
import { useToast } from '../components/Toast';
import { when } from '../lib/format';

/** How to read the agent's latest move in one word. */
const ACTIVITY_VERB: Record<string, string> = {
  command: 'running',
  search: 'searching',
  file: 'writing',
  message: 'says',
  thinking: 'thinking',
  tool: 'using',
  plan: 'planning',
};

type View = 'graph' | 'list';

/**
 * One run, live.
 *
 * The projection is still the only source of truth — this screen accumulates the event
 * stream and reprojects, exactly as before. Two things have changed:
 *
 * 1. **The map is the screen.** A run is a dozen agents working at once, and a vertical
 *    list of eleven steps could not say that. The graph takes the main area and the step
 *    panel sits under it; the old rail is still here as the *List* view, which is where
 *    anyone who wants the eleven steps as eleven lines will find it. One navigation at a
 *    time — never a rail and a map competing for the same click.
 * 2. **The run can be steered.** Pause, resume, stop, and stopping a single job all go
 *    through `useJobControl`; nothing here holds a copy of what it believes the run is
 *    doing. The reply to a control request is a receipt, and the event stream is the answer.
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
  const toast = useToast();
  const { events, state, connected } = useRunStream(runId);
  const [stageId, setStageId] = useState<string | null>(routeStageId ?? null);
  const pinned = useRef(!!routeStageId);
  const [view, setView] = useState<View>(readView);
  /** The milestone picker: `undefined` is closed, a step id (or `null`) is open at that step. */
  const [resumeFrom, setResumeFrom] = useState<string | null | undefined>(undefined);

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

  /**
   * Which view, in the address bar.
   *
   * `useHashRoute` owns `#/run/<id>/<step>` and ignores anything after it, so the view goes
   * on the end as a third segment and is written with `replaceState` — no hashchange, no
   * re-parse, and a link to a particular view survives a reload. The last-used view is also
   * remembered locally, so opening a run without a view in the address gets the one you were
   * using rather than a reset.
   */
  useEffect(() => {
    try {
      window.localStorage.setItem(VIEW_KEY, view);
    } catch {
      /* private mode; the address bar still carries it */
    }
    const hash = `#/run/${encodeURIComponent(runId)}/${routeStageId ?? ''}/${view}`;
    if (window.location.hash !== hash) window.history.replaceState(null, '', hash);
  }, [view, runId, routeStageId]);

  const selected = stageId ?? suggested;
  const active = !!detail?.active;
  const interrupted = !!detail?.interrupted;
  const paused = !!state.paused;
  const statusKey = interrupted ? 'interrupted' : paused && state.status === 'running' ? 'paused' : state.status;
  const status = RUN_STATUS[statusKey] ?? RUN_STATUS.unknown;
  const done = state.order.filter((id) => ['ok', 'skipped'].includes(state.stages[id].status)).length;
  const tally = jobTally(state.jobTotals);
  const heldSteps = (state.pausedStages ?? []).length;

  // ---- steering ---------------------------------------------------------
  const { control, error: controlError } = useJobControl(runId);
  const [confirming, setConfirming] = useState<null | {
    copy: { title: string; body: string; confirm: string };
    resolve: (ok: boolean) => void;
  }>(null);
  const lastError = useRef<string | null>(null);

  useEffect(() => {
    if (controlError && controlError !== lastError.current) {
      lastError.current = controlError;
      toast(controlError, 'bad');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlError]);

  const onControl = useCallback(
    async (action: ControlAction, target: ControlTarget) => {
      // Stopping one step or one job is confirmed in place, on the tile, by the map. Taking
      // the whole run down is the one that arrives here unasked, and it is not undoable.
      if (action === 'kill' && target.kind === 'run') {
        const ok = await new Promise<boolean>((resolve) => setConfirming({ copy: CONTROL_COPY.confirmKillRun, resolve }));
        if (!ok) return;
      }
      try {
        await control(action, target);
        toast(CONTROL_COPY[action].ack, 'info');
      } catch (e: any) {
        const message = String(e?.message ?? e);
        lastError.current = message;
        toast(message, 'bad');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [control]
  );

  const openResume = (from: string | null) => setResumeFrom(from);

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
              {/* What a step list cannot say: how much is happening at once, right now. */}
              {tally && <span className="tabular-nums text-(--color-ink-2)">{tally}</span>}
              {!paused && heldSteps > 0 && (
                <span className="text-(--color-warn)">{CONTROL_COPY.pausedStepsNote(heldSteps)}</span>
              )}
              {state.model && <span>{state.model}</span>}
              <span className="flex items-center gap-1.5" title={connected ? 'Following this run live' : 'Reconnecting…'}>
                <span className={`inline-block size-1.5 rounded-full ${connected ? 'bg-(--color-live) live-dot' : 'bg-[#c9c4b8]'}`} />
                {connected ? 'live' : 'offline'}
              </span>
            </div>
          </div>

          <div className="ms-auto flex flex-wrap items-center gap-2">
            <ViewToggle view={view} onChange={setView} />
            <RunControls
              run={summary}
              state={state}
              active={active}
              interrupted={interrupted}
              paused={paused}
              system={system}
              stages={stages}
              onOpenRun={onOpenRun}
              onResume={openResume}
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

        {/* The most recent thing an agent actually did, always visible while a run is going,
            so "is this working?" is answerable without opening anything. */}
        {state.status === 'running' && !paused && state.lastActivity && (
          <div className="mt-1.5 flex items-baseline gap-2 text-[11.5px] text-(--color-ink-3)">
            <span className="live-dot shrink-0 text-[9px] text-(--color-live)">●</span>
            <span className="shrink-0">{ACTIVITY_VERB[state.lastActivity.kind] ?? 'working'}</span>
            <span className="min-w-0 truncate font-mono text-[11px] text-(--color-ink-2)">
              {state.lastActivity.text}
            </span>
          </div>
        )}
      </header>

      {/* ---- a paused run says so, loudly ---------------------------------- */}
      {paused && (
        <div className="flex flex-wrap items-center gap-3 border-b border-[#ecdcb6] bg-[#faf2e0] px-4 py-2.5 text-[12.5px] text-(--color-warn)">
          <span className="live-dot text-[13px]">⏸</span>
          <span className="font-medium">{CONTROL_COPY.pausedBanner.title}</span>
          <span className="min-w-0 text-(--color-ink-2)">{CONTROL_COPY.pausedBanner.body}</span>
          <Button
            size="sm"
            variant="primary"
            className="ms-auto"
            onClick={() => onControl('resume', { kind: 'run' })}
          >
            {CONTROL_COPY.pausedBanner.action}
          </Button>
        </div>
      )}

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
          This run stopped when the app was last closed. Everything it finished is kept —{' '}
          <button
            type="button"
            onClick={() => openResume(state.failedStage ?? null)}
            className="font-medium underline underline-offset-2 hover:text-(--color-ink)"
          >
            carry it on from a step of your choosing
          </button>
          .
        </div>
      )}

      {state.status === 'failed' && <FailureBanner state={state} onResume={openResume} />}

      {/* ---- the run itself -------------------------------------------------
          Map view: the graph has the room, the chosen step's panel sits under it.
          List view: the eleven steps as a rail, exactly as before. */}
      {view === 'graph' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* The graph draws itself at whatever size it is given and expects the room to
              scroll — eleven steps of fan-out is taller than any pane on a laptop. */}
          <section
            aria-label="Run map"
            className="scrollbar-thin min-h-[220px] flex-[3] overflow-y-auto border-b border-(--color-rule) bg-(--color-paper-2) px-6 py-5"
          >
            <RunGraph
              state={state}
              stages={stages}
              runId={runId}
              selected={selected}
              onSelect={select}
              onControl={onControl}
              onResumeFrom={(stage) => openResume(stage)}
              active={active}
            />
          </section>
          <section className="scrollbar-thin min-h-0 flex-[2] overflow-y-auto px-6 py-5">
            <StageView stageId={selected} runId={runId} state={state} />
          </section>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="w-60 shrink-0 border-e border-(--color-rule) bg-(--color-paper-2)">
            <StageRail state={state} selected={selected} onSelect={select} />
          </aside>
          <main className="scrollbar-thin min-w-0 flex-1 overflow-y-auto px-6 py-5">
            <StageView stageId={selected} runId={runId} state={state} />
          </main>
        </div>
      )}

      <EventDrawer events={events} />

      {resumeFrom !== undefined && (
        <ResumePanel
          runId={runId}
          slug={summary?.slug}
          state={state}
          initialFrom={resumeFrom}
          running={active}
          onClose={() => setResumeFrom(undefined)}
          onResumed={(id) => {
            setResumeFrom(undefined);
            reloadDetail();
            onRunsChanged();
            onOpenRun(id);
          }}
        />
      )}

      {confirming && (
        <Modal
          title={confirming.copy.title}
          onClose={() => {
            confirming.resolve(false);
            setConfirming(null);
          }}
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  confirming.resolve(false);
                  setConfirming(null);
                }}
              >
                {CONTROL_COPY.cancel}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  confirming.resolve(true);
                  setConfirming(null);
                }}
              >
                {confirming.copy.confirm}
              </Button>
            </>
          }
        >
          <p className="text-[13px] leading-relaxed text-(--color-ink-2)">{confirming.copy.body}</p>
        </Modal>
      )}
    </div>
  );
}

/**
 * Why the run stopped, at the top of the screen, without asserting anything it does not know.
 *
 * This banner used to say one sentence for every failure: "A step could not produce a usable
 * result. It was retried twice with the exact errors before stopping. Open that step to see
 * what it was asked to fix." When the run died without naming a step, all three claims were
 * wrong at once — no step was named, nothing had been retried, and the step it invited you to
 * open had nothing in it. That is the message an editor was left staring at, so the only
 * thing they could do was open Continue and read the reuse policy instead.
 *
 * Three cases, three honest messages. The reason recorded on `run.end` is shown whenever
 * there is one, because in the un-named case it is the entire account of what happened.
 */
function FailureBanner({ state, onResume }: { state: RunState; onResume: (stage: string | null) => void }) {
  const failed = state.failedStage ? state.stages[state.failedStage] : null;
  const title = STAGE_META[state.failedStage ?? '']?.title ?? null;
  const retries = failed?.retries.length ?? 0;

  return (
    <div className="border-b border-[#e8cdcd] bg-[#f8e9e9] px-4 py-2 text-[12.5px] text-(--color-bad)">
      <span className="font-medium">
        {!title
          ? 'The run stopped before it could say which step failed.'
          : failed?.crashed
            ? `${title} could not start — the app hit a bug.`
            : `${title} could not produce a usable result.`}
      </span>{' '}
      {/* Written as a clause by whoever recorded it ("the run process exited…"), shown here
          as a sentence of its own. */}
      {state.endReason && <span>{state.endReason.charAt(0).toUpperCase() + state.endReason.slice(1)}. </span>}
      {title ? (
        <>
          {retries > 0 &&
            `It was retried ${retries === 1 ? 'once' : `${retries} times`} before stopping. `}
          Open that step for the details, or{' '}
        </>
      ) : (
        <>Nothing was recorded against a step, so there is nothing to open. You can{' '}</>
      )}
      <button
        type="button"
        onClick={() => onResume(state.failedStage ?? null)}
        className="font-medium underline underline-offset-2 hover:text-(--color-ink)"
      >
        carry the run on from {title ? 'there' : 'a step of your choosing'}
      </button>
      .
    </div>
  );
}

const VIEW_KEY = 'carica.runView';

/** The view in the address bar (`#/run/<id>/<step>/<view>`), or the last one used. */
function readView(): View {
  const parts = window.location.hash.replace(/^#\/?/, '').split('/');
  const fromHash = parts[0] === 'run' ? parts[3] : undefined;
  if (fromHash === 'graph' || fromHash === 'list') return fromHash;
  try {
    const stored = window.localStorage.getItem(VIEW_KEY);
    if (stored === 'graph' || stored === 'list') return stored;
  } catch {
    /* private mode */
  }
  return 'graph';
}

function ViewToggle({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  return (
    <div role="group" aria-label="How to show this run" className="flex rounded-md border border-(--color-rule) bg-white p-0.5">
      {(['graph', 'list'] as const).map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={view === v}
          title={VIEW_COPY[v].hint}
          onClick={() => onChange(v)}
          className={`rounded px-2 py-0.5 text-[12px] transition-colors ${
            view === v ? 'bg-(--color-paper-2) font-medium text-(--color-ink)' : 'text-(--color-ink-3) hover:text-(--color-ink)'
          }`}
        >
          {VIEW_COPY[v].label}
        </button>
      ))}
    </div>
  );
}
