import { useState } from 'react';
import type { ActiveRun, RunSummary, SystemStatus } from '../lib/api';
import { RESUME_COPY, RUN_STATUS, STAGE_META } from '../lib/copy';
import { Badge, Button, Card, Explain, Progress, StatusDot } from '../components/ui';
import { ResumePanel } from '../components/ResumePanel';
import { clock, duration, when } from '../lib/format';

/**
 * The screen the app opens on: what has been made, and one button to make another.
 *
 * Ordered by what an editor actually needs, in order of urgency:
 *   1. Anything waiting on them (a run paused for approval) — nothing else moves until they act.
 *   2. Anything running right now.
 *   3. Starting a new one.
 *   4. The archive.
 */
export function HomeScreen({
  runs,
  active,
  system,
  onNewRun,
  onOpenRun,
  onStop,
  onSetup,
}: {
  runs: RunSummary[];
  active: ActiveRun | null;
  system: SystemStatus | null;
  onNewRun: () => void;
  onOpenRun: (runId: string) => void;
  onStop: (runId: string) => void;
  onSetup: () => void;
}) {
  /** The run whose milestone picker is open, if any. A list, not a dashboard: one modal, no state. */
  const [resuming, setResuming] = useState<RunSummary | null>(null);
  const awaiting = runs.filter((r) => r.status === 'awaiting_human');
  const activeRun = active?.run_id ? runs.find((r) => r.run_id === active.run_id) : null;
  const warnings = (system?.checks ?? []).filter((c) => c.state !== 'ok');
  const firstTime = runs.length === 0;

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <header className="mb-8">
        <h1 className="font-serif text-3xl text-(--color-ink)">Political caricature desk</h1>
        <p className="mt-1.5 max-w-2xl text-[14px] leading-relaxed text-(--color-ink-2)">
          Finds what is happening in Israeli politics, works out which stories will actually make a good cartoon,
          argues why, and hands the graphics desk a brief and a first draft. You approve everything before it leaves
          this app.
        </p>
      </header>

      {/* 1 — anything waiting on a person */}
      {awaiting.map((r) => (
        <button
          key={r.run_id}
          type="button"
          onClick={() => onOpenRun(r.run_id)}
          className="mb-3 flex w-full items-center gap-3 rounded-md border border-[#ecdcb6] bg-[#faf2e0] px-4 py-3 text-start hover:bg-[#f7ecd6]"
        >
          <span className="live-dot text-(--color-warn)">⏸</span>
          <span className="flex-1">
            <span className="block text-[14px] font-medium text-(--color-warn)">Waiting for your approval</span>
            <span className="block text-[12.5px] text-(--color-ink-2)">
              {r.slug ?? r.run_id} · nothing is exported until you sign each candidate off
            </span>
          </span>
          <span className="text-[13px] text-(--color-accent-2) underline underline-offset-2">Review now →</span>
        </button>
      ))}

      {/* 2 — what is happening right now */}
      {active && (
        <Card className="mb-3 flex items-center gap-3 px-4 py-3">
          <StatusDot status="running" />
          <div className="min-w-0 flex-1">
            <div className="text-[14px] text-(--color-ink)">
              {active.stopping ? 'Stopping…' : 'Running now'}
              <span className="ms-2 text-[12.5px] text-(--color-ink-3)">
                {activeRun?.slug ?? active.run_id ?? 'starting up'} · {active.mode === 'replay' ? 'practice' : 'live'}
                {active.started_at ? ` · started ${clock(active.started_at)}` : ''}
              </span>
            </div>
          </div>
          {active.run_id && (
            <>
              <Button size="sm" onClick={() => onOpenRun(active.run_id!)}>
                Watch
              </Button>
              <Button size="sm" variant="danger" disabled={active.stopping} onClick={() => onStop(active.run_id!)}>
                Stop
              </Button>
            </>
          )}
        </Card>
      )}

      {/* 3 — start something */}
      <Card className="mb-8 flex flex-wrap items-center gap-4 px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="font-serif text-lg text-(--color-ink)">
            {firstTime ? 'Start with a practice run' : 'New run'}
          </h2>
          <p className="mt-0.5 text-[12.5px] text-(--color-ink-2)">
            {firstTime ? (
              <>
                A <Explain term="practice">practice run</Explain> rehearses all eleven steps on saved data. It costs
                nothing and takes about a minute — the fastest way to see what this does.
              </>
            ) : (
              <>Eleven steps, about 20–40 minutes for a live run. You can watch every step as it happens.</>
            )}
          </p>
        </div>
        <Button variant="primary" size="lg" onClick={onNewRun} disabled={!!active}>
          {active ? 'A run is already going' : 'Start a run'}
        </Button>
      </Card>

      {/* readiness — only when there is something to say */}
      {warnings.length > 0 && (
        <Card className="mb-8 px-5 py-4">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h2 className="font-serif text-lg text-(--color-ink)">Before a live run</h2>
            <button type="button" onClick={onSetup} className="text-[12.5px] text-(--color-accent-2) underline underline-offset-2">
              Open Setup →
            </button>
          </div>
          <ul className="space-y-2">
            {warnings.map((c) => (
              <li key={c.id} className="flex gap-2.5 text-[13px]">
                <span aria-hidden className={c.state === 'blocked' ? 'text-(--color-bad)' : 'text-(--color-warn)'}>
                  {c.state === 'blocked' ? '✗' : '!'}
                </span>
                <span>
                  <span className="font-medium text-(--color-ink)">{c.label}.</span>{' '}
                  <span className="text-(--color-ink-2)">{c.detail}</span>{' '}
                  {c.fix && <span className="text-(--color-ink-3)">{c.fix}</span>}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* 4 — the archive */}
      <section>
        <h2 className="mb-3 border-b border-(--color-rule) pb-2 font-serif text-lg text-(--color-ink)">
          Runs {runs.length > 0 && <span className="text-[13px] text-(--color-ink-3)">({runs.length})</span>}
        </h2>

        {runs.length === 0 ? (
          <p className="rounded-md border border-dashed border-(--color-rule) px-4 py-10 text-center text-[13px] text-(--color-ink-3)">
            Nothing has been run on this machine yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {runs.map((r) => (
              <RunRow
                key={r.run_id}
                run={r}
                onOpen={() => onOpenRun(r.run_id)}
                onResume={r.run_id === active?.run_id ? undefined : () => setResuming(r)}
              />
            ))}
          </ul>
        )}
      </section>

      {resuming && (
        <ResumePanel
          runId={resuming.run_id}
          slug={resuming.slug}
          stageSummary={resuming.stage_summary}
          onClose={() => setResuming(null)}
          onResumed={(id) => {
            setResuming(null);
            onOpenRun(id);
          }}
        />
      )}
    </div>
  );
}

function RunRow({ run, onOpen, onResume }: { run: RunSummary; onOpen: () => void; onResume?: () => void }) {
  const statusKey = run.interrupted ? 'interrupted' : run.status;
  const status = RUN_STATUS[statusKey] ?? RUN_STATUS.unknown;
  const done = (run.stage_summary ?? []).filter((s) => s.ok).length;
  const total = Object.keys(STAGE_META).length;
  const elapsed =
    run.created_at && run.finished_at
      ? duration(new Date(run.finished_at).getTime() - new Date(run.created_at).getTime())
      : null;
  // A run that stopped part way is not a dead end: everything it finished is on disk, and
  // the offer to carry it on belongs here, next to the badge that says it stopped.
  const stoppedPartWay = ['failed', 'cancelled'].includes(run.status) || !!run.interrupted;

  return (
    <li className="group flex items-center gap-2 rounded-md border border-(--color-rule) bg-white/70 pe-3 hover:border-(--color-ink-3)/40 hover:bg-white">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-4 px-4 py-3 text-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-serif text-[15px] text-(--color-ink)">{run.slug ?? run.run_id}</span>
            <Badge tone={status.tone}>{status.label}</Badge>
            {run.mode === 'replay' && <Badge tone="neutral">practice</Badge>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-(--color-ink-3)">
            <span>{when(run.created_at)}</span>
            {elapsed && <span>took {elapsed}</span>}
            {done > 0 && (
              <span className="tabular-nums">
                {done} of {total} steps
              </span>
            )}
          </div>
          {done > 0 && done < total && (
            <div className="mt-2 max-w-xs">
              <Progress done={done} total={total} tone={run.status === 'failed' ? 'bad' : 'accent'} />
            </div>
          )}
        </div>
        <span className="text-[13px] text-(--color-ink-3) group-hover:text-(--color-accent-2)">Open →</span>
      </button>

      {stoppedPartWay && onResume && (
        <Button
          size="sm"
          variant="ghost"
          onClick={onResume}
          title="Everything this run finished is still on disk. Pick the step it should pick up from."
        >
          {RESUME_COPY.homeAction}
        </Button>
      )}
    </li>
  );
}
