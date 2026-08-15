import { useArtifact } from '../lib/hooks';
import { Badge, Card, Empty, ErrorNote, Loading, PanelHeader } from '../components/ui';
import { Bidi, Glossed } from '../lib/bidi';
import type { ViewProps } from './types';

export function IdeateView({ runId, version }: ViewProps) {
  const { data, loading, error } = useArtifact<any>(runId, '07_concepts.json', version);
  const { data: stories } = useArtifact<any>(runId, '03_stories.json', version);

  if (loading) return <Loading what="concepts" />;
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Empty>This stage has not produced an artifact yet.</Empty>;

  const byId = new Map((stories?.stories ?? []).map((s: any) => [s.id, s]));

  return (
    <div>
      <PanelHeader
        n={7}
        title="Concepts"
        blurb="Three deliberately divergent ideas per candidate, from different metaphor families, then a choice with its strongest objection"
      />

      <div className="space-y-6">
        {data.candidates.map((c: any) => {
          const story: any = byId.get(c.story_id);
          return (
            <section key={c.story_id}>
              {story && (
                <Glossed
                  he={story.title_he}
                  en={story.title_en}
                  className="mb-2"
                  heClass="font-serif text-[16px]"
                  enClass="text-[12px] text-(--color-ink-3)"
                />
              )}

              <div className="grid gap-2 lg:grid-cols-3">
                {c.concepts.map((cp: any) => {
                  const primary = cp.id === c.selected_primary;
                  const alternate = cp.id === c.selected_alternate;
                  return (
                    <Card
                      key={cp.id}
                      className={`flex flex-col px-3 py-3 ${
                        primary ? 'border-(--color-accent) ring-1 ring-(--color-accent)/20' : ''
                      }`}
                    >
                      <div className="mb-1.5 flex items-center gap-1.5">
                        <Badge tone="neutral">{cp.metaphor_family.replace(/_/g, ' ')}</Badge>
                        {primary && <Badge tone="accent">primary</Badge>}
                        {alternate && <Badge tone="neutral">alternate</Badge>}
                        {cp.legibility_self_score != null && (
                          <span className="ms-auto text-[10px] text-(--color-ink-3)" title="self-assessed legibility">
                            legibility {cp.legibility_self_score}
                          </span>
                        )}
                      </div>

                      <p className="font-serif text-[14px] leading-snug text-(--color-ink)">“{cp.gag_line}”</p>
                      <p className="mt-2 text-[12px] leading-relaxed text-(--color-ink-2)">{cp.metaphor}</p>

                      <h4 className="mt-3 text-[10px] font-medium uppercase tracking-wide text-(--color-ink-3)">Cast</h4>
                      <ul className="mt-1 space-y-1">
                        {cp.cast.map((m: any, i: number) => (
                          <li key={i} className="text-[12px]">
                            <span className="text-(--color-ink-2)">{m.figure}</span>
                            <span className="mt-0.5 flex flex-wrap gap-1">
                              {m.caricature_handles.map((h: string, k: number) => (
                                <span
                                  key={k}
                                  className="rounded bg-(--color-paper-2) px-1.5 py-0.5 text-[10px] text-(--color-ink-3)"
                                  title="Signature attribute — never physiognomy (§3)"
                                >
                                  {h}
                                </span>
                              ))}
                            </span>
                          </li>
                        ))}
                      </ul>

                      <h4 className="mt-3 text-[10px] font-medium uppercase tracking-wide text-(--color-ink-3)">
                        Composition
                      </h4>
                      <p className="mt-0.5 text-[12px] leading-relaxed text-(--color-ink-2)">{cp.composition}</p>

                      <h4 className="mt-3 text-[10px] font-medium uppercase tracking-wide text-(--color-ink-3)">
                        Read order
                      </h4>
                      <ol className="mt-0.5 space-y-0.5">
                        {cp.read_order.map((r: string, i: number) => (
                          <li key={i} className="flex gap-1.5 text-[12px] text-(--color-ink-2)">
                            <span className="text-(--color-ink-3)">{i + 1}.</span>
                            {r}
                          </li>
                        ))}
                      </ol>

                      {cp.lettering_plan?.length > 0 && (
                        <>
                          <h4 className="mt-3 text-[10px] font-medium uppercase tracking-wide text-(--color-ink-3)">
                            Lettering
                          </h4>
                          <ul className="mt-0.5 space-y-1">
                            {cp.lettering_plan.map((l: any, i: number) => (
                              <li key={i} className="text-[12px]">
                                <Bidi text={l.text_he} dir="rtl" className="font-serif" />
                                <span className="block text-[10px] text-(--color-ink-3)">
                                  {l.text_en_gloss ? `${l.text_en_gloss} — ` : ''}
                                  {l.placement}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </Card>
                  );
                })}
              </div>

              <div className="mt-2 rounded-md border border-(--color-rule) bg-(--color-paper-2) px-3 py-2">
                <div className="text-[10px] font-medium uppercase tracking-wide text-(--color-ink-3)">
                  Why the primary won, and the strongest objection to it
                </div>
                <p className="mt-1 text-[12px] leading-relaxed text-(--color-ink-2)">{c.critique}</p>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
