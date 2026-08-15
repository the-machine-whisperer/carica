import { useArtifact } from '../lib/hooks';
import { api } from '../lib/api';
import { Badge, Card, Empty, ErrorNote, Loading, PanelHeader } from '../components/ui';
import { RENDER_ATTEMPT_STATUS, RENDER_OUTCOME } from '../lib/copy';
import { duration } from '../lib/format';
import type { ViewProps } from './types';

/**
 * The drawing step is best-effort, and a run that produced no image is still a complete,
 * valid run — the art brief is the deliverable and the graphics desk can draw from it.
 *
 * So this panel never renders "no image" as a failure. What it does insist on is keeping
 * three things visibly apart, because the editor's next move differs in each:
 *
 *   refused     a renderer was reached and DECLINED ON POLICY GROUNDS. That is a
 *               judgement about the concept, and the verbatim wording is the thing to
 *               read — never paraphrased, never summarised away.
 *   error       a renderer was reached and broke. Transient; retry.
 *   unavailable no renderer was reachable at all. Nothing was ever asked of a model, so
 *               it says nothing about the concept. Presenting this as a refusal would
 *               silently indict an idea nothing ever looked at.
 */
export function RenderView({ runId, version }: ViewProps) {
  const { data, loading, error } = useArtifact<any>(runId, '10_render.json', version);

  if (loading) return <Loading what="drafts" />;
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Empty>This stage has not produced an artifact yet.</Empty>;

  return (
    <div>
      <PanelHeader
        n={10}
        title="Draft images"
        blurb="A first draft where one could be made. Refusals are logged verbatim, never swallowed — and a concept nobody could draw here is not a concept that failed."
        right={<Badge tone="neutral">{data.renders.length} concept(s)</Badge>}
      />

      <div className="space-y-5">
        {data.renders.map((r: any) => {
          const outcome = RENDER_OUTCOME[r.outcome as string];
          return (
          <Card key={`${r.story_id}-${r.concept_id}`} className="px-3 py-3">
            <header className="mb-3 flex items-center justify-between gap-3">
              <span className="font-mono text-[12px] text-(--color-ink-2)">{r.concept_id}</span>
              <Badge tone={outcome?.tone ?? 'neutral'}>{outcome?.label ?? r.outcome.replace(/_/g, ' ')}</Badge>
            </header>

            {outcome && (
              <div
                className={`mb-3 rounded-md border px-3 py-2 text-[12px] leading-relaxed ${
                  outcome.tone === 'ok'
                    ? 'border-[#cbe2d4] bg-[#eaf3ed]'
                    : outcome.tone === 'warn'
                      ? 'border-[#ecdcb6] bg-[#faf2e0]'
                      : outcome.tone === 'bad'
                        ? 'border-[#e8cdcd] bg-[#f8e9e9]'
                        : 'border-(--color-rule) bg-(--color-paper-2)'
                }`}
              >
                <span className="font-medium text-(--color-ink)">{outcome.note}</span>{' '}
                <span className="text-(--color-ink-2)">{outcome.remedy}</span>
              </div>
            )}

            {r.drafts?.length > 0 ? (
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {r.drafts.map((d: any, i: number) => (
                  <li key={i}>
                    <a href={api.draftUrl(runId, d.asset_path)} target="_blank" rel="noreferrer noopener">
                      <img
                        src={api.draftUrl(runId, d.asset_path)}
                        alt={`Draft ${i + 1} for ${r.concept_id} — ${d.note ?? 'no note'}`}
                        loading="lazy"
                        className="w-full rounded border border-(--color-rule) bg-(--color-paper-2)"
                        onError={(e) => {
                          const el = e.currentTarget;
                          el.style.display = 'none';
                          el.insertAdjacentHTML(
                            'afterend',
                            `<div class="rounded border border-dashed border-(--color-rule) px-3 py-6 text-center text-[11px] text-(--color-ink-3)">image not on disk — ${d.asset_path}</div>`
                          );
                        }}
                      />
                    </a>
                    <div className="mt-1 flex items-center gap-1.5">
                      <Badge tone="neutral">{d.variant}</Badge>
                      {d.width && (
                        <span className="text-[10px] tabular-nums text-(--color-ink-3)">
                          {d.width}×{d.height}
                        </span>
                      )}
                    </div>
                    {d.note && <p className="mt-0.5 text-[11px] leading-snug text-(--color-ink-2)">{d.note}</p>}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>
                {r.outcome === 'no_renderer_available'
                  ? 'Nothing was drawn here, and nothing was asked to. The art brief for this concept is finished and unaffected.'
                  : 'No image was produced. The trail below says why.'}
              </Empty>
            )}

            <h4 className="mt-4 text-[10px] font-medium uppercase tracking-wide text-(--color-ink-3)">
              Attempt trail
            </h4>
            <ol className="mt-1 space-y-1.5">
              {r.attempts.map((a: any, i: number) => {
                const st = RENDER_ATTEMPT_STATUS[a.status as string];
                const refused = a.status === 'refused';
                return (
                <li
                  key={i}
                  className="rounded border border-(--color-rule) bg-(--color-paper) px-2.5 py-1.5 text-[12px]"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="tabular-nums text-(--color-ink-3)">{i + 1}.</span>
                    <Badge tone="neutral">{a.variant}</Badge>
                    <Badge tone={st?.tone ?? 'neutral'} title={st?.hint}>
                      {st?.label ?? a.status}
                    </Badge>
                    {a.model && <span className="text-[10px] text-(--color-ink-3)">{a.model}</span>}
                    {a.duration_ms != null && (
                      <span className="ms-auto text-[10px] tabular-nums text-(--color-ink-3)">
                        {duration(a.duration_ms)}
                      </span>
                    )}
                  </div>
                  {/* A success needs no explanation; the three ways of not succeeding do. */}
                  {st && a.status !== 'ok' && <p className="mt-0.5 text-[11px] text-(--color-ink-3)">{st.hint}</p>}
                  {/* Verbatim, and labelled as such — a paraphrased policy decline is worse than none. */}
                  {refused && a.refusal_text && (
                    <>
                      <p className="mt-1.5 text-[10px] font-medium uppercase tracking-wide text-(--color-ink-3)">
                        What it said, word for word
                      </p>
                      <p className="mt-0.5 border-s-2 border-[#ecdcb6] ps-2 font-mono text-[11px] leading-relaxed text-(--color-ink-2)">
                        {a.refusal_text}
                      </p>
                    </>
                  )}
                  {!refused && a.refusal_text && (
                    <p className="mt-1 border-s-2 border-[#ecdcb6] ps-2 font-mono text-[11px] leading-relaxed text-(--color-ink-2)">
                      {a.refusal_text}
                    </p>
                  )}
                  {/* For 'unavailable' this field says which renderer was looked for — a fact,
                      not a fault, so it must not be printed in the error colour. */}
                  {a.error && (
                    <p
                      className={`mt-1 text-[11px] ${
                        a.status === 'unavailable' ? 'text-(--color-ink-3)' : 'text-(--color-bad)'
                      }`}
                    >
                      {a.error}
                    </p>
                  )}
                </li>
                );
              })}
            </ol>
          </Card>
          );
        })}
      </div>
    </div>
  );
}
