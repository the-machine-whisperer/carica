import { useMemo, useState } from 'react';
import { useArtifact } from '../lib/hooks';
import { Badge, Card, Empty, ErrorNote, Loading, PanelHeader, Rule } from '../components/ui';
import { Bidi } from '../lib/bidi';
import { clock, hostOf, num } from '../lib/format';
import type { ViewProps } from './types';

export function HarvestView({ runId, version }: ViewProps) {
  const { data, loading, error } = useArtifact<any>(runId, '02_items.json', version);
  const [outlet, setOutlet] = useState<string>('');

  const items = useMemo(() => {
    if (!data) return [];
    const list = outlet ? data.items.filter((i: any) => i.outlet_id === outlet) : data.items;
    return [...list].sort((a: any, b: any) => (a.published_at < b.published_at ? 1 : -1));
  }, [data, outlet]);

  if (loading) return <Loading what="harvest" />;
  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Empty>This stage has not produced an artifact yet.</Empty>;

  const failed = data.outlet_status.filter((s: any) => !s.ok);
  const totalComments = data.items.reduce((n: number, i: any) => n + (i.engagement?.comments ?? 0), 0);

  return (
    <div>
      <PanelHeader
        n={2}
        title="Collect coverage"
        blurb={`${data.items.length} items from ${data.outlet_status.filter((s: any) => s.ok).length} outlets`}
        right={
          <div className="flex items-center gap-2">
            {failed.length > 0 && <Badge tone="warn">{failed.length} outlet(s) failed</Badge>}
            <Badge tone="neutral">{num(totalComments)} comments</Badge>
          </div>
        }
      />

      {failed.length > 0 && (
        <div className="mb-4 rounded-md border border-[#ecdcb6] bg-[#faf2e0] px-3 py-2 text-[12px] text-(--color-warn)">
          <div className="font-medium">Coverage gaps this run</div>
          <ul className="mt-1 space-y-0.5">
            {failed.map((s: any) => (
              <li key={s.outlet_id}>
                <span className="font-medium">{s.outlet_id}</span> — {s.error ?? 'no items'}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[11px] opacity-80">
            A failed outlet is recorded rather than dropped, so downstream breadth counts can be read honestly.
          </p>
        </div>
      )}

      <div className="mb-3 flex flex-wrap gap-1.5">
        <FilterChip active={outlet === ''} onClick={() => setOutlet('')} label={`all (${data.items.length})`} />
        {data.outlet_status.map((s: any) => (
          <FilterChip
            key={s.outlet_id}
            active={outlet === s.outlet_id}
            onClick={() => setOutlet(s.outlet_id)}
            label={`${s.outlet_id} (${s.item_count})`}
            failed={!s.ok}
          />
        ))}
      </div>

      <ul className="grid gap-2 md:grid-cols-2">
        {items.map((it: any) => (
          <Card key={it.id} as="li" className="flex flex-col gap-1.5 px-3 py-2.5">
            <div className="flex items-center gap-2 text-[11px] text-(--color-ink-3)">
              <span className="font-medium text-(--color-ink-2)">{it.outlet_id}</span>
              <span>{clock(it.published_at)}</span>
              {it.section && <span>· {it.section}</span>}
              {it.paywalled && <Badge tone="warn">paywalled — headline only</Badge>}
            </div>

            <a href={it.url} target="_blank" rel="noreferrer noopener" className="hover:text-(--color-accent)">
              <Bidi as="h3" text={it.title} dir={it.dir} className="font-serif text-[15px] leading-snug" />
            </a>

            {it.dek && <Bidi as="p" text={it.dek} dir={it.dir} className="text-[12px] text-(--color-ink-2)" />}
            {it.excerpt && (
              <Bidi as="p" text={it.excerpt} dir={it.dir} className="text-[12px] text-(--color-ink-3)" />
            )}

            <div className="mt-auto flex flex-wrap items-center gap-2 pt-1 text-[11px] text-(--color-ink-3)">
              {it.engagement?.comments != null && <Badge tone="accent">{num(it.engagement.comments)} talkbacks</Badge>}
              {it.engagement?.shares != null && <Badge tone="neutral">{num(it.engagement.shares)} shares</Badge>}
              {it.engagement?.rotter_threads != null && (
                <Badge tone="neutral" title="Rotter.net is a velocity signal, not public opinion">
                  {it.engagement.rotter_threads} rotter
                </Badge>
              )}
              <span className="ms-auto">{hostOf(it.url)}</span>
            </div>
          </Card>
        ))}
      </ul>

      {items.length === 0 && <Empty>No items for this filter.</Empty>}

      <Rule>Fetch status</Rule>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-start text-[11px] uppercase tracking-wide text-(--color-ink-3)">
            <th className="py-1 text-start font-medium">outlet</th>
            <th className="py-1 text-start font-medium">items</th>
            <th className="py-1 text-start font-medium">robots</th>
            <th className="py-1 text-start font-medium">note</th>
          </tr>
        </thead>
        <tbody>
          {data.outlet_status.map((s: any) => (
            <tr key={s.outlet_id} className="border-t border-(--color-rule)">
              <td className="py-1 font-medium text-(--color-ink-2)">{s.outlet_id}</td>
              <td className="py-1 tabular-nums">{s.item_count}</td>
              <td className="py-1">{s.robots_allowed ? 'allowed' : 'disallowed'}</td>
              <td className="py-1 text-(--color-ink-3)">{s.error ?? (s.ok ? 'ok' : '')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  failed,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  failed?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-2.5 py-0.5 text-[11px] ${
        active
          ? 'border-(--color-accent) bg-(--color-accent) text-white'
          : failed
            ? 'border-[#e8cdcd] bg-[#f8e9e9] text-(--color-bad)'
            : 'border-(--color-rule) bg-white text-(--color-ink-2) hover:bg-(--color-paper-2)'
      }`}
    >
      {label}
    </button>
  );
}
