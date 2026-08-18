import type { RunState } from '@carica/core/browser';
import { OutletsView } from './OutletsView';
import { HarvestView } from './HarvestView';
import { ClusterView } from './ClusterView';
import { TriageView } from './TriageView';
import { ScoreView } from './ScoreView';
import { VerifyView } from './VerifyView';
import { IdeateView } from './IdeateView';
import { PromptView } from './PromptView';
import { GateView } from './GateView';
import { RenderView } from './RenderView';
import { PublishView } from './PublishView';
import { Empty, ErrorNote, PanelHeader } from '../components/ui';
import { LiveActivity } from '../components/LiveActivity';
import { STAGE_META } from '../lib/copy';
import { duration } from '../lib/format';

const VIEWS: Record<string, any> = {
  outlets: OutletsView,
  harvest: HarvestView,
  cluster: ClusterView,
  triage: TriageView,
  score: ScoreView,
  verify: VerifyView,
  ideate: IdeateView,
  prompt: PromptView,
  gate: GateView,
  render: RenderView,
  publish: PublishView,
};

export function StageView({ stageId, runId, state }: { stageId: string; runId: string; state: RunState }) {
  const stage = state.stages[stageId];
  const meta = STAGE_META[stageId];
  const View = VIEWS[stageId];

  // Refetch the artifact whenever this stage transitions — the version key is what makes
  // the panel follow a live run instead of showing a stale snapshot.
  const version = `${stage?.status}:${stage?.endedAt ?? ''}:${stage?.shardsCompleted ?? 0}`;

  if (!View) return <Empty>Unknown stage.</Empty>;

  if (stage?.status === 'failed') {
    // A step fails in three quite different ways, and telling them apart is the whole
    // difference between a useful error and a wild goose chase. `contract_violation` means
    // the agent ran and its output was rejected — the shape-and-sources explanation applies.
    // A timeout or a non-zero exit means the agent never ran, so nothing was checked at all.
    //
    // `crashed` is the third, and it is the one that used to be reported as the first: this
    // app threw before the step did any work. There is no artifact to inspect, no retry that
    // could behave differently, and nothing the editor can change — telling them their output
    // "has to satisfy a fixed shape" here points them at a file that was never written.
    const crashed = stage.crashed;
    const ranAtAll = !crashed && stage.retries.every((r) => r.reason === 'contract_violation');
    return (
      <div>
        <PanelHeader n={meta.n} title={meta.title} blurb={meta.blurb} />
        <ErrorNote>
          <div className="font-medium">
            {crashed
              ? 'This step could not start — the app hit a bug.'
              : ranAtAll
                ? 'This step could not produce a usable result.'
                : 'This step could not run.'}
          </div>
          <p className="mt-1 text-[12px]">
            {crashed ? (
              <>
                The failure is in this app, not in your run, your settings or the agent's work. Nothing was sent and
                nothing was charged. Continuing will stop here again until the bug is fixed — this is what to report:
              </>
            ) : ranAtAll ? (
              <>
                Its output has to satisfy a fixed shape, and every figure in it has to cite a source the agent actually
                fetched. These are the checks it did not pass:
              </>
            ) : (
              <>
                The agent runtime stopped before it wrote anything, so nothing was checked. This is a problem with the
                runtime or this machine, not with the editorial policy:
              </>
            )}
          </p>
          <ul className="mt-2 space-y-0.5">
            {stage.errors.slice(0, 12).map((e, i) => (
              <li key={i} className="font-mono text-[11px]">
                {e}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px]">
            {stage.retries.length > 0
              ? ranAtAll
                ? `It was retried ${stage.retries.length} time${stage.retries.length === 1 ? '' : 's'}, each time handed the exact errors above, before stopping. `
                : `It was retried ${stage.retries.length} time${stage.retries.length === 1 ? '' : 's'} before stopping. `
              : ''}
            {crashed ? (
              <>
                Nothing after this step ran. Everything before it is finished and saved, so once the bug is fixed{' '}
                <span className="font-medium">Continue</span> picks up here without repeating any of it.
              </>
            ) : (
              <>
                Nothing after this step ran. Use <span className="font-medium">Continue</span> to try this step again —
                earlier steps are reused, not repeated.
              </>
            )}
          </p>

          {/* Collapsed: the editor does not need a stack trace, and the person they forward
              this to needs nothing else. */}
          {crashed && stage.crashStack && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] select-none">Technical detail</summary>
              <pre className="mt-1 overflow-x-auto font-mono text-[10px] leading-relaxed whitespace-pre-wrap">
                {stage.crashStack}
              </pre>
            </details>
          )}
        </ErrorNote>

        {/* What it was doing before it gave up is usually the fastest route to why. */}
        {stage.activity.length > 0 && (
          <div className="mt-4">
            <LiveActivity
              activity={stage.activity}
              counts={stage.activityCounts}
              tokens={stage.tokens}
              running={false}
            />
          </div>
        )}
      </div>
    );
  }

  if (stage?.status === 'pending') {
    return (
      <div>
        <PanelHeader n={meta.n} title={meta.title} blurb={meta.blurb} />
        <Empty>This step has not started yet.</Empty>
      </div>
    );
  }

  return (
    <div>
      {stage?.status === 'running' && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-[#ecdcb6] bg-[#faf2e0] px-3 py-1.5 text-[12px] text-(--color-warn)">
            <span className="live-dot">●</span>
            <span>{meta.doing}…</span>
            {stage.attempts > 1 && <span>attempt {stage.attempts} of 3</span>}
            {stage.shards != null && (
              <span className="tabular-nums">
                {stage.shardsCompleted} of {stage.shards} parallel jobs done
              </span>
            )}
            {stage.progress.length > 0 && (
              <span className="text-(--color-ink-2)">{stage.progress[stage.progress.length - 1].message}</span>
            )}
          </div>

          {/* A step can run for minutes. This is the difference between watching it work
              and watching a spinner. */}
          <div className="mb-4">
            <LiveActivity
              activity={stage.activity}
              counts={stage.activityCounts}
              tokens={stage.tokens}
              running
            />
          </div>
        </>
      )}

      {/* A finished step keeps its working history — how a number was arrived at is part
          of the answer, not scaffolding to be thrown away. */}
      {stage?.status === 'ok' && stage.activity.length > 0 && (
        <details className="mb-4 group">
          <summary className="cursor-pointer list-none text-[11.5px] text-(--color-ink-3) hover:text-(--color-ink-2)">
            <span className="inline-block text-[9px] transition-transform group-open:rotate-90">▶</span> How this step
            worked — {stage.activityCounts.command} commands, {stage.activityCounts.search} searches
          </summary>
          <div className="mt-2">
            <LiveActivity
              activity={stage.activity}
              counts={stage.activityCounts}
              tokens={stage.tokens}
              running={false}
            />
          </div>
        </details>
      )}

      {stage?.degraded && (
        <div className="mb-3 rounded-md border border-[#ecdcb6] bg-[#faf2e0] px-3 py-1.5 text-[12px] text-(--color-warn)">
          Some of the parallel jobs in this step failed. What is below is what did come back — the gaps are written
          into the result rather than quietly dropped.
        </div>
      )}

      <View runId={runId} version={version} state={state} />

      {(stage?.durationMs != null || stage?.evidenceRecords != null) && (
        <footer className="mt-6 flex flex-wrap gap-4 border-t border-(--color-rule) pt-2 text-[11px] text-(--color-ink-3)">
          {stage.durationMs != null && <span>{duration(stage.durationMs)}</span>}
          {stage.evidenceRecords != null && (
            <span title="Pages fetched or commands run by the agent, recorded as it worked">
              {stage.evidenceRecords} sources recorded, {stage.evidenceRefs ?? 0} cited
            </span>
          )}
          {stage.artifact && (
            <span className="font-mono" title="The file this step wrote into the run folder">
              {stage.artifact}
            </span>
          )}
          {stage.replay && <span title="Practice run: this step replayed saved data">from saved data</span>}
        </footer>
      )}
    </div>
  );
}
