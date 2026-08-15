import { useArtifact } from '../lib/hooks';
import { Badge, Bar, Card, Disclosure, Empty, ErrorNote, Kv, Loading, PanelHeader, Rule } from '../components/ui';
import { Bidi } from '../lib/bidi';
import { OUTLET_DATA_BASIS, OUTLET_SIGNAL_LABEL } from '../lib/copy';
import { hostOf, num } from '../lib/format';
import type { ViewProps } from './types';

/**
 * Every reach number in this panel is a proxy. There is no paid traffic API anywhere in
 * this project, so the agent works from free, open, no-login sources and declares which —
 * and this panel's job is to make sure nobody carries a proxied rank into print as if it
 * were a measured visit count.
 */
export function OutletsView({ runId, version }: ViewProps) {
  const { data, loading, error } = useArtifact<any>(runId, '01_outlets.json', version);
  const { data: evidence } = useArtifact<{ records: any[] }>(runId, '01_outlets.evidence.jsonl', version);

  if (loading) return <Loading what="outlet ranking" />;
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Empty>This stage has not produced an artifact yet.</Empty>;

  const byId = new Map((evidence?.records ?? []).map((r: any) => [r.evidence_id, r]));
  const basis = OUTLET_DATA_BASIS[data.data_basis] ?? OUTLET_DATA_BASIS.mixed;
  const max = Math.max(...data.outlets.map((o: any) => o.composite_score), 1);

  return (
    <div>
      <PanelHeader
        n={1}
        title="News sources"
        blurb="Which Israeli outlets are actually shaping the conversation right now"
        right={
          <Badge tone={basis.tone} title={basis.text}>
            {basis.label}
          </Badge>
        }
      />

      <div
        className={`mb-5 rounded-md border px-3 py-2 text-[12px] ${
          basis.tone === 'ok'
            ? 'border-[#cbe2d4] bg-[#eaf3ed] text-(--color-ok)'
            : 'border-[#ecdcb6] bg-[#faf2e0] text-(--color-warn)'
        }`}
      >
        {basis.text}
      </div>

      <ol className="space-y-2">
        {data.outlets.map((o: any) => (
          <Card key={o.id} as="li" className="px-3 py-2.5">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 w-6 shrink-0 text-end font-serif text-lg tabular-nums text-(--color-ink-3)">
                {o.rank}
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <a
                    href={o.homepage}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="font-medium text-(--color-ink) hover:text-(--color-accent)"
                  >
                    {o.name_en}
                  </a>
                  <Bidi text={o.name_he} className="text-[13px] text-(--color-ink-3)" />
                  <Badge tone="neutral">{o.lean.replace(/-/g, ' ')}</Badge>
                  {o.paywall && o.paywall !== 'none' && (
                    <Badge tone={o.paywall === 'hard' ? 'warn' : 'neutral'} title="Excerpt handling is constrained">
                      {o.paywall} paywall
                    </Badge>
                  )}
                  {o.robots_allowed === false && <Badge tone="bad">robots disallow</Badge>}
                </div>

                <div className="mt-2 grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1">
                  {(
                    [
                      ['reach', o.reach_score],
                      ['engagement', o.engagement_score],
                      ['authority', o.authority_score],
                    ] as const
                  ).map(([label, v]) => (
                    <ScoreRow key={label} label={label} value={v} max={100} />
                  ))}
                  <span className="text-[11px] font-medium text-(--color-ink-2)">composite</span>
                  <Bar value={o.composite_score} max={max} />
                  <span className="w-10 text-end font-serif text-[13px] tabular-nums text-(--color-ink)">
                    {o.composite_score.toFixed(1)}
                  </span>
                </div>

                <div className="mt-2">
                  <Disclosure summary="signals and their evidence" count={o.signals.length}>
                    <ul className="space-y-1.5">
                      {o.signals.map((s: any, i: number) => {
                        const ev = byId.get(s.evidence_id);
                        return (
                          <li key={i} className="rounded border border-(--color-rule) bg-(--color-paper) px-2 py-1.5">
                            <div className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
                              <span className="font-medium text-(--color-ink-2)">
                                {OUTLET_SIGNAL_LABEL[s.kind] ?? s.kind.replace(/_/g, ' ')}
                              </span>
                              <span className="font-serif tabular-nums text-(--color-ink)">{num(Number(s.value))}</span>
                              {s.unit && <span className="text-[11px] text-(--color-ink-3)">{s.unit}</span>}
                            </div>
                            {ev ? (
                              <div className="mt-1 text-[11px] text-(--color-ink-3)">
                                {ev.summary}{' '}
                                {ev.url && (
                                  <a
                                    href={ev.url}
                                    target="_blank"
                                    rel="noreferrer noopener"
                                    className="text-(--color-accent-2) underline underline-offset-2"
                                  >
                                    {hostOf(ev.url)}
                                  </a>
                                )}
                                {ev.command && <code className="font-mono">{ev.command}</code>}
                              </div>
                            ) : (
                              <div className="mt-1 text-[11px] text-(--color-bad)">
                                no evidence record for {s.evidence_id}
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </Disclosure>
                </div>

                <dl className="mt-2 flex flex-wrap gap-x-4">
                  {o.ownership && <Kv k="owner" v={o.ownership} />}
                  <Kv
                    k="feeds"
                    v={o.feeds
                      .map((f: any) => `${f.section ?? f.kind}${f.verified === false ? ' (unverified)' : ''}`)
                      .join(', ')}
                  />
                </dl>
              </div>
            </div>
          </Card>
        ))}
      </ol>

      {data.excluded?.length > 0 && (
        <>
          <Rule>Excluded — recorded gaps, not silent omissions</Rule>
          <ul className="space-y-1">
            {data.excluded.map((e: any) => (
              <li key={e.id} className="text-[12px] text-(--color-ink-2)">
                <span className="font-medium">{e.id}</span> — {e.reason}
              </li>
            ))}
          </ul>
        </>
      )}

      {data.notes && (
        <>
          <Rule>Combination rule</Rule>
          <p className="text-[12px] text-(--color-ink-2)">{data.notes}</p>
        </>
      )}
    </div>
  );
}

function ScoreRow({ label, value, max }: { label: string; value: number; max: number }) {
  return (
    <>
      <span className="text-[11px] text-(--color-ink-3)">{label}</span>
      <Bar value={value} max={max} />
      <span className="w-10 text-end text-[11px] tabular-nums text-(--color-ink-3)">{value}</span>
    </>
  );
}
