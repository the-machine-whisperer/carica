import { useEffect, useMemo, useState } from 'react';
import type { RunState } from '@carica/core/browser';
import { api, type RunSummary } from '../lib/api';

/** Whatever the client hands back for a checkpoint, named once here rather than re-declared. */
type Checkpoint = NonNullable<Awaited<ReturnType<typeof api.checkpoint>>>;
import { RESUME_COPY, STAGE_IDS, STAGE_META } from '../lib/copy';
import { Button, Loading, Modal } from './ui';
import { useToast } from './Toast';
import { clock } from '../lib/format';

/**
 * Where to pick a stopped run back up.
 *
 * Every run writes what it produces into its own folder as it goes, so a run that stopped
 * at step 7 is not a loss — it is seven steps of finished work and a place to start from.
 * This panel is the editorial reading of that folder: the steps that have a result, when
 * they finished, and what carrying on from each one would actually cost.
 *
 * Three things it is careful about:
 *
 * 1. **It tells the truth about what the pipeline does.** Carrying on from step 5 re-runs
 *    step 5 and everything after it; the steps before are reused *if their results still
 *    pass their checks*, and re-run if they do not. That is stated on the screen where the
 *    choice is made, not in a tooltip.
 * 2. **It is not the same as starting a new run part way through.** That flow (Start a run
 *    → "Start at") copies another run's results into a *new* folder. This one keeps the run
 *    id, so the record stays one continuous story. The distinction is said out loud below.
 * 3. **It works without a checkpoint file.** Older runs never wrote one, and their
 *    artifacts are on disk regardless — so the list falls back to the run's own event
 *    projection, or to the summary the runs list already carries.
 */
export function ResumePanel({
  runId,
  slug,
  state,
  stageSummary,
  initialFrom,
  running = false,
  onClose,
  onResumed,
}: {
  runId: string;
  slug?: string | null;
  /** The live projection, when the caller has one. The run screen does; the home screen does not. */
  state?: RunState | null;
  /** What the runs list knows, used when there is neither a checkpoint nor a projection. */
  stageSummary?: RunSummary['stage_summary'];
  /** Where the caller thinks it should pick up — the step that failed, usually. */
  initialFrom?: string | null;
  /** A run still going cannot be carried on; it has not stopped yet. */
  running?: boolean;
  onClose: () => void;
  onResumed: (runId: string) => void;
}) {
  const toast = useToast();
  const [checkpoint, setCheckpoint] = useState<Checkpoint | null>(null);
  const [loading, setLoading] = useState(true);
  const [from, setFrom] = useState<string | null>(initialFrom ?? null);
  const [retryKilled, setRetryKilled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api
      .checkpoint(runId)
      // A run from before checkpoints existed simply has none. That is not an error, and
      // the artifacts it wrote are on disk either way.
      .catch(() => null)
      .then((c) => {
        if (!live) return;
        setCheckpoint(c);
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [runId]);

  const points = useMemo(
    () => resumePoints({ checkpoint, state: state ?? null, stageSummary: stageSummary ?? null }),
    [checkpoint, state, stageSummary]
  );

  // Default to where the run actually stopped, and never to a step it cannot start at.
  const fallbackFrom = useMemo(() => {
    const wanted = initialFrom && points.find((p) => p.stage === initialFrom && p.resumable);
    if (wanted) return wanted.stage;
    const unfinished = points.find((p) => p.resumable && p.status !== 'ok' && p.status !== 'skipped');
    return unfinished?.stage ?? points.find((p) => p.resumable)?.stage ?? null;
  }, [points, initialFrom]);

  const selected = (from && points.some((p) => p.stage === from && p.resumable) ? from : fallbackFrom) ?? null;
  const selectedPoint = points.find((p) => p.stage === selected) ?? null;
  const before = selected ? points.findIndex((p) => p.stage === selected) : 0;

  const killed = useMemo(() => {
    const ids = new Set<string>([...(checkpoint?.control?.killed_jobs ?? []), ...(state?.killedJobs ?? [])]);
    return [...ids];
  }, [checkpoint, state]);

  async function carryOn() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.resumeRun(runId, selected, { retryKilled });
      toast(RESUME_COPY.ack, 'ok');
      onResumed(res.run_id ?? runId);
    } catch (e: any) {
      setError(String(e?.message ?? e));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={RESUME_COPY.title}
      description={
        <>
          {RESUME_COPY.description}
          {slug && <span className="ms-1 text-(--color-ink-2)">({slug})</span>}
        </>
      }
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={carryOn} busy={busy} disabled={!selected || running}>
            {selectedPoint ? RESUME_COPY.action(selectedPoint.title) : RESUME_COPY.title}
          </Button>
        </>
      }
    >
      {running && (
        <p className="mb-4 rounded-md border border-[#ecdcb6] bg-[#faf2e0] px-3 py-2 text-[13px] text-(--color-warn)">
          {RESUME_COPY.running}
        </p>
      )}

      {loading && <Loading what="what this run has on disk" />}

      {!loading && points.every((p) => !p.resumable) && (
        <p className="text-[13px] text-(--color-ink-2)">{RESUME_COPY.empty}</p>
      )}

      {!loading && points.some((p) => p.resumable) && (
        <>
          <fieldset>
            <legend className="mb-2 text-[13px] font-medium text-(--color-ink)">{RESUME_COPY.chooseLabel}</legend>
            <ul className="space-y-1">
              {points.map((p) => (
                <li key={p.stage}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={p.stage === selected}
                    disabled={!p.resumable}
                    onClick={() => setFrom(p.stage)}
                    className={`flex w-full items-baseline gap-3 rounded-md border px-3 py-2 text-start transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      p.stage === selected
                        ? 'border-(--color-accent) bg-white ring-1 ring-(--color-accent)'
                        : 'border-(--color-rule) bg-white/60 hover:bg-white'
                    }`}
                  >
                    <span className="w-14 shrink-0 text-[11px] tabular-nums text-(--color-ink-3)">
                      Step {String(p.n).padStart(2, '0')}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13.5px] text-(--color-ink)">{p.title}</span>
                      <span className="mt-0.5 block text-[11.5px] text-(--color-ink-3)">
                        {!p.resumable ? RESUME_COPY.notResumable : describe(p)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </fieldset>

          {selectedPoint && (
            <div className="mt-4 rounded-md border border-(--color-rule) bg-(--color-paper-2) px-3 py-2.5">
              <p className="text-[13px] leading-relaxed text-(--color-ink-2)">
                {RESUME_COPY.consequence(selectedPoint.title, before)}
              </p>
              <p className="mt-1.5 text-[12px] leading-relaxed text-(--color-ink-3)">{RESUME_COPY.revalidation}</p>
            </div>
          )}

          {killed.length > 0 && (
            <section className="mt-4 border-t border-(--color-rule) pt-3">
              <h3 className="text-[13px] font-medium text-(--color-ink)">{RESUME_COPY.killedTitle}</h3>
              <p className="mt-0.5 text-[12px] leading-relaxed text-(--color-ink-3)">{RESUME_COPY.killedBody}</p>
              <ul className="mt-2 space-y-0.5">
                {killed.map((id) => (
                  <li key={id} className="text-[12.5px] text-(--color-ink-2)">
                    {jobLabel(id)}
                  </li>
                ))}
              </ul>
              <label className="mt-2 flex items-center gap-2 text-[12.5px] text-(--color-ink-2)">
                <input type="checkbox" checked={retryKilled} onChange={(e) => setRetryKilled(e.target.checked)} />
                {RESUME_COPY.killedRetryLabel}
              </label>
            </section>
          )}

          <p className="mt-4 border-t border-(--color-rule) pt-3 text-[11.5px] leading-relaxed text-(--color-ink-3)">
            {RESUME_COPY.versusNewRun}
          </p>
        </>
      )}

      {error && (
        <div className="mt-4 rounded-md border border-[#e8cdcd] bg-[#f8e9e9] px-3 py-2 text-[13px] text-(--color-bad)">
          {error}
        </div>
      )}
    </Modal>
  );
}

/** One step, as a place the run could pick up from. */
interface ResumePoint {
  stage: string;
  n: number;
  title: string;
  status: string;
  at: string | null;
  artifact: string | null;
  resumable: boolean;
}

/** What this step has to show for itself, in one line. */
function describe(p: ResumePoint): string {
  if (p.status === 'ok' && p.at) return `${RESUME_COPY.finishedAt(clock(p.at))} ${p.artifact ? RESUME_COPY.onDisk(p.artifact) : ''}`.trim();
  if (p.status === 'ok') return p.artifact ? RESUME_COPY.onDisk(p.artifact) : 'Finished.';
  if (p.status === 'skipped') return RESUME_COPY.reused;
  if (p.status === 'failed') return RESUME_COPY.couldNotFinish;
  if (p.status === 'running') return 'It was working on this when the run stopped.';
  return RESUME_COPY.neverRan;
}

/**
 * The ladder of steps this run could restart at, best evidence first.
 *
 * The checkpoint is the run's own note-to-self and is believed where it speaks. Where it is
 * absent — an older run, or one that never wrote one — the event projection says the same
 * thing at more length, and the runs list carries a cruder version still. All three are
 * readings of the same folder, so they cannot disagree about much.
 */
function resumePoints({
  checkpoint,
  state,
  stageSummary,
}: {
  checkpoint: Checkpoint | null;
  state: RunState | null;
  stageSummary: RunSummary['stage_summary'];
}): ResumePoint[] {
  const order = state?.order?.length ? state.order : STAGE_IDS;
  const summary = new Map((stageSummary ?? []).map((s) => [s.stage, s]));
  const milestones = new Map((checkpoint?.milestones ?? []).map((m) => [m.stage, m]));

  const points: ResumePoint[] = order.map((id, i) => {
    const cp = checkpoint?.stages?.[id];
    const st = state?.stages?.[id];
    const sum = summary.get(id);
    const status = cp?.status ?? st?.status ?? (sum ? (sum.skipped ? 'skipped' : sum.ok ? 'ok' : 'failed') : 'pending');
    return {
      stage: id,
      n: STAGE_META[id]?.n ?? i + 1,
      title: milestones.get(id)?.title ?? STAGE_META[id]?.title ?? id,
      status,
      at: cp?.ended_at ?? st?.endedAt ?? milestones.get(id)?.at ?? null,
      artifact: cp?.artifact ?? st?.artifact ?? null,
      resumable: false,
    };
  });

  // A step can only be started at if everything before it has a result to reuse: the
  // pipeline reads step 4's file to do step 5, and a gap earlier is a gap it cannot fill.
  let contiguous = true;
  for (const p of points) {
    const finished = p.status === 'ok' || p.status === 'skipped';
    const known = milestones.get(p.stage);
    p.resumable = known ? known.resumable && contiguous : contiguous;
    if (!finished) contiguous = false;
  }
  // The first step is always available: starting there runs the whole thing again.
  if (points.length) points[0].resumable = true;
  return points;
}

/** "harvest:ynet" is a job id. An editor reads "Collect coverage — ynet". */
function jobLabel(jobId: string): string {
  const i = jobId.indexOf(':');
  const stage = i === -1 ? jobId : jobId.slice(0, i);
  const key = i === -1 ? '' : jobId.slice(i + 1);
  const title = STAGE_META[stage]?.title ?? stage;
  return key ? `${title} — ${key}` : title;
}
