import { useEffect, useState } from 'react';
import type { RunState } from '@carica/core/browser';
import { api, type RunSummary, type StageInfo, type SystemStatus } from '../lib/api';
import { CONTROL_COPY, STAGE_META } from '../lib/copy';
import { Badge, Button, Loading, Modal } from './ui';
import { useToast } from './Toast';
import { RunDialog } from './RunDialog';

/**
 * What you can do to a run: hold it, stop it, carry it on from where it stopped, run it
 * again, and audit what it produced.
 *
 * Which of these appear depends on the run's state, because a control that is present but
 * meaningless is worse than one that is absent — it invites a click that does nothing.
 *
 * The load-bearing distinction here is **Pause is not Stop**. Pause suspends the agents and
 * keeps them alive, so Resume carries on from the same place; Stop ends the run and shuts
 * them down. Both are twenty minutes of work apart, so neither is an icon: each is a word,
 * with the consequence written on it.
 */
export function RunControls({
  run,
  state,
  active,
  interrupted,
  paused = false,
  system,
  stages,
  onOpenRun,
  onChanged,
  onResume,
}: {
  run: RunSummary | null;
  state: RunState;
  active: boolean;
  interrupted: boolean;
  /** The run is held where it is: the agents are alive, nothing new is starting. */
  paused?: boolean;
  system: SystemStatus | null;
  stages: StageInfo[];
  onOpenRun: (runId: string) => void;
  onChanged: () => void;
  /** Open the milestone picker for this run, at the step that looks like the right one. */
  onResume?: (suggestedStage: string | null) => void;
}) {
  const toast = useToast();
  const [stopping, setStopping] = useState(false);
  const [holding, setHolding] = useState(false);
  const [dialog, setDialog] = useState<null | 'again'>(null);
  const [audit, setAudit] = useState(false);

  if (!run) return null;

  const stoppable = active;
  const unfinished = interrupted || ['failed', 'cancelled', 'awaiting_human'].includes(state.status);
  const suggested = suggestedResume(state);

  async function stop() {
    setStopping(true);
    try {
      await api.stopRun(run!.run_id);
      toast(CONTROL_COPY.stop.ack, 'info');
      onChanged();
    } catch (e: any) {
      toast(String(e?.message ?? e), 'bad');
    } finally {
      setStopping(false);
    }
  }

  /**
   * Hold the whole run, or let it go again.
   *
   * The reply is only a receipt. What the run is actually doing arrives over the event
   * stream and is read off the projection — this never sets a paused flag of its own.
   */
  async function hold(action: 'pause' | 'resume') {
    setHolding(true);
    try {
      await api.control(run!.run_id, action, { kind: 'run' });
      toast(CONTROL_COPY[action].ack, 'info');
      onChanged();
    } catch (e: any) {
      toast(String(e?.message ?? e), 'bad');
    } finally {
      setHolding(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {stoppable && !paused && (
        <Button size="sm" onClick={() => hold('pause')} busy={holding} title={CONTROL_COPY.pause.hint}>
          {CONTROL_COPY.pause.label}
        </Button>
      )}

      {stoppable && paused && (
        <Button size="sm" variant="primary" onClick={() => hold('resume')} busy={holding} title={CONTROL_COPY.resume.hint}>
          {CONTROL_COPY.resume.label}
        </Button>
      )}

      {stoppable && (
        <Button size="sm" variant="danger" onClick={stop} busy={stopping} title={CONTROL_COPY.stop.hint}>
          {CONTROL_COPY.stop.label}
        </Button>
      )}

      {!active && (unfinished || state.status === 'complete') && onResume && (
        <Button
          size="sm"
          variant={unfinished ? 'primary' : 'secondary'}
          onClick={() => onResume(suggested)}
          title="Everything this run finished is still on disk. Pick the step it should pick up from."
        >
          Carry on{unfinished && suggested ? ` from ${STAGE_META[suggested]?.title ?? suggested}` : ' from…'}
        </Button>
      )}

      {!active && (
        <Button size="sm" onClick={() => setDialog('again')}>
          Run again
        </Button>
      )}

      <Button size="sm" variant="ghost" onClick={() => setAudit(true)}>
        Check results
      </Button>

      {dialog && (
        <RunDialog
          system={system}
          stages={stages}
          onClose={() => setDialog(null)}
          onStarted={(id) => {
            setDialog(null);
            onChanged();
            onOpenRun(id);
          }}
        />
      )}

      {audit && <AuditModal runId={run.run_id} onClose={() => setAudit(false)} />}
    </div>
  );
}

/** Where a stalled run should pick up: the step that failed, or the first not finished. */
function suggestedResume(state: RunState): string | null {
  if (state.failedStage) return state.failedStage;
  if (state.humanRequired) return state.humanRequired.stage;
  const next = state.order.find((id) => state.stages[id].status !== 'ok' && state.stages[id].status !== 'skipped');
  return next ?? null;
}

/**
 * Re-validates every result on disk against its contract, now, independently of the run
 * that produced it. The point is that it is checkable after the fact by anyone.
 */
function AuditModal({ runId, onClose }: { runId: string; onClose: () => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.verify>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .verify(runId)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(String(e?.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [runId]);

  return (
    <Modal
      title="Check results"
      description="Every result this run wrote, re-checked against the shape it is required to have — including that every number cites a source the agents actually fetched."
      onClose={onClose}
      wide
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {error && <p className="text-[13px] text-(--color-bad)">{error}</p>}
      {!data && !error && <Loading what="the audit" />}
      {data && (
        <>
          <p className={`mb-3 text-[13px] ${data.ok ? 'text-(--color-ok)' : 'text-(--color-bad)'}`}>
            {data.ok
              ? 'Everything on disk still passes its checks.'
              : 'Some results do not pass their checks. The details are below.'}
          </p>
          <ul className="space-y-1.5">
            {data.rows.map((r) => (
              <li key={r.stage} className="flex items-baseline gap-2.5 text-[13px]">
                <span className="w-6 shrink-0 text-end tabular-nums text-[11px] text-(--color-ink-3)">
                  {String(STAGE_META[r.stage]?.n ?? '').padStart(2, '0')}
                </span>
                <span className="w-36 shrink-0 text-(--color-ink)">{STAGE_META[r.stage]?.title ?? r.stage}</span>
                {!r.present ? (
                  <span className="text-(--color-ink-3)">not reached</span>
                ) : r.ok ? (
                  <>
                    <Badge tone="ok">passes</Badge>
                    {r.evidence && r.evidence.records > 0 && (
                      <span className="text-[11.5px] text-(--color-ink-3)">
                        {r.evidence.records} sources recorded, {r.evidence.refs} cited
                      </span>
                    )}
                  </>
                ) : (
                  <span className="min-w-0">
                    <Badge tone="bad">fails</Badge>
                    <ul className="mt-1 space-y-0.5">
                      {r.errors.slice(0, 5).map((e, i) => (
                        <li key={i} className="font-mono text-[11px] text-(--color-bad)">
                          {e}
                        </li>
                      ))}
                    </ul>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}
