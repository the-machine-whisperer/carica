import { useEffect, useMemo, useState } from 'react';
import {
  DIMENSIONS,
  arithmeticString,
  floorBreaches,
  rerank,
  type Weights,
} from '@carica/core/browser';
import { useArtifact, useAsync } from '../lib/hooks';
import { api } from '../lib/api';
import { Badge, Bar, Card, Empty, ErrorNote, Loading, PanelHeader } from '../components/ui';
import { Glossed, Quote } from '../lib/bidi';
import type { ViewProps } from './types';

/**
 * The panel the editor actually argues with.
 *
 * S5 emits sub-scores and weights separately, so re-weighting is arithmetic the browser can
 * do — no re-run, no API call, no cost. The rank-change arrows are the point: they show what
 * the editor's priorities do to the slate, which is the difference between a ranking you can
 * interrogate and one you have to take on faith.
 */
export function ScoreView({ runId, version }: ViewProps) {
  const { data, loading, error } = useArtifact<any>(runId, '05_scored.json', version);
  const { data: stories } = useArtifact<any>(runId, '03_stories.json', version);
  const { data: config } = useAsync(() => api.config(), [runId]);

  const [weights, setWeights] = useState<Weights | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (data?.weights) setWeights({ ...data.weights });
  }, [data]);

  const floors = config?.weights?.floors ?? {};
  const storyById = useMemo(
    () => new Map((stories?.stories ?? []).map((s: any) => [s.id, s])),
    [stories]
  );

  const ranked = useMemo(
    () => (data && weights ? rerank(data.candidates, weights) : []),
    [data, weights]
  );

  const originalRank = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of data?.candidates ?? []) m.set(c.story_id, c.rank);
    return m;
  }, [data]);

  if (loading) return <Loading what="scoring" />;
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data || !weights) return <Empty>This stage has not produced an artifact yet.</Empty>;

  const dirty = JSON.stringify(weights) !== JSON.stringify(data.weights);
  const positiveSum = DIMENSIONS.filter((d) => !d.negative).reduce((n, d) => n + (weights[d.key] ?? 0), 0);

  return (
    <div>
      <PanelHeader
        n={5}
        title="Rank candidates"
        blurb="Nine dimensions, each with a justification and its evidence. Re-weight to see what your priorities do to the slate."
        right={<Badge tone="neutral">{data.candidates.length} candidates</Badge>}
      />

      <div className="grid gap-5 lg:grid-cols-[17rem_1fr]">
        {/* ------------------------------------------------ weights */}
        <aside className="lg:sticky lg:top-3 lg:self-start">
          <Card className="px-3 py-3">
            <div className="mb-2 flex items-baseline justify-between">
              <h3 className="text-[12px] font-medium uppercase tracking-wide text-(--color-ink-3)">Weights</h3>
              {dirty && (
                <button
                  type="button"
                  onClick={() => setWeights({ ...data.weights })}
                  className="text-[11px] text-(--color-accent-2) underline underline-offset-2"
                >
                  reset
                </button>
              )}
            </div>

            <div className="space-y-2.5">
              {DIMENSIONS.map((d) => (
                <div key={d.key}>
                  <label className="flex items-baseline justify-between gap-2 text-[12px]">
                    <span className={d.negative ? 'text-(--color-bad)' : 'text-(--color-ink-2)'} title={d.blurb}>
                      {d.label}
                    </span>
                    <span className="font-mono text-[11px] tabular-nums text-(--color-ink-3)">
                      {(weights[d.key] ?? 0).toFixed(2)}
                    </span>
                  </label>
                  <input
                    type="range"
                    min={d.negative ? -0.5 : 0}
                    max={d.negative ? 0 : 0.5}
                    step={0.01}
                    value={weights[d.key] ?? 0}
                    onChange={(e) => setWeights({ ...weights, [d.key]: Number(e.target.value) })}
                    aria-label={`${d.label} weight`}
                    className="w-full accent-(--color-accent)"
                  />
                </div>
              ))}
            </div>

            <div className="mt-3 border-t border-(--color-rule) pt-2 text-[11px]">
              <div className="flex justify-between">
                <span className="text-(--color-ink-3)">positive sum</span>
                <span
                  className={`font-mono tabular-nums ${
                    Math.abs(positiveSum - 1) < 0.001 ? 'text-(--color-ok)' : 'text-(--color-warn)'
                  }`}
                >
                  {positiveSum.toFixed(2)}
                </span>
              </div>
              {dirty && (
                <p className="mt-1.5 text-(--color-ink-3)">
                  Local preview only. The artifact on disk is unchanged; edit{' '}
                  <code className="font-mono">config/weights.yaml</code> to make this stick.
                </p>
              )}
            </div>
          </Card>
        </aside>

        {/* ------------------------------------------------ candidates */}
        <ol className="space-y-2">
          {ranked.map((c: any) => {
            const story: any = storyById.get(c.story_id);
            const was = originalRank.get(c.story_id);
            const moved = was != null ? was - c.rank : 0;
            const breaches = floorBreaches(c.dimensions, floors);
            const isOpen = open === c.story_id;

            return (
              <Card key={c.story_id} as="li" className={breaches.length ? 'border-[#ecdcb6]' : ''}>
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : c.story_id)}
                  aria-expanded={isOpen}
                  className="flex w-full items-start gap-3 px-3 py-2.5 text-start"
                >
                  <span className="flex w-8 shrink-0 flex-col items-center">
                    <span className="font-serif text-2xl tabular-nums text-(--color-ink)">{c.rank}</span>
                    {moved !== 0 && (
                      <span
                        className={`text-[10px] tabular-nums ${
                          moved > 0 ? 'text-(--color-ok)' : 'text-(--color-bad)'
                        }`}
                        title={`was ranked ${was} under the run's own weights`}
                      >
                        {moved > 0 ? `▲${moved}` : `▼${-moved}`}
                      </span>
                    )}
                  </span>

                  <span className="min-w-0 flex-1">
                    {story ? (
                      <Glossed
                        he={story.title_he}
                        en={story.title_en}
                        heClass="font-serif text-[15px] leading-snug"
                        enClass="mt-0.5 text-[12px] text-(--color-ink-3)"
                      />
                    ) : (
                      <span className="font-mono text-[12px]">{c.story_id}</span>
                    )}

                    <span className="mt-1.5 flex flex-wrap items-center gap-1">
                      {DIMENSIONS.map((d) => (
                        <MiniDim key={d.key} label={d.short} value={c.dimensions[d.key]?.score ?? 0} negative={d.negative} />
                      ))}
                    </span>

                    {breaches.length > 0 && (
                      <span className="mt-1.5 flex flex-col gap-0.5">
                        {breaches.map((b, i) => (
                          <span key={i} className="text-[11px] text-(--color-warn)">
                            floor breached — {b}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>

                  <span className="w-14 shrink-0 text-end">
                    <span className="font-serif text-xl tabular-nums text-(--color-ink)">
                      {c.weighted_total.toFixed(2)}
                    </span>
                    {dirty && (
                      <span className="block text-[10px] tabular-nums text-(--color-ink-3)">
                        was {originalRank.has(c.story_id) ? data.candidates.find((x: any) => x.story_id === c.story_id)?.weighted_total.toFixed(2) : '—'}
                      </span>
                    )}
                  </span>
                </button>

                {isOpen && (
                  <div className="border-t border-(--color-rule) px-3 py-3">
                    <p className="mb-3 font-serif text-[14px] leading-relaxed text-(--color-ink)">
                      {c.verdict_summary}
                    </p>

                    <div className="space-y-3">
                      {DIMENSIONS.map((d) => {
                        const dim = c.dimensions[d.key];
                        if (!dim) return null;
                        return (
                          <div key={d.key} className="grid grid-cols-[9rem_1fr] gap-3">
                            <div>
                              <div
                                className={`text-[12px] font-medium ${
                                  d.negative ? 'text-(--color-bad)' : 'text-(--color-ink-2)'
                                }`}
                              >
                                {d.label}
                              </div>
                              <div className="mt-1 flex items-center gap-1.5">
                                <Bar value={dim.score} negative={d.negative} />
                                <span className="w-5 shrink-0 text-end font-serif text-[13px] tabular-nums">
                                  {dim.score}
                                </span>
                              </div>
                              <div className="mt-0.5 text-[10px] text-(--color-ink-3)">
                                ×{(weights[d.key] ?? 0).toFixed(2)} ={' '}
                                {((weights[d.key] ?? 0) * dim.score).toFixed(2)}
                              </div>
                            </div>
                            <div>
                              <p className="text-[12px] leading-relaxed text-(--color-ink-2)">{dim.justification}</p>
                              <Quote
                                he={dim.evidence_quote_he}
                                en={dim.evidence_gloss_en}
                                source={dim.source_url}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div className="mt-3 border-t border-(--color-rule) pt-2">
                      <div className="text-[10px] uppercase tracking-wide text-(--color-ink-3)">arithmetic</div>
                      <code className="mt-0.5 block break-words font-mono text-[11px] text-(--color-ink-2)">
                        {dirty ? arithmeticString(c.dimensions, weights) : c.arithmetic}
                      </code>
                    </div>

                    {c.originality_conflicts?.length > 0 && (
                      <div className="mt-2 rounded border border-[#ecdcb6] bg-[#faf2e0] px-2.5 py-1.5">
                        <div className="text-[11px] font-medium text-(--color-warn)">
                          Resembles what this column has already drawn
                        </div>
                        <ul className="mt-0.5 space-y-0.5">
                          {c.originality_conflicts.map((o: any, i: number) => (
                            <li key={i} className="text-[11px] text-(--color-ink-2)">
                              {o.similarity_note}{' '}
                              <span className="font-mono text-[10px] text-(--color-ink-3)">{o.ledger_id}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

function MiniDim({ label, value, negative }: { label: string; value: number; negative?: boolean }) {
  return (
    <span
      title={`${label}: ${value}`}
      className="inline-flex items-center gap-1 rounded bg-(--color-paper-2) px-1.5 py-0.5 text-[10px] text-(--color-ink-3)"
    >
      {label}
      <span className={`font-mono tabular-nums ${negative && value >= 6 ? 'text-(--color-bad)' : 'text-(--color-ink-2)'}`}>
        {value}
      </span>
    </span>
  );
}
