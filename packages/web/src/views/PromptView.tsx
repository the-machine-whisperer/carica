import { useArtifact } from '../lib/hooks';
import { Badge, Card, CopyButton, Empty, ErrorNote, Kv, Loading, PanelHeader } from '../components/ui';
import { Bidi, Glossed } from '../lib/bidi';
import { hostOf } from '../lib/format';
import type { ViewProps } from './types';

const RISK_TONE = { low: 'neutral', medium: 'warn', high: 'bad' } as const;

/** The graphics team's working surface. Everything here is meant to be copied out. */
export function PromptView({ runId, version }: ViewProps) {
  const { data, loading, error } = useArtifact<any>(runId, '08_prompts.json', version);
  const { data: gate } = useArtifact<any>(runId, '09_gate.json', version);

  if (loading) return <Loading what="prompt packages" />;
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Empty>This stage has not produced an artifact yet.</Empty>;

  const verdictFor = (conceptId: string) =>
    (gate?.verdicts ?? []).find((v: any) => v.concept_id === conceptId)?.verdict;

  return (
    <div>
      <PanelHeader
        n={8}
        title="Art briefs"
        blurb="The deliverable. Everything upstream exists to make this good."
        right={<Badge tone="neutral">{data.packages.length} packages</Badge>}
      />

      <div className="space-y-6">
        {data.packages.map((p: any) => {
          const verdict = verdictFor(p.concept_id);
          return (
            <Card key={`${p.story_id}-${p.concept_id}`} className="overflow-hidden">
              <header className="flex items-start justify-between gap-4 border-b border-(--color-rule) bg-(--color-paper-2) px-4 py-3">
                <Glossed
                  he={p.premise_he}
                  en={p.premise_en}
                  className="min-w-0"
                  heClass="font-serif text-[17px] leading-snug"
                  enClass="mt-0.5 text-[13px] text-(--color-ink-2)"
                />
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {verdict && (
                    <Badge tone={verdict === 'PASS' ? 'ok' : verdict === 'REVISE' ? 'warn' : 'bad'}>{verdict}</Badge>
                  )}
                  <span className="font-mono text-[10px] text-(--color-ink-3)">{p.concept_id}</span>
                  {p.revision_of && <Badge tone="neutral">revision of {p.revision_of}</Badge>}
                </div>
              </header>

              <div className="px-4 py-3">
                {/* -------------------------------------------------- prompts */}
                <Section title="Image prompt — named variant" note="Names the figures. Public-figure satire is permitted, but refusals are nondeterministic.">
                  <PromptBlock text={p.image_prompt.named_variant} k={`${p.concept_id}-named`} />
                </Section>

                <Section
                  title="Image prompt — attribute variant"
                  note="Fallback if the named variant is declined or the figure has opted out. Stands alone; not a diff."
                >
                  <PromptBlock text={p.image_prompt.attribute_variant} k={`${p.concept_id}-attr`} />
                </Section>

                {/* -------------------------------------------------- blank plates */}
                <div className="my-4 rounded-md border border-[#ecdcb6] bg-[#faf2e0] px-3 py-2.5">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-(--color-warn)">
                    Blank plates — read before rendering
                  </div>
                  <p className="mt-1 text-[12px] leading-relaxed text-(--color-ink-2)">
                    {p.image_prompt.blank_plate_instruction}
                  </p>
                  <p className="mt-1 text-[11px] text-(--color-ink-3)">
                    Image models render right-to-left Hebrew as reversed or malformed text that a non-reader will not
                    catch. The plates come back empty on purpose; the strings below are typeset afterwards.
                  </p>
                </div>

                {/* -------------------------------------------------- lettering */}
                {p.lettering_spec?.length > 0 && (
                  <Section title="Lettering — post-render typesetting layer">
                    <table className="w-full text-[12px]">
                      <thead>
                        <tr className="text-[10px] uppercase tracking-wide text-(--color-ink-3)">
                          <th className="py-1 text-start font-medium">Hebrew</th>
                          <th className="py-1 text-start font-medium">gloss</th>
                          <th className="py-1 text-start font-medium">placement</th>
                          <th className="py-1 text-start font-medium">role</th>
                          <th className="py-1 text-start font-medium">font</th>
                          <th className="py-1" />
                        </tr>
                      </thead>
                      <tbody>
                        {p.lettering_spec.map((l: any, i: number) => (
                          <tr key={i} className="border-t border-(--color-rule) align-top">
                            <td className="py-1.5 pe-2">
                              <Bidi text={l.text_he} dir="rtl" className="font-serif text-[14px]" />
                            </td>
                            <td className="py-1.5 pe-2 text-(--color-ink-3)">{l.text_en_gloss ?? '—'}</td>
                            <td className="py-1.5 pe-2 text-(--color-ink-2)">{l.placement}</td>
                            <td className="py-1.5 pe-2">
                              <Badge tone="neutral">{l.role}</Badge>
                            </td>
                            <td className="py-1.5 pe-2 text-[11px] text-(--color-ink-3)">
                              {l.font_recommendation ?? '—'}
                              {l.size_hint ? <span className="block">{l.size_hint}</span> : null}
                            </td>
                            <td className="py-1.5">
                              <CopyButton text={l.text_he} k={`${p.concept_id}-let-${i}`} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Section>
                )}

                {/* -------------------------------------------------- style */}
                <Section title="Style">
                  <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                    {Object.entries(p.image_prompt.style).map(([k, v]) => (
                      <Kv key={k} k={k} v={String(v)} />
                    ))}
                    <Kv k="aspect ratio" v={p.image_prompt.aspect_ratio} />
                  </dl>
                </Section>

                {/* -------------------------------------------------- negative */}
                <Section title="Must not appear">
                  <ul className="grid gap-1 sm:grid-cols-2">
                    {p.negative_list.map((n: string, i: number) => (
                      <li key={i} className="flex gap-1.5 text-[12px] text-(--color-ink-2)">
                        <span className="text-(--color-bad)">✕</span>
                        {n}
                      </li>
                    ))}
                  </ul>
                </Section>

                {/* -------------------------------------------------- captions */}
                <Section title="Caption options">
                  <ul className="space-y-1.5">
                    {p.captions.map((c: any, i: number) => (
                      <li key={i} className="flex items-start justify-between gap-3">
                        <Glossed
                          he={c.text_he}
                          en={c.text_en_gloss}
                          className="min-w-0"
                          heClass="font-serif text-[14px]"
                          enClass="text-[11px] text-(--color-ink-3)"
                        />
                        <div className="flex shrink-0 items-center gap-2">
                          {c.tone && <span className="text-[10px] text-(--color-ink-3)">{c.tone}</span>}
                          <CopyButton text={c.text_he} k={`${p.concept_id}-cap-${i}`} />
                        </div>
                      </li>
                    ))}
                  </ul>
                </Section>

                {/* -------------------------------------------------- alt text */}
                <Section title="Alt text" note="Required. Must describe the joke, not only the scene.">
                  <Glossed
                    he={p.alt_text_he}
                    en={p.alt_text_en}
                    heClass="text-[13px] leading-relaxed"
                    enClass="mt-1.5 text-[12px] leading-relaxed text-(--color-ink-2)"
                  />
                </Section>

                {/* -------------------------------------------------- provenance */}
                <div className="mt-4 grid gap-4 border-t border-(--color-rule) pt-3 sm:grid-cols-2">
                  <div>
                    <h4 className="text-[10px] font-medium uppercase tracking-wide text-(--color-ink-3)">Sources</h4>
                    <ul className="mt-1 space-y-0.5">
                      {p.sources.map((s: any, i: number) => (
                        <li key={i}>
                          <a
                            href={s.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="text-[12px] text-(--color-accent-2) underline underline-offset-2"
                          >
                            {s.title ?? hostOf(s.url)}
                          </a>
                          <span className="ms-1 text-[10px] text-(--color-ink-3)">{s.outlet_id}</span>
                        </li>
                      ))}
                    </ul>

                    {p.verified_claims?.length > 0 && (
                      <>
                        <h4 className="mt-3 text-[10px] font-medium uppercase tracking-wide text-(--color-ink-3)">
                          Verified claims the image may assert
                        </h4>
                        <ul className="mt-1 space-y-0.5">
                          {p.verified_claims.map((c: string, i: number) => (
                            <li key={i} className="text-[12px] text-(--color-ink-2)">
                              ✓ {c}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>

                  <div>
                    <h4 className="text-[10px] font-medium uppercase tracking-wide text-(--color-ink-3)">Risk notes</h4>
                    <ul className="mt-1 space-y-1.5">
                      {p.risk_notes.map((r: any, i: number) => (
                        <li key={i} className="flex items-start gap-1.5">
                          <Badge tone={RISK_TONE[(r.severity ?? 'low') as keyof typeof RISK_TONE]}>
                            {r.kind.replace(/_/g, ' ')}
                          </Badge>
                          <span className="text-[12px] leading-relaxed text-(--color-ink-2)">{r.note}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="mb-4">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-(--color-ink-3)">{title}</h3>
      {note && <p className="mb-1 text-[11px] text-(--color-ink-3)">{note}</p>}
      <div className="mt-1">{children}</div>
    </section>
  );
}

function PromptBlock({ text, k }: { text: string; k: string }) {
  return (
    <div className="relative rounded border border-(--color-rule) bg-(--color-paper) px-3 py-2.5">
      <p className="pe-16 font-serif text-[13px] leading-relaxed text-(--color-ink)">{text}</p>
      <div className="absolute end-2 top-2">
        <CopyButton text={text} k={k} label="copy prompt" />
      </div>
    </div>
  );
}
