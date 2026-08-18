import { useEffect, useRef, useState } from 'react';
import { clock } from '../lib/format';

/**
 * What the agent is doing, as it does it.
 *
 * A step can run for minutes behind a single spinner, which gives an editor no way to tell
 * deliberate work from a stall. This is the agent's own event stream — the commands it
 * runs, what it searches for, the files it writes, what it says about its plan — rendered
 * as it arrives. It is a window, not a record: the run's transcript is the record.
 *
 * Everything here comes from the projection, so a reload mid-run rebuilds it exactly and a
 * finished run still shows how it got there.
 */

type Entry = {
  ts: string | null;
  kind: string;
  status: string;
  text: string;
  label: string | null;
  itemId: string | null;
  exitCode: number | null;
  output: string | null;
  files: string[] | null;
  queries: string[] | null;
};

const KIND: Record<string, { icon: string; label: string; tone: string }> = {
  command: { icon: '⌘', label: 'ran', tone: 'text-(--color-ink-2)' },
  search: { icon: '⌕', label: 'searched', tone: 'text-sky-700' },
  file: { icon: '✎', label: 'wrote', tone: 'text-violet-700' },
  message: { icon: '“', label: 'said', tone: 'text-(--color-ink)' },
  thinking: { icon: '⋯', label: 'thinking', tone: 'text-(--color-ink-3)' },
  tool: { icon: '⚙', label: 'tool', tone: 'text-(--color-ink-2)' },
  plan: { icon: '☰', label: 'plan', tone: 'text-(--color-ink-2)' },
};

/** The shard an entry belongs to, when a step fanned out ("harvest:Ynet" → "Ynet"). */
const shardOf = (label: string | null) =>
  label && label.includes(':') ? label.split(':').slice(1).join(':') : null;

function Row({ e }: { e: Entry }) {
  const [open, setOpen] = useState(false);
  const kind = KIND[e.kind] ?? { icon: '·', label: e.kind, tone: 'text-(--color-ink-2)' };
  const running = e.status === 'started';
  const failed = e.status === 'failed' || (e.exitCode != null && e.exitCode !== 0);
  const shard = shardOf(e.label);
  const expandable = !!(e.output || (e.queries && e.queries.length > 1));

  return (
    <li className="group flex gap-2 py-[3px] leading-[1.45]">
      <span
        className={`w-4 shrink-0 select-none text-center text-[11px] ${
          failed ? 'text-(--color-bad)' : running ? 'text-(--color-warn)' : kind.tone
        } ${running ? 'live-dot' : ''}`}
        title={kind.label}
        aria-hidden
      >
        {running ? '●' : failed ? '✕' : kind.icon}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          {shard && (
            <span className="shrink-0 rounded-sm bg-(--color-paper-2) px-1 text-[10px] text-(--color-ink-3)">
              {shard}
            </span>
          )}
          <button
            type="button"
            disabled={!expandable}
            onClick={() => setOpen((o) => !o)}
            className={`min-w-0 break-words text-start ${
              e.kind === 'command' ? 'font-mono text-[11px]' : 'text-[12px]'
            } ${failed ? 'text-(--color-bad)' : kind.tone} ${
              expandable ? 'cursor-pointer hover:underline underline-offset-2' : ''
            }`}
            title={expandable ? 'Show what came back' : undefined}
          >
            {e.text || kind.label}
          </button>
          {e.exitCode != null && e.exitCode !== 0 && (
            <span className="shrink-0 font-mono text-[10px] text-(--color-bad)">exit {e.exitCode}</span>
          )}
          {e.ts && (
            <span className="ms-auto shrink-0 tabular-nums text-[10px] text-(--color-ink-3) opacity-0 group-hover:opacity-100">
              {clock(e.ts)}
            </span>
          )}
        </div>

        {open && e.queries && e.queries.length > 1 && (
          <ul className="mt-1 space-y-0.5">
            {e.queries.map((q, i) => (
              <li key={i} className="text-[11px] text-(--color-ink-2)">
                · {q}
              </li>
            ))}
          </ul>
        )}
        {open && e.output && (
          <pre className="scrollbar-thin mt-1 max-h-32 overflow-auto rounded border border-(--color-rule) bg-(--color-paper-2) px-2 py-1 font-mono text-[10.5px] whitespace-pre-wrap text-(--color-ink-2)">
            {e.output}
          </pre>
        )}
      </div>
    </li>
  );
}

export function LiveActivity({
  activity,
  counts,
  tokens,
  running,
}: {
  activity: Entry[];
  counts?: Record<string, number>;
  tokens?: { input: number; cached: number; output: number; reasoning: number } | null;
  running: boolean;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Follow the tail while the agent is working, unless the reader has scrolled up to look
  // at something — then leave them where they are.
  useEffect(() => {
    if (stick.current && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [activity.length, activity[activity.length - 1]?.status]);

  if (!activity.length) {
    return (
      <div className="rounded-md border border-(--color-rule) bg-(--color-paper) px-3 py-2 text-[12px] text-(--color-ink-3)">
        {running ? 'The agent has started — waiting for its first move…' : 'No agent activity was recorded for this step.'}
      </div>
    );
  }

  const tally = [
    counts?.command ? `${counts.command} command${counts.command === 1 ? '' : 's'}` : null,
    counts?.search ? `${counts.search} search${counts.search === 1 ? '' : 'es'}` : null,
    counts?.file ? `${counts.file} file${counts.file === 1 ? '' : 's'} written` : null,
    tokens ? `${(tokens.input + tokens.output).toLocaleString('en-US')} tokens` : null,
  ].filter(Boolean);

  return (
    <section className="rounded-md border border-(--color-rule) bg-(--color-paper)" aria-label="What the agent is doing">
      <header className="flex items-center gap-2 border-b border-(--color-rule) px-3 py-1.5 text-[11px] text-(--color-ink-3)">
        <span className={`text-[10px] ${running ? 'live-dot text-(--color-live)' : ''}`}>{running ? '●' : '○'}</span>
        <span className="font-medium text-(--color-ink-2)">
          {running ? 'What the agent is doing' : 'What the agent did'}
        </span>
        {tally.length > 0 && <span className="ms-auto tabular-nums">{tally.join(' · ')}</span>}
      </header>

      <div
        ref={bodyRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="scrollbar-thin max-h-72 overflow-y-auto px-3 py-1.5"
      >
        <ul>
          {activity.map((e, i) => (
            <Row key={e.itemId ?? `${e.ts}-${i}`} e={e} />
          ))}
        </ul>
      </div>
    </section>
  );
}
