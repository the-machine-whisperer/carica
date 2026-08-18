import type { JobState } from '@carica/core/browser';
import type { ControlAction } from '../lib/api';

/**
 * One unit of agent work, the size of a postage stamp.
 *
 * A harvest fans out to one agent per outlet, so a step can hold eighteen of these at once
 * and an editor needs to read the lot in a glance: which are working, which came back,
 * which never will. Everything here is therefore said twice — once as a colour, once as a
 * glyph, and once again as text for a screen reader — because a grid where the only
 * difference between "done" and "stopped" is a shade of green is a grid nobody can trust.
 */

export interface JobStatusMeta {
  /** Shown in the tile. Never the only carrier of meaning. */
  glyph: string;
  /** What an editor should read, in their words rather than the pipeline's. */
  label: string;
  /** One line of explanation, for the tile's tooltip and the detail panel. */
  hint: string;
  text: string;
  chip: string;
}

export const JOB_STATUS: Record<string, JobStatusMeta> = {
  pending: {
    glyph: '·',
    label: 'Not started',
    hint: 'Queued. Nothing has been asked of it yet.',
    text: 'text-(--color-ink-3)',
    chip: 'border-(--color-rule) bg-(--color-paper-2) text-(--color-ink-3)',
  },
  running: {
    glyph: '●',
    label: 'Working',
    hint: 'An agent is on this now.',
    text: 'text-(--color-warn)',
    chip: 'border-[#ecdcb6] bg-[#faf2e0] text-(--color-warn)',
  },
  paused: {
    glyph: '⏸',
    label: 'Held',
    hint: 'You held this. It is exactly where it was and can carry on whenever you say.',
    text: 'text-(--color-warn)',
    chip: 'border-[#ecdcb6] bg-[#faf2e0] text-(--color-warn)',
  },
  ok: {
    glyph: '✓',
    label: 'Done',
    hint: 'It finished and its result passed its checks.',
    text: 'text-(--color-ok)',
    chip: 'border-[#cbe2d4] bg-[#eaf3ed] text-(--color-ok)',
  },
  failed: {
    glyph: '✕',
    label: 'Problem',
    hint: 'It could not produce a usable result. The reason is recorded.',
    text: 'text-(--color-bad)',
    chip: 'border-[#e8cdcd] bg-[#f8e9e9] text-(--color-bad)',
  },
  killed: {
    glyph: '⊘',
    label: 'Stopped by you',
    hint: 'You stopped this one. The gap it leaves is recorded on the step.',
    text: 'text-(--color-bad)',
    chip: 'border-[#e8cdcd] bg-[#f8e9e9] text-(--color-bad)',
  },
  skipped: {
    glyph: '–',
    label: 'Left out',
    hint: 'It was not attempted, and the step says so rather than pretending otherwise.',
    text: 'text-(--color-ink-3)',
    chip: 'border-(--color-rule) bg-(--color-paper-2) text-(--color-ink-3)',
  },
};

export const jobStatusMeta = (status: string): JobStatusMeta => JOB_STATUS[status] ?? JOB_STATUS.pending;

/** What to call a job on screen: its display label, its key, or — for a plain step — nothing. */
export function jobName(job: JobState): string {
  return job.label ?? job.key ?? job.id;
}

export interface JobTileProps {
  job: JobState;
  /** Name to show. Defaults to the job's own; a plain step passes its own short title. */
  name?: string;
  /** An action asked for and not yet confirmed by the run. Never a status. */
  busy?: ControlAction | null;
  /** This tile's job is the one open in the detail panel. */
  open?: boolean;
  onOpen: () => void;
  onControl: (action: ControlAction) => void;
  /** Hide the inline pause/stop buttons — a finished run has nothing to steer. */
  steerable?: boolean;
}

export function JobTile({ job, name, busy, open, onOpen, onControl, steerable = true }: JobTileProps) {
  const meta = jobStatusMeta(job.status);
  const label = name ?? jobName(job);
  const running = job.status === 'running';
  const held = job.status === 'paused';
  const live = steerable && (running || held || job.status === 'pending');

  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        onClick={onOpen}
        aria-current={open ? 'true' : undefined}
        title={`${label} — ${meta.label}. ${meta.hint}`}
        className={`flex w-[86px] items-center gap-1 rounded-sm border px-1 py-[3px] text-start text-[10.5px] transition-colors ${meta.chip} ${
          open ? 'ring-1 ring-(--color-accent)' : 'hover:border-(--color-ink-3)'
        }`}
      >
        <span aria-hidden className={`shrink-0 text-[9px] leading-none ${running && !busy ? 'live-dot' : ''}`}>
          {busy ? '⋯' : meta.glyph}
        </span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {job.attempts > 1 && (
          <span aria-hidden className="shrink-0 tabular-nums text-[9px] opacity-70" title={`Tried ${job.attempts} times`}>
            ↺{job.attempts - 1}
          </span>
        )}
        <span className="sr-only">
          {' '}— {meta.label}
          {job.attempts > 1 ? `, retried ${job.attempts - 1} time${job.attempts === 2 ? '' : 's'}` : ''}
          {busy ? `, ${busy === 'pause' ? 'holding' : busy === 'resume' ? 'letting go' : busy === 'kill' ? 'stopping' : 'leaving out'}…` : ''}
        </span>
      </button>

      {/* Steering, one click away but out of the way until it is wanted. */}
      {live && (
        <span className="absolute -top-2 end-0 z-10 hidden gap-px rounded border border-(--color-rule) bg-white shadow-sm group-hover:flex group-focus-within:flex">
          <button
            type="button"
            onClick={() => onControl(held ? 'resume' : 'pause')}
            title={held ? `Let ${label} carry on` : `Hold ${label} where it is`}
            className="px-1 py-px text-[9px] leading-none text-(--color-ink-2) hover:bg-(--color-paper-2)"
          >
            <span aria-hidden>{held ? '▶' : '⏸'}</span>
            <span className="sr-only">{held ? `Let ${label} carry on` : `Hold ${label}`}</span>
          </button>
          <button
            type="button"
            onClick={() => onControl('kill')}
            title={`Stop ${label} — you will be asked to confirm`}
            className="px-1 py-px text-[9px] leading-none text-(--color-bad) hover:bg-[#f8e9e9]"
          >
            <span aria-hidden>⊘</span>
            <span className="sr-only">Stop {label}</span>
          </button>
        </span>
      )}
    </span>
  );
}
