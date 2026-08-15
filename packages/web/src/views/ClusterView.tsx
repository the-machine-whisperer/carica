import { useArtifact } from '../lib/hooks';
import { Badge, Card, Disclosure, Empty, ErrorNote, Loading, PanelHeader } from '../components/ui';
import { Bidi, Glossed } from '../lib/bidi';
import { clock, num } from '../lib/format';
import type { ViewProps } from './types';

export function ClusterView({ runId, version }: ViewProps) {
  const { data, loading, error } = useArtifact<any>(runId, '03_stories.json', version);
  const { data: items } = useArtifact<any>(runId, '02_items.json', version);

  if (loading) return <Loading what="story clusters" />;
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Empty>This stage has not produced an artifact yet.</Empty>;

  const itemById = new Map((items?.items ?? []).map((i: any) => [i.id, i]));
  const stories = [...data.stories].sort((a: any, b: any) => b.outlet_breadth - a.outlet_breadth);

  return (
    <div>
      <PanelHeader
        n={3}
        title="Group into stories"
        blurb="Candidates are stories, not articles — breadth across outlets is itself an impact signal"
        right={<Badge tone="neutral">{data.stories.length} stories</Badge>}
      />

      <ul className="space-y-3">
        {stories.map((s: any) => (
          <Card key={s.id} as="li" className="px-3 py-3">
            <div className="flex items-start justify-between gap-4">
              <Glossed
                he={s.title_he}
                en={s.title_en}
                className="min-w-0"
                heClass="font-serif text-[16px] leading-snug"
                enClass="mt-0.5 text-[13px] text-(--color-ink-3)"
              />
              <div className="flex shrink-0 flex-col items-end gap-1">
                <Badge tone={s.outlet_breadth >= 3 ? 'accent' : 'neutral'}>
                  covered by {s.outlet_breadth} outlet{s.outlet_breadth === 1 ? '' : 's'}
                </Badge>
                {s.engagement_total?.comments != null && (
                  <Badge tone="neutral">{num(s.engagement_total.comments)} talkbacks</Badge>
                )}
              </div>
            </div>

            <p className="mt-2 text-[13px] leading-relaxed text-(--color-ink-2)">{s.summary_en}</p>

            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-(--color-ink-3)">
              <span>first seen {clock(s.first_seen)}</span>
              <span>· last updated {clock(s.last_updated)}</span>
              {(s.outlet_ids ?? []).map((o: string) => (
                <span key={o} className="rounded bg-(--color-paper-2) px-1.5 py-0.5">
                  {o}
                </span>
              ))}
            </div>

            {s.name_variants_merged?.length > 0 && (
              <div className="mt-3 rounded border border-(--color-rule) bg-(--color-paper) px-2.5 py-2">
                <div className="text-[11px] font-medium uppercase tracking-wide text-(--color-ink-3)">
                  Hebrew name merges
                </div>
                <p className="mt-0.5 text-[11px] text-(--color-ink-3)">
                  The one judgement in this pipeline no arithmetic can check — recorded so it can be audited.
                </p>
                <ul className="mt-1.5 space-y-1">
                  {s.name_variants_merged.map((m: any, i: number) => (
                    <li key={i} className="flex flex-wrap items-center gap-1.5 text-[12px]">
                      <Bidi text={m.canonical} dir="rtl" className="font-medium text-(--color-ink)" />
                      <span className="text-(--color-ink-3)">←</span>
                      {m.variants.map((v: string, k: number) => (
                        <Bidi
                          key={k}
                          text={v}
                          dir="rtl"
                          className="rounded bg-(--color-paper-2) px-1.5 py-0.5 text-(--color-ink-2)"
                        />
                      ))}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-2">
              <Disclosure summary="member articles" count={s.member_item_ids.length}>
                <ul className="space-y-1">
                  {s.member_item_ids.map((id: string) => {
                    const it: any = itemById.get(id);
                    if (!it) return <li key={id} className="text-[12px] text-(--color-ink-3)">{id}</li>;
                    return (
                      <li key={id} className="flex items-baseline gap-2">
                        <span className="shrink-0 text-[11px] text-(--color-ink-3)">{it.outlet_id}</span>
                        <a href={it.url} target="_blank" rel="noreferrer noopener" className="min-w-0 hover:text-(--color-accent)">
                          <Bidi text={it.title} dir={it.dir} className="text-[12px]" />
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </Disclosure>
            </div>
          </Card>
        ))}
      </ul>

      {data.unclustered_item_ids?.length > 0 && (
        <p className="mt-4 text-[12px] text-(--color-ink-3)">
          {data.unclustered_item_ids.length} item(s) stood alone and were not forced into a cluster.
        </p>
      )}
    </div>
  );
}
