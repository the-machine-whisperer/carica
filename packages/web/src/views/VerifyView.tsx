import { useArtifact } from '../lib/hooks';
import { Badge, Card, Empty, ErrorNote, Loading, PanelHeader } from '../components/ui';
import { Glossed } from '../lib/bidi';
import { hostOf } from '../lib/format';
import type { ViewProps } from './types';

const CLAIM_TONE = {
  verified: 'ok',
  partially_verified: 'warn',
  unverified: 'warn',
  contradicted: 'bad',
} as const;

const VERDICT_TONE = {
  proceed: 'ok',
  proceed_with_stripped_claims: 'warn',
  drop: 'bad',
} as const;

const OUTCOME_TONE = { held: 'ok', refuted: 'bad', inconclusive: 'warn' } as const;

export function VerifyView({ runId, version }: ViewProps) {
  const { data, loading, error } = useArtifact<any>(runId, '06_verified.json', version);
  const { data: stories } = useArtifact<any>(runId, '03_stories.json', version);

  if (loading) return <Loading what="verification" />;
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Empty>This stage has not produced an artifact yet.</Empty>;

  const byId = new Map((stories?.stories ?? []).map((s: any) => [s.id, s]));

  return (
    <div>
      <PanelHeader
        n={6}
        title="Fact-check"
        blurb="A fresh agent trying to break the story, not confirm it. Satire may exaggerate a fact; it may not invent one."
        right={<Badge tone="neutral">{data.candidates.length} checked</Badge>}
      />

      <ul className="space-y-3">
        {data.candidates.map((c: any) => {
          const story: any = byId.get(c.story_id);
          return (
            <Card key={c.story_id} className="px-3 py-3" as="li">
              <div className="flex items-start justify-between gap-4">
                {story ? (
                  <Glossed
                    he={story.title_he}
                    en={story.title_en}
                    className="min-w-0"
                    heClass="font-serif text-[15px] leading-snug"
                    enClass="mt-0.5 text-[12px] text-(--color-ink-3)"
                  />
                ) : (
                  <span className="font-mono text-[12px]">{c.story_id}</span>
                )}
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <Badge tone={VERDICT_TONE[c.verdict as keyof typeof VERDICT_TONE]}>
                    {c.verdict.replace(/_/g, ' ')}
                  </Badge>
                  <Badge tone={c.public_figure_confirmed ? 'ok' : 'bad'}>
                    {c.public_figure_confirmed ? 'public figures confirmed' : 'public-figure test FAILED'}
                  </Badge>
                  <Badge tone={c.censor_clear ? 'ok' : 'warn'}>
                    {c.censor_clear ? 'censor clear' : 'censor exposure'}
                  </Badge>
                </div>
              </div>

              <h4 className="mt-3 text-[11px] font-medium uppercase tracking-wide text-(--color-ink-3)">
                Load-bearing claims
              </h4>
              <ul className="mt-1.5 space-y-2">
                {c.claims.map((cl: any, i: number) => {
                  const stripped = (c.stripped_claims ?? []).includes(cl.text);
                  return (
                    <li
                      key={i}
                      className={`rounded border px-2.5 py-2 ${
                        stripped ? 'border-[#e8cdcd] bg-[#f8e9e9]' : 'border-(--color-rule) bg-(--color-paper)'
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <Badge tone={CLAIM_TONE[cl.status as keyof typeof CLAIM_TONE]}>
                          {cl.status.replace(/_/g, ' ')}
                        </Badge>
                        <p className={`flex-1 text-[12px] leading-relaxed ${stripped ? 'line-through opacity-70' : ''}`}>
                          {cl.text}
                        </p>
                      </div>
                      {cl.note && <p className="mt-1 text-[11px] text-(--color-ink-3)">{cl.note}</p>}
                      {cl.sources?.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-2">
                          {cl.sources.map((s: any, k: number) => (
                            <a
                              key={k}
                              href={s.url}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="text-[11px] text-(--color-accent-2) underline underline-offset-2"
                            >
                              {s.outlet_id} · {hostOf(s.url)}
                            </a>
                          ))}
                        </div>
                      )}
                      {stripped && (
                        <p className="mt-1 text-[11px] font-medium text-(--color-bad)">
                          Stripped — downstream concepts may not use this, explicitly or by implication.
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>

              {c.falsification_attempts?.length > 0 && (
                <>
                  <h4 className="mt-3 text-[11px] font-medium uppercase tracking-wide text-(--color-ink-3)">
                    Refutation attempts
                  </h4>
                  <p className="text-[11px] text-(--color-ink-3)">
                    A verifier that only confirms has not verified. These are the attempts to break it.
                  </p>
                  <ul className="mt-1.5 space-y-1.5">
                    {c.falsification_attempts.map((f: any, i: number) => (
                      <li key={i} className="flex items-start gap-2">
                        <Badge tone={OUTCOME_TONE[f.outcome as keyof typeof OUTCOME_TONE]}>{f.outcome}</Badge>
                        <div className="min-w-0 flex-1">
                          <p className="text-[12px] text-(--color-ink-2)">{f.attempted}</p>
                          {f.note && <p className="text-[11px] text-(--color-ink-3)">{f.note}</p>}
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Card>
          );
        })}
      </ul>
    </div>
  );
}
