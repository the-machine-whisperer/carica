import { useArtifact } from '../lib/hooks';
import { Badge, Bar, Card, Empty, ErrorNote, Loading, PanelHeader, Rule } from '../components/ui';
import { Bidi, Glossed } from '../lib/bidi';
import type { ViewProps } from './types';

const CENSOR_TONE = { none: 'neutral', possible: 'warn', likely: 'bad' } as const;

export function TriageView({ runId, version }: ViewProps) {
  const { data, loading, error } = useArtifact<any>(runId, '04_triage.json', version);
  const { data: stories } = useArtifact<any>(runId, '03_stories.json', version);

  if (loading) return <Loading what="triage" />;
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Empty>This stage has not produced an artifact yet.</Empty>;

  const byId = new Map((stories?.stories ?? []).map((s: any) => [s.id, s]));
  const kept = [...data.kept].sort((a: any, b: any) => b.salience - a.salience);
  const flagged = kept.filter((k: any) => k.censor_risk !== 'none' || k.sub_judice);

  return (
    <div>
      <PanelHeader
        n={4}
        title="Filter and flag"
        blurb="Political filter, public-figure test, and the legal flags that decide what can be drawn at all"
        right={
          <div className="flex gap-2">
            <Badge tone="ok">{data.kept.length} kept</Badge>
            {data.dropped.length > 0 && <Badge tone="neutral">{data.dropped.length} dropped</Badge>}
            {flagged.length > 0 && <Badge tone="warn">{flagged.length} flagged</Badge>}
          </div>
        }
      />

      <ul className="space-y-2">
        {kept.map((k: any) => {
          const story: any = byId.get(k.story_id);
          return (
            <Card key={k.story_id} as="li" className="px-3 py-2.5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  {story ? (
                    <Glossed
                      he={story.title_he}
                      en={story.title_en}
                      heClass="font-serif text-[15px] leading-snug"
                      enClass="mt-0.5 text-[12px] text-(--color-ink-3)"
                    />
                  ) : (
                    <span className="font-mono text-[12px]">{k.story_id}</span>
                  )}
                </div>
                <div className="flex w-28 shrink-0 flex-col items-end gap-1">
                  <span className="font-serif text-lg tabular-nums text-(--color-ink)">{k.salience.toFixed(1)}</span>
                  <Bar value={k.salience} />
                  <span className="text-[10px] uppercase tracking-wide text-(--color-ink-3)">salience</span>
                </div>
              </div>

              <div className="mt-2 flex flex-wrap gap-1.5">
                {k.domains.map((d: string) => (
                  <Badge key={d} tone="neutral">
                    {d.replace(/_/g, ' ')}
                  </Badge>
                ))}
                <Badge tone={CENSOR_TONE[k.censor_risk as keyof typeof CENSOR_TONE]}>
                  censor: {k.censor_risk}
                </Badge>
                {k.sub_judice && <Badge tone="warn">sub judice</Badge>}
              </div>

              <p className="mt-2 text-[12px] leading-relaxed text-(--color-ink-2)">{k.rationale}</p>

              <div className="mt-2 space-y-1">
                {k.figures.map((f: any, i: number) => (
                  <div key={i} className="flex flex-wrap items-baseline gap-2 text-[12px]">
                    <Bidi text={f.name_he} dir="rtl" className="font-medium" />
                    <span className="text-(--color-ink-2)">{f.name_en}</span>
                    <span className="text-(--color-ink-3)">— {f.role}</span>
                    {f.public_figure ? (
                      <Badge tone="ok" title={f.basis}>
                        public figure
                      </Badge>
                    ) : (
                      <Badge tone="bad" title="§2.5 — cannot be caricatured">
                        private individual
                      </Badge>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          );
        })}
      </ul>

      {data.dropped?.length > 0 && (
        <>
          <Rule>Dropped — nothing vanishes silently</Rule>
          <ul className="space-y-1">
            {data.dropped.map((d: any) => (
              <li key={d.story_id} className="flex items-baseline gap-2 text-[12px]">
                <Badge tone="neutral">{d.reason.replace(/_/g, ' ')}</Badge>
                <span className="font-mono text-[11px] text-(--color-ink-3)">{d.story_id}</span>
                {d.note && <span className="text-(--color-ink-2)">{d.note}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
