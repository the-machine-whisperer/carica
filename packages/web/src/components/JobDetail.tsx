import { useState } from 'react';
import type { JobState } from '@carica/core/browser';
import type { ControlAction, ControlTarget } from '../lib/api';
import { duration, clock, num } from '../lib/format';
import { Badge, Button, Kv, Modal } from './ui';
import { LiveActivity } from './LiveActivity';
import { jobName, jobStatusMeta } from './JobTile';

/**
 * One job, opened up: what it is, how it is going, and what you can do about it.
 *
 * The three actions are the reason this panel exists, and their wording is the part that
 * matters most. Stopping one outlet's agent is an ordinary editorial decision — the other
 * seventeen carry on and the gap is written down. Stopping the only agent in a step is a
 * different act entirely. The screen has to say which one is about to happen, at the moment
 * of the click, in the words an editor would use — not "terminate job", and certainly not a
 * bare "Are you sure?".
 */

export interface JobDetailProps {
  job: JobState;
  stageId: string;
  /** The step's plain-English title, for copy that has to name it. */
  stageTitle: string;
  /** Does this step fan out? It decides whether stopping one job costs a source or a step. */
  fanout: boolean;
  /** Is a live process actually behind this run. Nothing can be steered when there is not. */
  active: boolean;
  /** An action requested and not yet confirmed by the run. */
  busy?: ControlAction | null;
  /** Open with a confirmation already showing — the tile's inline stop button lands here. */
  armed?: ControlAction | null;
  onControl: (action: ControlAction, target: ControlTarget) => Promise<void>;
  onClose: () => void;
}

/**
 * What each destructive action actually costs, said plainly.
 *
 * Two versions of every line, because the same click means two different things: a shard of
 * a fanned-out step is one news source among many, and a plain step's single job is the
 * step itself.
 */
function confirmCopy(action: 'kill' | 'skip', fanout: boolean, label: string, stageTitle: string) {
  if (action === 'kill') {
    return fanout
      ? {
          title: `Stop ${label}?`,
          body: `The rest of “${stageTitle}” carries on without it. ${label} is simply left out, and the step records the gap so nothing further down the line quietly acts as though it were there. This does not fail the run.`,
          note: 'Anything this job already wrote is kept.',
          confirm: 'Stop this one',
        }
      : {
          title: `Stop “${stageTitle}”?`,
          body: `This is the only agent working on this step, so stopping it stops the step. Everything the run has finished so far is kept, and you can carry the run on from this step whenever you like.`,
          note: 'Nothing already written is thrown away.',
          confirm: 'Stop this step',
        };
  }
  return fanout
    ? {
        title: `Leave ${label} out?`,
        body: `It will not be attempted at all. “${stageTitle}” finishes with one source fewer and records that ${label} is missing, rather than presenting the coverage as complete.`,
        note: 'You can run the step again later to pick it up.',
        confirm: 'Leave it out',
      }
    : {
        title: `Skip “${stageTitle}”?`,
        body: `The run moves on to the next step without a result from this one. Any later step that needed it will say so out loud rather than inventing something in its place.`,
        note: 'You can carry the run on from this step later.',
        confirm: 'Skip this step',
      };
}

export function JobDetail({
  job,
  stageId,
  stageTitle,
  fanout,
  active,
  busy,
  armed = null,
  onControl,
  onClose,
}: JobDetailProps) {
  const [confirming, setConfirming] = useState<'kill' | 'skip' | null>(armed === 'kill' || armed === 'skip' ? armed : null);
  const [error, setError] = useState<string | null>(null);

  const meta = jobStatusMeta(job.status);
  const label = jobName(job);
  const target: ControlTarget = { kind: 'job', stage: stageId, job_id: job.id };
  const terminal = ['ok', 'failed', 'killed', 'skipped'].includes(job.status);
  const held = job.status === 'paused';
  const steerable = active && !terminal;

  async function fire(action: ControlAction) {
    setError(null);
    try {
      await onControl(action, target);
      setConfirming(null);
      // Deliberately no local status change: the tile turns when the run says it has.
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }

  const copy = confirming ? confirmCopy(confirming, fanout, label, stageTitle) : null;

  return (
    <Modal
      title={label}
      description={
        fanout
          ? `One of the agents working on “${stageTitle}”.`
          : `The agent working on “${stageTitle}”.`
      }
      onClose={onClose}
      footer={
        steerable ? (
          <>
            <span className="me-auto text-[11.5px] text-(--color-ink-3)">
              {busy
                ? 'Asked. Waiting for the run to confirm…'
                : held
                  ? 'Held. It has not lost its place.'
                  : 'Holding is free — nothing is lost and you can let it carry on.'}
            </span>
            <Button size="sm" onClick={() => void fire(held ? 'resume' : 'pause')} busy={busy === 'pause' || busy === 'resume'}>
              {held ? 'Let it carry on' : 'Hold it'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming('skip')} disabled={!!busy}>
              Leave it out
            </Button>
            <Button size="sm" variant="danger" onClick={() => setConfirming('kill')} disabled={!!busy}>
              Stop it
            </Button>
          </>
        ) : (
          <>
            <span className="me-auto text-[11.5px] text-(--color-ink-3)">
              {terminal ? 'This one is finished — there is nothing left to steer.' : 'No process is running behind this run.'}
            </span>
            <Button size="sm" onClick={onClose}>
              Close
            </Button>
          </>
        )
      }
    >
      {/* ---- the confirmation, in place of everything else ------------------- */}
      {copy ? (
        <div>
          <h3 className="font-serif text-lg text-(--color-ink)">{copy.title}</h3>
          <p className="mt-2 text-[13px] leading-relaxed text-(--color-ink-2)">{copy.body}</p>
          <p className="mt-1.5 text-[12px] text-(--color-ink-3)">{copy.note}</p>
          {error && <p className="mt-2 text-[12px] text-(--color-bad)">{error}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
              Never mind
            </Button>
            <Button
              size="sm"
              variant="danger"
              busy={busy === confirming}
              onClick={() => void fire(confirming!)}
            >
              {copy.confirm}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Badge tone={badgeTone(job.status)} title={meta.hint}>
              <span aria-hidden>{meta.glyph}</span>
              {meta.label}
            </Badge>
            {job.attempts > 1 && (
              <Badge tone="warn" title="It failed its checks and was asked again with the exact errors.">
                tried {job.attempts} times
              </Badge>
            )}
            {job.exitCode != null && job.exitCode !== 0 && (
              <Badge tone="bad" title="The command it ran ended badly.">
                exit {job.exitCode}
              </Badge>
            )}
            <span className="ms-auto text-[11.5px] text-(--color-ink-3)">{meta.hint}</span>
          </div>

          <dl className="mb-4 grid grid-cols-2 gap-x-6 gap-y-1">
            <Kv k="Started" v={job.startedAt ? clock(job.startedAt) : '—'} />
            <Kv k="Took" v={job.durationMs != null ? duration(job.durationMs) : job.status === 'running' ? 'still going' : '—'} />
            {job.artifact && <Kv k="Wrote" v={job.artifact} mono />}
            {job.evidenceRecords != null && <Kv k="Sources recorded" v={num(job.evidenceRecords)} />}
            {job.tokens && (
              <Kv
                k="Tokens"
                v={`${num(job.tokens.input + job.tokens.output)} (${num(job.tokens.cached)} reused)`}
              />
            )}
            {job.key && <Kv k="Known as" v={job.key} mono />}
          </dl>

          {job.retries.length > 0 && (
            <div className="mb-4">
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-(--color-ink-3)">
                Asked again
              </div>
              <ul className="space-y-1">
                {job.retries.map((r: any, i: number) => (
                  <li key={i} className="text-[12px] text-(--color-ink-2)">
                    <span className="tabular-nums text-(--color-ink-3)">try {r.attempt ?? i + 2}</span> — {r.reason ?? 'failed its checks'}
                    {r.errors?.length ? (
                      <ul className="mt-0.5 space-y-0.5">
                        {r.errors.slice(0, 3).map((e: string, k: number) => (
                          <li key={k} className="font-mono text-[10.5px] text-(--color-bad)">
                            {e}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {job.errors.length > 0 && (
            <ul className="mb-4 space-y-0.5 rounded-md border border-[#e8cdcd] bg-[#f8e9e9] px-3 py-2">
              {job.errors.slice(0, 8).map((e, i) => (
                <li key={i} className="font-mono text-[11px] text-(--color-bad)">
                  {e}
                </li>
              ))}
            </ul>
          )}

          {error && <p className="mb-3 text-[12px] text-(--color-bad)">{error}</p>}

          <LiveActivity
            activity={job.activity}
            counts={job.activityCounts}
            tokens={job.tokens}
            running={job.status === 'running'}
          />
        </>
      )}
    </Modal>
  );
}

function badgeTone(status: string): 'ok' | 'warn' | 'bad' | 'neutral' | 'accent' {
  if (status === 'ok') return 'ok';
  if (status === 'failed' || status === 'killed') return 'bad';
  if (status === 'running' || status === 'paused') return 'warn';
  return 'neutral';
}
