import { useArtifact } from '../lib/hooks';
import { Badge, Card, Empty, ErrorNote, Loading, PanelHeader } from '../components/ui';
import type { ViewProps } from './types';

const VERDICT_TONE = { PASS: 'ok', REVISE: 'warn', BLOCK: 'bad' } as const;
const RESULT_MARK = { pass: '✓', fail: '✕', not_applicable: '–' } as const;

export function GateView({ runId, version }: ViewProps) {
  const { data, loading, error } = useArtifact<any>(runId, '09_gate.json', version);

  if (loading) return <Loading what="gate verdicts" />;
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Empty>This stage has not produced an artifact yet.</Empty>;

  const counts = data.verdicts.reduce((acc: any, v: any) => {
    acc[v.verdict] = (acc[v.verdict] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div>
      <PanelHeader
        n={9}
        title="Standards check"
        blurb="Adjudicated clause by clause against the editorial policy. §2 asks how an image will be read, not how it was meant."
        right={
          <div className="flex gap-1.5">
            {(['PASS', 'REVISE', 'BLOCK'] as const).map((v) =>
              counts[v] ? (
                <Badge key={v} tone={VERDICT_TONE[v]}>
                  {counts[v]} {v.toLowerCase()}
                </Badge>
              ) : null
            )}
          </div>
        }
      />

      <p className="mb-4 font-mono text-[10px] text-(--color-ink-3)">
        policy sha {String(data.policy_sha).slice(0, 16)}…
      </p>

      <ul className="space-y-3">
        {data.verdicts.map((v: any) => {
          const fails = v.checks.filter((c: any) => c.result === 'fail');
          return (
            <Card
              key={v.concept_id}
              as="li"
              className={
                v.verdict === 'BLOCK'
                  ? 'border-[#e8cdcd]'
                  : v.verdict === 'REVISE'
                    ? 'border-[#ecdcb6]'
                    : ''
              }
            >
              <header className="flex items-center justify-between gap-3 border-b border-(--color-rule) px-3 py-2">
                <span className="font-mono text-[12px] text-(--color-ink-2)">{v.concept_id}</span>
                <Badge tone={VERDICT_TONE[v.verdict as keyof typeof VERDICT_TONE]}>{v.verdict}</Badge>
              </header>

              <div className="px-3 py-2.5">
                {v.block_reason && (
                  <div className="mb-3 rounded border border-[#e8cdcd] bg-[#f8e9e9] px-2.5 py-2 text-[12px] text-(--color-bad)">
                    <span className="font-medium">Blocked.</span> {v.block_reason}
                  </div>
                )}

                {v.revision_asks?.length > 0 && (
                  <div className="mb-3 rounded border border-[#ecdcb6] bg-[#faf2e0] px-2.5 py-2">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-(--color-warn)">
                      Revision asks — specific and actionable
                    </div>
                    <ol className="mt-1 space-y-1">
                      {v.revision_asks.map((a: string, i: number) => (
                        <li key={i} className="flex gap-1.5 text-[12px] leading-relaxed text-(--color-ink-2)">
                          <span className="text-(--color-ink-3)">{i + 1}.</span>
                          {a}
                        </li>
                      ))}
                    </ol>
                  </div>
                )}

                {fails.length > 0 && (
                  <p className="mb-2 text-[11px] text-(--color-ink-3)">
                    {fails.length} clause{fails.length === 1 ? '' : 's'} failed, listed first.
                  </p>
                )}

                <ul className="space-y-1">
                  {[...v.checks]
                    .sort((a: any, b: any) => (a.result === 'fail' ? -1 : b.result === 'fail' ? 1 : 0))
                    .map((c: any, i: number) => (
                      <li
                        key={i}
                        className={`grid grid-cols-[1.25rem_11rem_1fr] items-start gap-2 rounded px-1.5 py-1 text-[12px] ${
                          c.result === 'fail' ? 'bg-[#f8e9e9]' : ''
                        }`}
                      >
                        <span
                          className={
                            c.result === 'fail'
                              ? 'text-(--color-bad)'
                              : c.result === 'pass'
                                ? 'text-(--color-ok)'
                                : 'text-(--color-ink-3)'
                          }
                        >
                          {RESULT_MARK[c.result as keyof typeof RESULT_MARK]}
                        </span>
                        <span className="font-medium text-(--color-ink-2)">{c.clause}</span>
                        <span className="leading-relaxed text-(--color-ink-2)">{c.reasoning}</span>
                      </li>
                    ))}
                </ul>
              </div>
            </Card>
          );
        })}
      </ul>
    </div>
  );
}
