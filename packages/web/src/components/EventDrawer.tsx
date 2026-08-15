import { useEffect, useMemo, useRef, useState } from 'react';
import { clock } from '../lib/format';
import { STAGE_META } from '../lib/copy';

/**
 * Everything that happened, in order, straight from the run's own log.
 *
 * Two readings of the same events: plain, which is a narrative anyone can follow while a
 * run is going, and technical, which is the raw event stream for when something has gone
 * wrong and the exact sequence matters. Neither is a summary of the other — they are the
 * same lines, told at different resolutions.
 */

const stageName = (id?: string) => (id ? (STAGE_META[id]?.title ?? id) : '');

/** The narrative version. Returns null for events not worth a line in plain mode. */
function plainSummary(e: any): string | null {
  const shard = typeof e.label === 'string' && e.label.includes(':') ? e.label.split(':').slice(1).join(':') : null;
  switch (e.type) {
    case 'run.start':
      return e.mode === 'replay' ? 'Practice run started, using saved data.' : 'Run started.';
    case 'run.end':
      return e.status === 'complete'
        ? 'All steps finished.'
        : e.status === 'awaiting_human'
          ? 'Paused — waiting for your approval.'
          : e.status === 'cancelled'
            ? 'Stopped.'
            : `Stopped at ${stageName(e.failed_stage)}.`;
    case 'stage.start':
      return shard ? null : `${stageName(e.stage)} — started.`;
    case 'stage.progress':
      return `${stageName(e.stage)} — ${e.message ?? ''}`;
    case 'stage.end':
      if (shard) return null;
      return e.skipped
        ? `${stageName(e.stage)} — reused the result from before.`
        : e.ok
          ? `${stageName(e.stage)} — done${e.shards ? ` (${e.shards} parallel jobs)` : ''}.`
          : `${stageName(e.stage)} — could not finish.`;
    case 'stage.error':
      return `${stageName(e.stage)} — failed its checks: ${(e.errors ?? []).slice(0, 1).join('')}`;
    case 'agent.retry':
      return `${stageName(e.stage)} — the result did not pass its checks; trying again with the errors (attempt ${e.attempt}).`;
    case 'artifact.write':
      return shard
        ? null
        : `${stageName(e.stage)} — result saved${e.evidence_records ? `, ${e.evidence_records} sources recorded` : ''}.`;
    case 'human.required':
      return 'Waiting for your approval.';
    case 'human.decision':
      return `You recorded: ${String(e.decision).replace(/_/g, ' ')} for ${e.concept_id}.`;
    default:
      return null;
  }
}

const TONE: Record<string, string> = {
  'run.start': 'text-sky-300',
  'run.end': 'text-sky-300',
  'stage.start': 'text-neutral-200',
  'stage.end': 'text-emerald-300',
  'stage.error': 'text-red-300',
  'stage.progress': 'text-neutral-400',
  'agent.spawn': 'text-violet-300',
  'agent.retry': 'text-amber-300',
  'artifact.write': 'text-emerald-200',
  'human.required': 'text-amber-200',
  'human.decision': 'text-amber-200',
};

function summarise(e: any): string {
  switch (e.type) {
    case 'run.start':
      return `${e.run_id} [${e.mode}] model=${e.model} concurrency=${e.concurrency}`;
    case 'run.end':
      return `${e.status}${e.failed_stage ? ` (failed at ${e.failed_stage})` : ''}`;
    case 'stage.start':
      return `${e.label ?? e.stage} → ${e.artifact ?? ''}`;
    case 'stage.end':
      return `${e.label ?? e.stage} ${e.ok ? 'ok' : 'failed'}${e.skipped ? ' (skipped, artifact already valid)' : ''}${
        e.shards ? ` ${e.shards} shards` : ''
      }`;
    case 'stage.error':
      return `${e.label ?? e.stage}: ${(e.errors ?? []).slice(0, 2).join(' | ')}`;
    case 'stage.progress':
      return `${e.stage}: ${e.message ?? ''}`;
    case 'agent.spawn':
      return `${e.label ?? e.stage} attempt ${e.attempt}${e.network ? ' [net]' : ''}`;
    case 'agent.retry':
      return `${e.label ?? e.stage} retry ${e.attempt} — ${e.reason}`;
    case 'artifact.write':
      return `${e.artifact} (${e.evidence_records ?? 0} evidence records${
        e.merged_from ? `, merged from ${e.merged_from}` : ''
      })`;
    case 'human.required':
      return e.message ?? '';
    case 'human.decision':
      return `${e.decision} — ${e.concept_id} by ${e.decided_by}`;
    default:
      return '';
  }
}

export function EventDrawer({ events }: { events: any[] }) {
  const [open, setOpen] = useState(false);
  const [technical, setTechnical] = useState(false);
  const [filter, setFilter] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const shown = useMemo(() => {
    const base = technical ? events : events.filter((e) => plainSummary(e) !== null);
    if (!filter.trim()) return base;
    const q = filter.toLowerCase();
    return base.filter((e) => JSON.stringify(e).toLowerCase().includes(q));
  }, [events, filter, technical]);

  const lastPlain = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const s = plainSummary(events[i]);
      if (s) return s;
    }
    return null;
  }, [events]);

  useEffect(() => {
    if (open && stick.current && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [shown.length, open]);

  return (
    <section
      className={`flex shrink-0 flex-col border-t border-(--color-rule) bg-[#191817] text-neutral-200 ${
        open ? 'h-64' : 'h-9'
      }`}
      aria-label="Activity"
    >
      <div className="flex h-9 shrink-0 items-center gap-3 px-3">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex items-center gap-2 text-[11.5px] text-neutral-400 hover:text-neutral-100"
        >
          <span className={`inline-block text-[9px] transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
          Activity
          <span className="tabular-nums text-neutral-500">{events.length}</span>
        </button>

        {!open && lastPlain && <span className="truncate text-[11.5px] text-neutral-500">{lastPlain}</span>}

        {open && (
          <div className="ms-auto flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[11px] text-neutral-500">
              <input
                type="checkbox"
                checked={technical}
                onChange={(e) => setTechnical(e.target.checked)}
                className="accent-neutral-400"
              />
              technical detail
            </label>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter…"
              aria-label="Filter activity"
              className="w-48 rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 font-mono text-[11px] text-neutral-200 placeholder:text-neutral-600"
            />
          </div>
        )}
      </div>

      {open && (
        <div
          ref={bodyRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
          className={`scrollbar-thin flex-1 overflow-y-auto px-3 pb-2 leading-5 ${
            technical ? 'font-mono text-[11px]' : 'text-[12px]'
          }`}
        >
          {shown.map((e, i) =>
            technical ? (
              <div key={`${e.seq}-${i}`} className="flex gap-2">
                <span className="shrink-0 tabular-nums text-neutral-600">{String(e.seq).padStart(3, ' ')}</span>
                <span className="shrink-0 tabular-nums text-neutral-600">{clock(e.ts)}</span>
                <span className={`shrink-0 ${TONE[e.type] ?? 'text-neutral-300'}`}>{e.type}</span>
                <span className="min-w-0 break-words text-neutral-400">{summarise(e)}</span>
              </div>
            ) : (
              <div key={`${e.seq}-${i}`} className="flex gap-2.5">
                <span className="shrink-0 tabular-nums text-[11px] text-neutral-600">{clock(e.ts)}</span>
                <span className={`min-w-0 break-words ${TONE[e.type] ?? 'text-neutral-300'}`}>{plainSummary(e)}</span>
              </div>
            )
          )}
          {shown.length === 0 && <div className="py-4 text-neutral-600">Nothing yet.</div>}
        </div>
      )}
    </section>
  );
}
