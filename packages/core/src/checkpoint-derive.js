import { projectRun, STAGE_ORDER } from './projection.js';

/**
 * The half of the checkpoint that is pure arithmetic over events.
 *
 * Split out from checkpoint.js for exactly the reason browser.js is split out from index.js:
 * deriving a checkpoint is something the review app wants to do (it already holds the whole
 * event stream, and the resume picker is drawn there), while reading and writing state.json
 * is something only a machine with a run directory can do. Keeping the two in one file would
 * drag node:fs into the browser bundle to get at a function that never touches a file.
 *
 * Import checkpoint.js, not this — it re-exports everything here alongside the disk half.
 * This file exists to be importable WITHOUT the disk half, and for no other reason.
 */

export const CHECKPOINT_FILE = 'state.json';
export const CHECKPOINT_SCHEMA_VERSION = '1.0';

/**
 * Build the checkpoint for a run from its events. PURE.
 *
 * Deliberately takes no clock: `updated_at` comes from the last event's own timestamp, so
 * the same log always derives the same checkpoint. A clock read here would mean two
 * processes deriving a checkpoint from identical events produce different files, and then
 * the file could not be used to tell whether anything had actually changed.
 *
 * Stage titles live in packages/pipeline (`stages.js`) and cannot be imported: pipeline
 * imports core, and reversing that is a cycle. So the caller passes them in as `stageMeta`
 * and this falls back to the bare id — an ugly resume picker beats a dependency loop.
 *
 * @param {any[]} events
 * @param {{manifest?: any, stageMeta?: Record<string, {n?: number, title?: string}>, now?: string}} [opts]
 */
export function deriveCheckpoint(events = [], opts = {}) {
  const { manifest = null, stageMeta = {}, now = null } = opts;
  const state = projectRun(events);

  // `from` — the step this run was told to start at — is only ever stated once, in
  // run.start, and the projection has no reason to carry it. Fish it out here.
  let from = manifest?.config?.started_at_stage ?? null;
  let lastTs = null;
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.ts === 'string') lastTs = e.ts;
    if (e.type === 'run.start' && e.from != null) from = e.from;
  }

  /** @type {Record<string, any>} */
  const stages = {};
  for (const id of STAGE_ORDER) {
    const s = state.stages[id];
    /** @type {Record<string, any>} */
    const jobs = {};
    for (const jid of s.jobOrder) {
      const j = s.jobs[jid];
      jobs[jid] = {
        key: j.key,
        label: j.label,
        status: j.status,
        artifact: j.artifact,
        started_at: j.startedAt,
        ended_at: j.endedAt,
        attempts: j.attempts,
      };
    }
    stages[id] = {
      // `paused` is a flag on the projected stage rather than a status, because the work
      // still has a state of its own underneath the hold. The checkpoint has one field, so
      // the hold is what it reports — that is what a resume picker has to act on.
      status: s.paused && s.status === 'running' ? 'paused' : s.status,
      artifact: s.artifact,
      valid: isValid(s),
      started_at: s.startedAt,
      ended_at: s.endedAt,
      duration_ms: s.durationMs,
      jobs,
    };
  }

  return {
    schema_version: CHECKPOINT_SCHEMA_VERSION,
    run_id: state.runId ?? manifest?.run_id ?? null,
    updated_at: now ?? lastTs ?? manifest?.created_at ?? null,
    mode: state.mode ?? manifest?.config?.mode ?? null,
    status: state.status,
    from,
    stages,
    milestones: deriveMilestones(stages, stageMeta),
    control: {
      paused: state.paused,
      paused_stages: state.pausedStages,
      killed_jobs: state.killedJobs,
    },
  };
}

/**
 * Did this stage leave behind something the next one can actually use?
 *
 * Purity is the constraint: this cannot stat the file or run it past its JSON Schema, so it
 * answers from the log — the stage ended well and named an artifact. That is a claim, not a
 * proof, which is why the resume path re-validates every artifact against its contract
 * before it trusts one. This only has to be good enough to decide what to OFFER.
 */
function isValid(s) {
  return Boolean(s.artifact) && (s.status === 'ok' || s.status === 'skipped');
}

/**
 * The points in the run a person could sensibly start from.
 *
 * Every stage that produced a usable artifact, plus the first one that has not — the "next
 * thing to do", which is the option people want most and the one a list of completed steps
 * never contains.
 *
 * `resumable` is a stricter question than "did this finish". Starting at stage 7 means
 * stages 1–6 must ALL have their artifacts on disk, because stage 7 reads them. One gap
 * anywhere earlier makes every later milestone a dead end, so resumability stops at the
 * first gap rather than being decided stage by stage.
 */
function deriveMilestones(stages, stageMeta) {
  const out = [];
  let contiguous = true;
  let offeredNext = false;

  for (let i = 0; i < STAGE_ORDER.length; i++) {
    const id = STAGE_ORDER[i];
    const s = stages[id];
    const meta = stageMeta?.[id] ?? {};
    const include = s.valid || !offeredNext;
    if (!s.valid) offeredNext = true;

    if (include) {
      out.push({
        stage: id,
        n: meta.n ?? i + 1,
        title: meta.title ?? id,
        at: s.ended_at ?? s.started_at ?? null,
        resumable: contiguous,
      });
    }
    if (!s.valid) contiguous = false;
  }
  return out;
}

/** Where this run can be picked up again — the milestones that are actually offerable. */
export function resumePoints(checkpoint) {
  const milestones = checkpoint?.milestones;
  if (!Array.isArray(milestones)) return [];
  return milestones.filter((m) => m && m.resumable);
}
