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
    return (
      <div>
        <PanelHeader n={meta.n} title={meta.title} blurb={meta.blurb} />
        <ErrorNote>
          <div className="font-medium">This step could not produce a usable result.</div>
          <p className="mt-1 text-[12px]">
            Its output has to satisfy a fixed shape, and every figure in it has to cite a source the agent actually
            fetched. These are the checks it did not pass:
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
              ? `It was retried ${stage.retries.length} time${stage.retries.length === 1 ? '' : 's'}, each time handed the exact errors above, before stopping. `
              : ''}
            Nothing after this step ran. Use <span className="font-medium">Continue</span> to try this step again —
            earlier steps are reused, not repeated.
          </p>
        </ErrorNote>
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
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-[#ecdcb6] bg-[#faf2e0] px-3 py-1.5 text-[12px] text-(--color-warn)">
          <span className="live-dot">●</span>
          <span>{meta.doing}…</span>
          {stage.shards != null && (
            <span className="tabular-nums">
              {stage.shardsCompleted} of {stage.shards} parallel jobs done
            </span>
          )}
          {stage.progress.length > 0 && (
            <span className="text-(--color-ink-2)">{stage.progress[stage.progress.length - 1].message}</span>
          )}
        </div>
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
