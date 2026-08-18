import type React from 'react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { jobsOf, type JobState, type RunState } from '@carica/core/browser';
import type { ControlAction, ControlTarget, StageInfo } from '../lib/api';
import { controlTargetKey } from '../lib/hooks';
import { STAGE_META, STAGE_STATUS } from '../lib/copy';
import { duration } from '../lib/format';
import { edgePath, layoutGraph, type Rects } from '../lib/graph';
import { JobTile, jobStatusMeta } from './JobTile';
import { JobDetail } from './JobDetail';
import { Badge, Button } from './ui';

/**
 * The run, drawn.
 *
 * A dozen agents can be working at the same moment inside a single step, and until now the
 * only window onto them was a scrolling list of lines at the bottom of the screen — which
 * tells you what just happened but never what is happening. This is the picture instead:
 * the eleven steps in the order the work flows through them, each one opened up to show the
 * jobs inside it, each job a tile you can point at and stop.
 *
 * It holds no state about the run. Every glyph on it is read out of the projection, which
 * is read out of the event log; steering sends a request and then waits, like everyone
 * else, for the run to say what it did. The same drawing is the post-mortem of a finished
 * run — nothing here is only true while something is moving.
 */

export interface RunGraphProps {
  state: RunState;
  stages: StageInfo[];
  runId: string;
  selected: string;
  onSelect: (stageId: string) => void;
  onControl: (action: ControlAction, target: ControlTarget) => Promise<void>;
  onResumeFrom?: (stageId: string) => void;
  /** Is a live process actually behind this run right now. */
  active: boolean;
}

/** How the agent's latest move reads in one word, matching the run header. */
const ACTIVITY_VERB: Record<string, string> = {
  command: 'running',
  search: 'searching',
  file: 'writing',
  message: 'says',
  thinking: 'thinking',
  tool: 'using',
  plan: 'planning',
};

const TERMINAL = new Set(['ok', 'failed', 'skipped', 'killed']);

/** A second hand, only while something is actually moving. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

const sameRects = (a: Rects, b: Rects) => {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => {
    const x = a[k];
    const y = b[k];
    return x && y && x.x === y.x && x.y === y.y && x.w === y.w && x.h === y.h;
  });
};

export function RunGraph({
  state,
  stages,
  runId,
  selected,
  onSelect,
  onControl,
  onResumeFrom,
  active,
}: RunGraphProps): React.JSX.Element {
  const uid = useId().replace(/[^a-zA-Z0-9-]/g, '');
  const hostRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLOListElement>(null);
  const nodeRefs = useRef<Record<string, HTMLLIElement | null>>({});

  const [width, setWidth] = useState(0);
  const [rects, setRects] = useState<Rects>({});
  const [rtl, setRtl] = useState(false);
  const [openJob, setOpenJob] = useState<{ stage: string; job: string; armed: ControlAction | null } | null>(null);
  const [confirmStage, setConfirmStage] = useState<string | null>(null);

  /**
   * Requests made and not yet confirmed by the run. Only ever a label on a button — the
   * status a tile shows always comes from the projection.
   */
  const [busy, setBusy] = useState<Record<string, ControlAction>>({});

  const runControl = useCallback(
    async (action: ControlAction, target: ControlTarget) => {
      const key = controlTargetKey(target);
      setBusy((b) => ({ ...b, [key]: action }));
      try {
        await onControl(action, target);
      } finally {
        setBusy((b) => {
          const { [key]: _gone, ...rest } = b;
          return rest;
        });
      }
    },
    [onControl]
  );

  // Eleven steps in one row is eleven slivers. How many fit is a question about the window,
  // so it is answered by measuring the window rather than by a breakpoint guess.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const perRow = width === 0 ? 4 : width < 620 ? 1 : width < 900 ? 2 : width < 1240 ? 3 : 4;

  /**
   * The steps to draw. `/api/stages` carries the real dependencies; if it has not arrived
   * yet, fall back to the projection's own order as a plain chain so the graph is never
   * blank on first paint.
   */
  const graphStages = useMemo(() => {
    if (stages?.length) return stages.map((s) => ({ id: s.id, dependsOn: s.dependsOn ?? [] }));
    return state.order.map((id, i) => ({ id, dependsOn: i ? [state.order[i - 1]] : [] }));
  }, [stages, state.order]);

  const layout = useMemo(() => layoutGraph(graphStages, { perRow }), [graphStages, perRow]);

  // Where the boxes ended up. Measured, not computed: CSS grid mirrors itself under RTL and
  // a connector drawn from column numbers would point at the wrong side of the screen.
  useLayoutEffect(() => {
    const host = frameRef.current;
    if (!host) return;
    const next: Rects = {};
    for (const n of layout.nodes) {
      const el = nodeRefs.current[n.id];
      if (!el) continue;
      next[n.id] = { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
    }
    setRects((prev) => (sameRects(prev, next) ? prev : next));
    const dir = getComputedStyle(host).direction === 'rtl';
    setRtl((prev) => (prev === dir ? prev : dir));
  });

  const anyRunning = state.order.some((id) => state.stages[id]?.status === 'running');
  const now = useNow(active && anyRunning);

  /**
   * Which steps a run could legitimately be picked up from: the ones with every earlier
   * step already finished. Offering it on all eleven would be eleven buttons, most of them
   * an invitation to start from a step whose inputs do not exist.
   */
  const resumable = useMemo(() => {
    const out = new Set<string>();
    for (const id of state.order) {
      out.add(id);
      const s = state.stages[id];
      if (!s || (s.status !== 'ok' && s.status !== 'skipped')) break;
    }
    return out;
  }, [state]);

  /** Arrow keys walk the grid, because a diagram you can only tab through is a list. */
  const onGridKey = (e: React.KeyboardEvent) => {
    const id = (e.target as HTMLElement)?.dataset?.node;
    if (!id || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const here = layout.byId[id];
    if (!here) return;
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const forward = rtl ? -step : step;
    const dRow = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    const want = { col: here.col + forward, row: here.row + dRow };
    const next =
      layout.nodes.find((n) => n.col === want.col && n.row === want.row) ??
      // Off the end of a row: carry on into the next one, the way the run does.
      (forward > 0
        ? layout.nodes.find((n) => n.row === here.row + 1 && n.col === 0)
        : forward < 0
          ? layout.nodes.filter((n) => n.row === here.row - 1).pop()
          : undefined);
    if (!next) return;
    e.preventDefault();
    gridRef.current?.querySelector<HTMLElement>(`[data-node="${next.id}"]`)?.focus();
  };

  // A different run is a different picture: whatever was open belonged to the old one.
  useEffect(() => {
    setOpenJob(null);
    setConfirmStage(null);
  }, [runId]);

  const open = openJob ? (jobsOf(state, openJob.stage).find((j) => j.id === openJob.job) ?? null) : null;
  const openStageInfo = openJob ? stages.find((s) => s.id === openJob.stage) : undefined;

  return (
    <div ref={hostRef} className="relative">
      <div ref={frameRef} className="relative">
        {/* ---- the flow itself, behind the steps ---------------------------- */}
        <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
          <defs>
            {(['done', 'live', 'todo'] as const).map((k) => (
              <marker
                key={k}
                id={`${uid}-head-${k}`}
                viewBox="0 0 8 8"
                refX={7}
                refY={4}
                markerWidth={5}
                markerHeight={5}
                // Rotates to the path's own direction, so the same marker points the right
                // way in a right-to-left layout without any arithmetic here.
                orient="auto"
              >
                <path d="M 1 1 L 7 4 L 1 7 z" fill={EDGE[k].stroke} />
              </marker>
            ))}
          </defs>
          {layout.edges.map((e) => {
            const d = edgePath(e.from, e.to, rects, { rtl });
            if (!d) return null;
            const kind = edgeKind(state, e.to);
            const style = EDGE[kind];
            return (
              <path
                key={`${e.from}->${e.to}`}
                d={d}
                fill="none"
                stroke={style.stroke}
                strokeWidth={style.width}
                strokeDasharray={style.dash}
                strokeLinecap="round"
                markerEnd={`url(#${uid}-head-${kind})`}
              />
            );
          })}
        </svg>

        <ol
          ref={gridRef}
          onKeyDown={onGridKey}
          aria-label="The eleven steps and the work inside them"
          className="grid gap-x-7 gap-y-8"
          style={{ gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))` }}
        >
          {layout.nodes.map((n) => (
              <li
              key={n.id}
              ref={(el) => {
                nodeRefs.current[n.id] = el;
              }}
              style={{ gridColumn: n.col + 1, gridRow: n.row + 1 }}
              className="relative z-[1] min-w-0"
            >
              <StageNode
                stageId={n.id}
                state={state}
                info={stages.find((s) => s.id === n.id)}
                selected={selected === n.id}
                now={now}
                active={active}
                busy={busy}
                confirming={confirmStage === n.id}
                onConfirm={setConfirmStage}
                onSelect={onSelect}
                onControl={runControl}
                onOpenJob={(job, armed) => setOpenJob({ stage: n.id, job, armed })}
                onResumeFrom={resumable.has(n.id) ? onResumeFrom : undefined}
              />
            </li>
          ))}
        </ol>
      </div>

      {openJob && open && (
        <JobDetail
          job={open}
          stageId={openJob.stage}
          stageTitle={STAGE_META[openJob.stage]?.title ?? openJob.stage}
          fanout={!!openStageInfo?.fanout || jobsOf(state, openJob.stage).length > 1}
          active={active}
          busy={busy[controlTargetKey({ kind: 'job', stage: openJob.stage, job_id: openJob.job })] ?? null}
          armed={openJob.armed}
          onControl={runControl}
          onClose={() => setOpenJob(null)}
        />
      )}

      <p className="mt-6 text-[11.5px] text-(--color-ink-3)">
        {active
          ? 'Each small square is one agent at work. Point at one to hold or stop it — stopping a single news source leaves a recorded gap, it does not fail the run.'
          : 'Each small square is one agent’s work. Open one to see what it did, what it wrote, and anything it could not.'}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- connectors

const EDGE = {
  done: { stroke: 'var(--color-ink-3)', width: 1.5, dash: undefined as string | undefined },
  live: { stroke: 'var(--color-warn)', width: 2, dash: undefined as string | undefined },
  todo: { stroke: 'var(--color-rule)', width: 1.25, dash: '3 4' },
};

/**
 * A line the run has already travelled is drawn solid and dark; one it has not is a faint
 * dashed hint; the one it is on right now is the colour of work in progress. That is the
 * whole legibility-from-six-feet trick, and it is why the same picture works for a finished
 * run: every line ends up solid.
 */
function edgeKind(state: RunState, to: string): keyof typeof EDGE {
  const s = state.stages[to];
  if (!s) return 'todo';
  if (s.status === 'running') return 'live';
  return s.status === 'pending' ? 'todo' : 'done';
}

// ---------------------------------------------------------------- one step

function StageNode({
  stageId,
  state,
  info,
  selected,
  now,
  active,
  busy,
  confirming,
  onConfirm,
  onSelect,
  onControl,
  onOpenJob,
  onResumeFrom,
}: {
  stageId: string;
  state: RunState;
  info?: StageInfo;
  selected: boolean;
  now: number;
  active: boolean;
  busy: Record<string, ControlAction>;
  confirming: boolean;
  onConfirm: (id: string | null) => void;
  onSelect: (id: string) => void;
  onControl: (action: ControlAction, target: ControlTarget) => Promise<void>;
  onOpenJob: (jobId: string, armed: ControlAction | null) => void;
  onResumeFrom?: (stageId: string) => void;
}) {
  const s = state.stages[stageId];
  const meta = STAGE_META[stageId];
  const jobs: JobState[] = s ? jobsOf(state, stageId) : [];
  const status = s?.status ?? 'pending';
  const held = !!s?.paused;
  const running = status === 'running';
  const statusMeta = jobStatusMeta(held && !running ? 'paused' : status);
  const statusWord = held ? 'Held' : (STAGE_STATUS[status] ?? statusMeta.label);

  const target: ControlTarget = { kind: 'stage', stage: stageId };
  const stageBusy = busy[controlTargetKey(target)] ?? null;
  const steerable = active && !TERMINAL.has(status);

  const done = jobs.filter((j) => j.status === 'ok' || j.status === 'skipped').length;
  const killed = jobs.filter((j) => j.status === 'killed').length;
  const failed = jobs.filter((j) => j.status === 'failed').length;
  const retries = jobs.reduce((n, j) => n + Math.max(0, j.attempts - 1), 0) + (s?.retries.length ?? 0);

  const elapsed =
    running && s?.startedAt ? Math.max(0, now - new Date(s.startedAt).getTime()) : (s?.durationMs ?? null);

  const last = running ? (jobs.find((j) => j.status === 'running')?.lastActivity ?? s?.activity[s.activity.length - 1]) : null;

  return (
    <article
      aria-current={selected ? 'true' : undefined}
      className={`flex h-full flex-col rounded-md border bg-white/70 transition-colors ${
        selected ? 'border-(--color-accent) ring-1 ring-(--color-accent)' : 'border-(--color-rule)'
      } ${running ? 'shadow-sm' : ''}`}
    >
      {/* ---- heading: the step, and where it has got to -------------------- */}
      <button
        type="button"
        data-node={stageId}
        onClick={() => onSelect(stageId)}
        title={meta?.technical ?? stageId}
        className="w-full rounded-t-md px-2.5 pb-1.5 pt-2 text-start hover:bg-(--color-paper-2)/70"
      >
        <span className="flex items-baseline gap-1.5">
          <span className="shrink-0 tabular-nums text-[10px] text-(--color-ink-3)">
            S{String(meta?.n ?? info?.n ?? '').padStart(2, '0')}
          </span>
          <span className={`min-w-0 flex-1 truncate text-[13px] ${selected ? 'font-medium text-(--color-ink)' : 'text-(--color-ink-2)'}`}>
            {meta?.title ?? info?.title ?? stageId}
          </span>
          <span aria-hidden className={`shrink-0 text-[10px] leading-none ${statusMeta.text} ${running ? 'live-dot' : ''}`}>
            {statusMeta.glyph}
          </span>
        </span>
        <span className="mt-0.5 flex items-baseline gap-2 text-[11px] text-(--color-ink-3)">
          <span className={running ? 'text-(--color-warn)' : ''}>{statusWord}</span>
          <span className="sr-only">— {statusMeta.hint}</span>
          {elapsed != null && <span className="tabular-nums">{duration(elapsed)}</span>}
          {jobs.length > 1 && (
            <span className="ms-auto tabular-nums">
              {done} of {jobs.length}
            </span>
          )}
        </span>
      </button>

      {/* ---- what it did not manage, said out loud ------------------------- */}
      {(s?.degraded || killed > 0 || failed > 0 || retries > 0) && (
        <div className="flex flex-wrap gap-1 px-2.5 pb-1">
          {s?.degraded && (
            <Badge tone="warn" title="Some of the jobs in this step did not come back. The step recorded the gaps rather than hiding them.">
              partial
            </Badge>
          )}
          {failed > 0 && (
            <Badge tone="bad" title="Jobs that could not produce a usable result.">
              {failed} failed
            </Badge>
          )}
          {killed > 0 && (
            <Badge tone="bad" title="You stopped these. The step records what they would have covered.">
              {killed} stopped
            </Badge>
          )}
          {retries > 0 && (
            <Badge tone="warn" title="A job failed its checks and was asked again with the exact errors.">
              ↺{retries}
            </Badge>
          )}
        </div>
      )}

      {/* ---- the jobs inside it -------------------------------------------- */}
      <div className="flex-1 px-2.5 pb-2">
        {jobs.length === 0 ? (
          <p className="rounded-sm border border-dashed border-(--color-rule) px-2 py-1.5 text-[11px] text-(--color-ink-3)">
            {running
              ? 'Getting started — no agent has reported in yet.'
              : status === 'skipped'
                ? 'Reused from an earlier run.'
                : (meta?.blurb ?? 'Not started.')}
          </p>
        ) : (
          <div className="flex flex-wrap gap-1" role="group" aria-label={`Jobs in ${meta?.title ?? stageId}`}>
            {jobs.map((job) => (
              <JobTile
                key={job.id}
                job={job}
                name={job.id === stageId ? (meta?.title ?? stageId) : undefined}
                steerable={active}
                busy={busy[controlTargetKey({ kind: 'job', stage: stageId, job_id: job.id })] ?? null}
                onOpen={() => onOpenJob(job.id, null)}
                onControl={(action) =>
                  action === 'kill'
                    ? // The confirmation belongs with the explanation of what it costs.
                      onOpenJob(job.id, 'kill')
                    : void onControl(action, { kind: 'job', stage: stageId, job_id: job.id })
                }
              />
            ))}
          </div>
        )}

        {/* One line of proof that something is actually happening in there. */}
        {last && (
          <p className="mt-1.5 flex items-baseline gap-1.5 text-[10.5px] text-(--color-ink-3)">
            <span aria-hidden className="live-dot shrink-0 text-[8px] text-(--color-live)">
              ●
            </span>
            <span className="shrink-0">{ACTIVITY_VERB[last.kind] ?? 'working'}</span>
            <span className="min-w-0 truncate font-mono text-(--color-ink-2)">{last.text}</span>
          </p>
        )}
      </div>

      {/* ---- steering this whole step -------------------------------------- */}
      {confirming ? (
        <div className="border-t border-(--color-rule) bg-[#f8e9e9] px-2.5 py-2">
          <p className="text-[11.5px] leading-relaxed text-(--color-bad)">
            Stop “{meta?.title ?? stageId}”? Every agent still working on it is stopped. What they have already
            written is kept, and the step records what it did not manage to cover.
          </p>
          <div className="mt-1.5 flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => onConfirm(null)}>
              Never mind
            </Button>
            <Button
              size="sm"
              variant="danger"
              busy={stageBusy === 'kill'}
              onClick={async () => {
                await onControl('kill', target);
                onConfirm(null);
              }}
            >
              Stop the step
            </Button>
          </div>
        </div>
      ) : (
        (steerable || (onResumeFrom && !active)) && (
          <div className="flex flex-wrap items-center gap-1 border-t border-(--color-rule) px-2 py-1.5">
            {steerable && (
              <>
                <SmallAction
                  onClick={() => void onControl(held ? 'resume' : 'pause', target)}
                  busy={stageBusy === 'pause' || stageBusy === 'resume'}
                  title={held ? 'Let this step carry on from where it is' : 'Hold this step where it is — nothing is lost'}
                >
                  {held ? '▶ Carry on' : '⏸ Hold'}
                </SmallAction>
                <SmallAction onClick={() => onConfirm(stageId)} danger title="Stop every agent still working on this step">
                  ⊘ Stop
                </SmallAction>
              </>
            )}
            {onResumeFrom && !active && (
              <SmallAction
                className="ms-auto"
                onClick={() => onResumeFrom(stageId)}
                title="Carry this run on from this step, reusing everything before it"
              >
                Continue from here →
              </SmallAction>
            )}
          </div>
        )
      )}
    </article>
  );
}

/** A control small enough to live inside a node without shouting over its contents. */
function SmallAction({
  children,
  onClick,
  title,
  danger,
  busy,
  className = '',
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  danger?: boolean;
  busy?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={busy}
      aria-busy={busy || undefined}
      className={`rounded border border-transparent px-1.5 py-0.5 text-[10.5px] transition-colors disabled:opacity-50 ${
        danger ? 'text-(--color-bad) hover:bg-[#f8e9e9]' : 'text-(--color-ink-2) hover:bg-(--color-paper-2)'
      } ${className}`}
    >
      {busy ? 'asking…' : children}
    </button>
  );
}
