import type { RunState } from '@carica/core/browser';
import { STAGE_META, STAGE_STATUS } from '../lib/copy';
import { StatusDot } from './ui';
import { duration } from '../lib/format';

/**
 * The eleven steps, in order, with where the run has got to.
 *
 * Named in plain English — an editor should not have to learn what "ideate" or "gate"
 * means to use this. The engineering name is still one hover away, and still exactly what
 * is written in the run folder.
 */
export function StageRail({
  state,
  selected,
  onSelect,
}: {
  state: RunState;
  selected: string;
  onSelect: (id: string) => void;
}) {
  return (
    <nav aria-label="Steps" className="flex h-full flex-col">
      <div className="px-3 pb-2 pt-3 text-[11px] font-medium uppercase tracking-wider text-(--color-ink-3)">Steps</div>
      <ol className="scrollbar-thin flex-1 overflow-y-auto">
        {state.order.map((id, i) => {
          const s = state.stages[id];
          const meta = STAGE_META[id];
          const isSel = id === selected;
          const isLast = i === state.order.length - 1;

          return (
            <li key={id} className="relative">
              {/* connector line, so the rail reads as a sequence rather than a menu */}
              {!isLast && (
                <span aria-hidden className="absolute left-[18px] top-[26px] h-[calc(100%-18px)] w-px bg-(--color-rule)" />
              )}
              <button
                type="button"
                onClick={() => onSelect(id)}
                aria-current={isSel ? 'true' : undefined}
                title={meta.technical}
                className={`relative flex w-full items-start gap-2.5 px-3 py-2 text-start transition-colors ${
                  isSel ? 'bg-white' : 'hover:bg-white/60'
                }`}
              >
                {isSel && <span aria-hidden className="absolute inset-y-0 left-0 w-[2px] bg-(--color-accent)" />}
                <span className="mt-[5px] flex size-[13px] shrink-0 items-center justify-center rounded-full bg-(--color-paper) ring-4 ring-(--color-paper)">
                  <StatusDot status={s.status} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5">
                    <span className="tabular-nums text-[10px] text-(--color-ink-3)">{String(meta.n).padStart(2, '0')}</span>
                    <span className={`truncate text-[13px] ${isSel ? 'font-medium text-(--color-ink)' : 'text-(--color-ink-2)'}`}>
                      {meta.title}
                    </span>
                    <span className="sr-only">— {STAGE_STATUS[s.status] ?? s.status}</span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-2 text-[11px] text-(--color-ink-3)">
                    {s.status === 'running' && s.shards != null ? (
                      <span className="tabular-nums text-(--color-warn)">
                        {s.shardsCompleted} of {s.shards} jobs done
                      </span>
                    ) : s.status === 'running' ? (
                      <span className="text-(--color-warn)">{meta.doing}…</span>
                    ) : s.status === 'failed' ? (
                      <span className="text-(--color-bad)">Could not finish</span>
                    ) : s.status === 'skipped' ? (
                      <span>Reused from before</span>
                    ) : s.durationMs != null ? (
                      <span className="tabular-nums">{duration(s.durationMs)}</span>
                    ) : (
                      <span className="truncate">{meta.blurb}</span>
                    )}
                    {s.degraded && (
                      <span className="text-(--color-warn)" title="Some parallel jobs failed; the gaps are recorded">
                        partial
                      </span>
                    )}
                    {s.retries.length > 0 && (
                      <span className="text-(--color-warn)" title={`Retried ${s.retries.length} time(s) after failing its checks`}>
                        ↺{s.retries.length}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
