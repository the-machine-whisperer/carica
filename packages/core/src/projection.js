/**
 * events.ndjson  →  run state.
 *
 * The review app holds no state of its own: it is a pure projection of the run directory.
 * Reload reprojects, a finished run is a scrubbable replay, and there is no database to
 * fall out of sync. This function is that projection, and it lives in core (not the UI)
 * so the server, the CLI and the app all agree on what "stage 5 is running" means.
 *
 * Pure. Same events in, same state out, always.
 */

export const STAGE_ORDER = [
  'outlets',
  'harvest',
  'cluster',
  'triage',
  'score',
  'verify',
  'ideate',
  'prompt',
  'gate',
  'render',
  'publish',
];

/** @typedef {'pending'|'running'|'paused'|'ok'|'failed'|'killed'|'skipped'} StageStatus */
/** @typedef {'pending'|'running'|'paused'|'ok'|'failed'|'killed'|'skipped'} JobStatus */

/**
 * How much of the agent's working history a stage keeps.
 *
 * Bounded on purpose: a long stage emits hundreds of activity events, and this projection
 * is recomputed in the browser on every event that arrives. Keeping the recent tail is what
 * a watcher actually wants — the whole history is in the run's transcript either way.
 */
export const ACTIVITY_LIMIT = 60;

/**
 * How much of that history each individual JOB keeps.
 *
 * Much smaller than ACTIVITY_LIMIT, and the arithmetic is the reason: a harvest fans out to
 * eighteen outlets, and eighteen jobs holding sixty entries each is over a thousand objects
 * rebuilt from scratch every time a single event lands. A job tile shows the last handful of
 * moves — that is what it is for. The stage feed, which is the surface people actually read
 * at length, keeps the long tail.
 */
export const JOB_ACTIVITY_LIMIT = 20;

const BLANK_COUNTS = () => ({ command: 0, search: 0, file: 0, message: 0, thinking: 0, tool: 0, plan: 0 });

function blankStage(id) {
  return {
    id,
    status: /** @type {StageStatus} */ ('pending'),
    startedAt: null,
    endedAt: null,
    durationMs: null,
    attempts: 0,
    retries: [],
    errors: [],
    artifact: null,
    evidenceRecords: null,
    evidenceRefs: null,
    shards: null,
    shardsCompleted: 0,
    progress: [],
    replay: false,
    degraded: false,
    /**
     * The step did not fail — the app did, somewhere inside this step.
     *
     * Kept separate from `errors` because it changes what the failure MEANS and therefore
     * what the reader should do about it. Every other failure here is a report about the
     * work: the agent ran and its output was rejected, or the runtime would not start. This
     * one says the pipeline's own code threw, so there is nothing to fix in the run and
     * retrying is futile until somebody patches the app. The UI must not offer the
     * contract-violation explanation for it; that sent a real editor looking for a bad
     * artifact behind a crash that never wrote one.
     */
    crashed: false,
    /** The trimmed stack, for the person who fixes it. Never shown by default. */
    crashStack: /** @type {string|null} */ (null),
    /** What the agent has been doing, most recent last. See ACTIVITY_LIMIT. */
    activity: [],
    activityCounts: BLANK_COUNTS(),
    tokens: null,
    /**
     * The units of agent work inside this stage, keyed by job id.
     *
     * A plain stage has exactly one, whose id IS the stage id, so the UI can draw every
     * node with the same component instead of special-casing "the stage that happens to
     * be a single agent". A fanned-out stage has one per shard and no self-job: the
     * parent's own events (the merge, the final artifact, the stage-wide error) describe
     * the stage, not a job, and folding them onto a phantom job would invent work nobody
     * did.
     */
    jobs: /** @type {Record<string, ReturnType<typeof blankJob>>} */ ({}),
    /** Job ids in first-seen order, so a grid of shards does not reshuffle as they finish. */
    jobOrder: /** @type {string[]} */ ([]),
    /** An editor has held this stage. Distinct from status, which still says what the work is doing. */
    paused: false,
  };
}

function blankJob(id, stageId, key, label) {
  return {
    id,
    stageId,
    /** The stable key — `ynet`, not `Ynet`. What the control channel names. */
    key,
    /** What a person should read. Falls back to the key when nothing better was emitted. */
    label,
    status: /** @type {JobStatus} */ ('pending'),
    startedAt: null,
    endedAt: null,
    durationMs: null,
    attempts: 0,
    retries: [],
    errors: [],
    artifact: null,
    evidenceRecords: null,
    tokens: null,
    /** This job's own recent moves. See JOB_ACTIVITY_LIMIT. */
    activity: [],
    activityCounts: BLANK_COUNTS(),
    lastActivity: /** @type {any} */ (null),
    exitCode: null,
    /** Why it ended this way, when a person or the pipeline said so in words. */
    reason: null,
  };
}

/** A job an editor stopped stays stopped. Nothing arriving later gets to overrule that. */
const CONTROL_TERMINAL = new Set(['killed', 'skipped']);

const isStr = (v) => typeof v === 'string' && v.length > 0;

/**
 * Which job does this event belong to?
 *
 * Two vocabularies have to work at once. New emitters carry `job_id` / `shard_key` /
 * `shard_label` explicitly. Everything already on disk carries only `label`, which is
 * `"<stageId>:<display name>"` for a shard and the bare stage id otherwise. Preferring the
 * explicit fields and falling back to the label is what lets a run directory recorded last
 * week still open in the same UI — the run directory is the only source of truth, so it had
 * better keep being readable.
 *
 * Note the fallback derives the job id from the DISPLAY label, giving `harvest:Ynet` where a
 * new log would say `harvest:ynet`. Within one log that is consistent, which is all identity
 * has to be here: job ids are never compared across runs.
 */
function jobIdentity(e, stageId) {
  const label = isStr(e.label) ? e.label : null;
  const colon = label ? label.indexOf(':') : -1;
  const labelSuffix = colon !== -1 ? label.slice(colon + 1) : null;
  const shardKey = isStr(e.shard_key) ? e.shard_key : null;

  let id;
  let key;
  if (isStr(e.job_id)) {
    id = e.job_id;
    const at = id.indexOf(':');
    key = shardKey ?? (at !== -1 ? id.slice(at + 1) : id);
  } else if (shardKey) {
    id = `${stageId}:${shardKey}`;
    key = shardKey;
  } else if (labelSuffix) {
    id = `${stageId}:${labelSuffix}`;
    key = labelSuffix;
  } else {
    id = stageId;
    key = stageId;
  }

  const display = isStr(e.shard_label) ? e.shard_label : (labelSuffix ?? (id === stageId ? stageId : key));
  return { id, key, label: display, explicitLabel: isStr(e.shard_label) };
}

/** One thing that happened, in the shape both the stage feed and the job feed store it. */
function activityEntry(e) {
  return {
    ts: e.ts ?? null,
    kind: e.kind,
    status: e.status ?? 'completed',
    text: e.text ?? '',
    label: e.label ?? null,
    itemId: e.item_id ?? null,
    exitCode: e.exit_code ?? null,
    output: e.output ?? null,
    files: e.files ?? null,
    queries: e.queries ?? null,
  };
}

/**
 * Append an entry to a bounded feed, or update the entry it supersedes.
 *
 * A command announced and then finished is ONE thing that happened. Updating it in place is
 * what makes the feed read as a command going from running to its exit code, rather than as
 * the same command twice. The counts only move on the first sighting, for the same reason.
 */
function pushActivity(target, entry, limit) {
  const prior = entry.itemId ? target.activity.findIndex((a) => a.itemId === entry.itemId) : -1;
  if (prior !== -1) {
    target.activity[prior] = { ...target.activity[prior], ...entry, startedAt: target.activity[prior].ts };
    return;
  }
  target.activity.push(entry);
  if (target.activityCounts[entry.kind] != null) target.activityCounts[entry.kind]++;
  if (target.activity.length > limit) target.activity.shift();
}

/**
 * @param {Array<any>} events
 * @returns {{
 *   runId: string|null, mode: string|null, model: string|null, concurrency: number|null,
 *   status: 'idle'|'running'|'complete'|'failed'|'awaiting_human'|'cancelled',
 *   startedAt: string|null, endedAt: string|null, failedStage: string|null, endReason: string|null,
 *   humanRequired: {stage:string,message:string}|null,
 *   lastActivity: any,
 *   stages: Record<string, ReturnType<typeof blankStage>>,
 *   order: string[], lastSeq: number, eventCount: number,
 *   paused: boolean, pausedStages: string[], killedJobs: string[],
 *   jobTotals: {running:number, ok:number, failed:number, killed:number, skipped:number, paused:number, pending:number}
 * }}
 */
export function projectRun(events = []) {
  /** @type {Record<string, any>} */
  const stages = {};
  for (const id of STAGE_ORDER) stages[id] = blankStage(id);

  const state = {
    runId: null,
    mode: null,
    model: null,
    concurrency: null,
    status: /** @type {any} */ ('idle'),
    startedAt: null,
    endedAt: null,
    failedStage: null,
    /** Whatever `run.end` said about why it ended. Null when it ended normally. */
    endReason: /** @type {string|null} */ (null),
    humanRequired: null,
    /** The single most recent thing any agent did, for a one-line "what is happening now". */
    lastActivity: /** @type {any} */ (null),
    stages,
    order: STAGE_ORDER,
    lastSeq: 0,
    eventCount: 0,
    /** The editor has held the whole run. */
    paused: false,
    pausedStages: /** @type {string[]} */ ([]),
    killedJobs: /** @type {string[]} */ ([]),
    /** A one-glance tally for the header, so it never has to walk eleven stages of jobs. */
    jobTotals: { running: 0, ok: 0, failed: 0, killed: 0, skipped: 0, paused: 0, pending: 0 },
  };

  /**
   * Which stages have proven themselves to be fan-outs.
   *
   * Kept here rather than on the stage because it is scaffolding for the fold, not state
   * anyone should read: a consumer that wants to know asks whether the stage has more than
   * one job, or whether `shards` is set.
   *
   * The awkwardness this handles is one of ordering. A fanned stage announces itself with
   * `stage.progress {shards: n}` — but a parent `stage.start` may already have arrived and
   * created a self-job by then. So the moment a stage is revealed as a fan-out, any self-job
   * it accumulated is dropped: the parent's own events belong to the stage, and a job that
   * stands for "the stage as a whole" would double-count every shard's work.
   */
  const fanned = new Set();
  const markFanned = (stageId) => {
    if (fanned.has(stageId)) return;
    fanned.add(stageId);
    const s = stages[stageId];
    if (!s || !s.jobs[stageId]) return;
    delete s.jobs[stageId];
    s.jobOrder = s.jobOrder.filter((jid) => jid !== stageId);
  };

  /**
   * The job an event belongs to, creating it on first sight.
   *
   * Returns null when the event is the parent's own, on a stage that fans out — there is
   * deliberately no job to put it on.
   */
  const jobFor = (e, stageId, create = true) => {
    const s = stages[stageId];
    const ident = jobIdentity(e, stageId);
    if (ident.id !== stageId) markFanned(stageId);
    if (ident.id === stageId && fanned.has(stageId)) return null;

    let job = s.jobs[ident.id];
    if (!job) {
      if (!create) return null;
      job = blankJob(ident.id, stageId, ident.key, ident.label);
      s.jobs[ident.id] = job;
      s.jobOrder.push(ident.id);
    } else if (ident.explicitLabel) {
      // An emitter that names the display label wins over one derived from the id.
      job.label = ident.label;
    }
    return job;
  };

  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    state.eventCount++;
    if (typeof e.seq === 'number' && e.seq > state.lastSeq) state.lastSeq = e.seq;

    // Shard events carry labels like "harvest:Ynet"; fold them onto the parent stage.
    const s = e.stage && stages[e.stage] ? stages[e.stage] : null;

    // A shard count on a stage's own event is the stage saying it fans out, whether it says
    // so on the way in (`stage.progress`) or on the way out (`stage.end`).
    if (s && typeof e.shards === 'number' && e.shards > 0) markFanned(e.stage);

    switch (e.type) {
      case 'run.start':
        state.runId = e.run_id ?? state.runId;
        state.mode = e.mode ?? null;
        state.model = e.model ?? null;
        state.concurrency = e.concurrency ?? null;
        state.startedAt = e.ts ?? null;
        state.status = 'running';
        break;

      case 'run.end':
        state.endedAt = e.ts ?? null;
        state.status = e.status ?? 'complete';
        state.failedStage = e.failed_stage ?? null;
        // How the run ENDED, in its own words. This was being dropped, and it is the only
        // thing written down about a run that died without naming a step — the case where
        // the screen otherwise has nothing at all to show and says "A step could not produce
        // a usable result", which names nothing and is not necessarily even true.
        state.endReason = isStr(e.reason) ? e.reason : null;
        break;

      case 'run.paused':
        state.paused = true;
        break;

      case 'run.resumed':
        state.paused = false;
        break;

      case 'stage.start': {
        if (!s) break;
        // A shard starting must not reset a parent that is already running.
        if (s.status !== 'running') {
          s.status = 'running';
          s.startedAt = e.ts ?? null;
        }
        if (e.artifact && !e.label?.includes(':')) s.artifact = e.artifact;
        if (e.replay || e.mode === 'replay') s.replay = true;

        const job = jobFor(e, e.stage);
        if (job && !CONTROL_TERMINAL.has(job.status)) {
          job.status = 'running';
          if (!job.startedAt) job.startedAt = e.ts ?? null;
          // A shard's artifact IS its part file — unlike the stage, which keeps the merged
          // one — so it is recorded without the label check the stage needs.
          if (e.artifact) job.artifact = e.artifact;
        }
        break;
      }

      case 'stage.progress':
        if (!s) break;
        if (e.message) s.progress.push({ ts: e.ts, message: e.message });
        if (typeof e.shards === 'number') s.shards = e.shards;
        if (e.degraded) s.degraded = true;
        break;

      case 'agent.spawn': {
        if (!s) break;
        if (typeof e.attempt === 'number') s.attempts = Math.max(s.attempts, e.attempt);
        const job = jobFor(e, e.stage);
        if (job && typeof e.attempt === 'number') job.attempts = Math.max(job.attempts, e.attempt);
        break;
      }

      case 'agent.retry': {
        if (!s) break;
        s.retries.push({ attempt: e.attempt, reason: e.reason, errors: e.errors ?? [], label: e.label });
        // A retry starts the agent over. Its previous rummaging is no longer what is
        // happening, and leaving it on screen reads as progress that is not being made.
        s.activity = [];
        const job = jobFor(e, e.stage);
        if (job) {
          job.retries.push({ attempt: e.attempt, reason: e.reason, errors: e.errors ?? [], label: e.label });
          job.activity = [];
          if (typeof e.attempt === 'number') job.attempts = Math.max(job.attempts, e.attempt);
        }
        break;
      }

      case 'agent.activity': {
        if (!s) break;
        const job = jobFor(e, e.stage);
        if (e.kind === 'usage') {
          s.tokens = e.usage ?? s.tokens;
          if (job) job.tokens = e.usage ?? job.tokens;
          break;
        }
        const entry = activityEntry(e);
        pushActivity(s, entry, ACTIVITY_LIMIT);
        if (job) {
          pushActivity(job, entry, JOB_ACTIVITY_LIMIT);
          job.lastActivity = entry;
        }
        state.lastActivity = { ...entry, stage: e.stage, jobId: job?.id ?? e.stage };
        break;
      }

      case 'artifact.write': {
        if (!s) break;
        if (e.artifact && !e.label?.includes(':')) s.artifact = e.artifact;
        if (typeof e.evidence_records === 'number') s.evidenceRecords = e.evidence_records;
        if (typeof e.evidence_refs === 'number') s.evidenceRefs = e.evidence_refs;
        const job = jobFor(e, e.stage);
        if (job) {
          if (e.artifact) job.artifact = e.artifact;
          if (typeof e.evidence_records === 'number') job.evidenceRecords = e.evidence_records;
        }
        break;
      }

      case 'stage.end': {
        if (!s) break;
        const job = jobFor(e, e.stage);
        if (job && !CONTROL_TERMINAL.has(job.status)) {
          // The editor's decision outranks the agent's outcome. A shard that was killed and
          // then reported "ok" milliseconds later did not succeed — it was stopped, and
          // telling the person who stopped it that it finished is a lie the log can prove.
          job.status = e.skipped ? 'skipped' : e.ok ? 'ok' : 'failed';
          job.endedAt = e.ts ?? null;
          if (typeof e.durationMs === 'number') job.durationMs = e.durationMs;
          if (typeof e.exit_code === 'number') job.exitCode = e.exit_code;
          if (isStr(e.reason)) job.reason = e.reason;
        }

        const isShard = typeof e.label === 'string' && e.label.includes(':');
        if (isShard) {
          if (e.ok) s.shardsCompleted++;
          break;
        }
        s.status = e.skipped ? 'skipped' : e.ok ? 'ok' : 'failed';
        s.endedAt = e.ts ?? null;
        if (typeof e.durationMs === 'number') s.durationMs = e.durationMs;
        if (typeof e.shards === 'number') s.shardsCompleted = e.shards;
        if (e.replay) s.replay = true;
        break;
      }

      case 'stage.error': {
        if (!s) break;
        s.status = 'failed';
        s.endedAt = e.ts ?? null;
        if (typeof e.durationMs === 'number') s.durationMs = e.durationMs;
        s.errors.push(...(e.errors ?? []));
        if (e.crash) {
          s.crashed = true;
          s.crashStack = typeof e.stack === 'string' ? e.stack : null;
        }
        const job = jobFor(e, e.stage);
        if (job && !CONTROL_TERMINAL.has(job.status)) {
          job.status = 'failed';
          job.endedAt = e.ts ?? null;
          if (typeof e.durationMs === 'number') job.durationMs = e.durationMs;
          if (typeof e.exit_code === 'number') job.exitCode = e.exit_code;
          job.errors.push(...(e.errors ?? []));
        }
        break;
      }

      case 'job.paused': {
        if (!s) break;
        const job = jobFor(e, e.stage);
        if (job && !CONTROL_TERMINAL.has(job.status)) job.status = 'paused';
        break;
      }

      case 'job.resumed': {
        if (!s) break;
        const job = jobFor(e, e.stage);
        if (job && job.status === 'paused') job.status = 'running';
        break;
      }

      case 'job.killed': {
        if (!s) break;
        const job = jobFor(e, e.stage);
        if (job) {
          job.status = 'killed';
          job.endedAt = e.ts ?? null;
          job.reason = isStr(e.reason) ? e.reason : job.reason;
        }
        break;
      }

      case 'job.skipped': {
        if (!s) break;
        const job = jobFor(e, e.stage);
        if (job) {
          job.status = 'skipped';
          job.endedAt = e.ts ?? null;
          job.reason = isStr(e.reason) ? e.reason : job.reason;
        }
        break;
      }

      case 'stage.paused': {
        if (!s) break;
        s.paused = true;
        // Holding a stage holds everything inside it. Leaving a shard reading "running"
        // while nothing is running is the one thing a control surface must never do.
        for (const jid of s.jobOrder) {
          const j = s.jobs[jid];
          if (j.status === 'running') j.status = 'paused';
        }
        break;
      }

      case 'stage.resumed': {
        if (!s) break;
        s.paused = false;
        for (const jid of s.jobOrder) {
          const j = s.jobs[jid];
          if (j.status === 'paused') j.status = 'running';
        }
        break;
      }

      case 'human.required':
        state.humanRequired = { stage: e.stage, message: e.message ?? '' };
        state.status = 'awaiting_human';
        break;

      case 'human.decision':
        state.humanRequired = null;
        break;

      default:
        break;
    }
  }

  for (const id of STAGE_ORDER) {
    const s = stages[id];
    // Derive duration where the emitter did not supply one.
    if (s.durationMs == null && s.startedAt && s.endedAt) {
      s.durationMs = new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime();
    }
    if (s.paused) state.pausedStages.push(id);

    let allStopped = s.jobOrder.length > 0;
    for (const jid of s.jobOrder) {
      const j = s.jobs[jid];
      if (j.durationMs == null && j.startedAt && j.endedAt) {
        j.durationMs = new Date(j.endedAt).getTime() - new Date(j.startedAt).getTime();
      }
      if (state.jobTotals[j.status] != null) state.jobTotals[j.status]++;
      if (j.status === 'killed') state.killedJobs.push(jid);
      if (!CONTROL_TERMINAL.has(j.status)) allStopped = false;
    }

    // Every job stopped by hand means the stage produced nothing — but it did not FAIL.
    // Reporting the editor's own decision back to them as a failure is both wrong and
    // insulting: nothing went wrong, they stopped it, and the run should say so.
    if (allStopped && s.status !== 'skipped') s.status = 'skipped';
  }

  return state;
}

/**
 * A stage's jobs, in the order they were first seen.
 *
 * Every surface that draws jobs wants this order and none of them should re-derive it:
 * sorting by name reshuffles a grid the moment an outlet is renamed, and sorting by status
 * makes tiles jump past each other as they finish, which is exactly when someone is looking
 * at them.
 *
 * @param {{stages: Record<string, any>}} state
 * @param {string} stageId
 */
export function jobsOf(state, stageId) {
  const s = state?.stages?.[stageId];
  if (!s) return [];
  return s.jobOrder.map((id) => s.jobs[id]).filter(Boolean);
}

/** Convenience: the stage the user most likely wants to be looking at right now. */
export function activeStage(state) {
  // A held stage is not where the action is. If something else is genuinely running, that
  // is what the person came to watch; the paused one is only the answer when nothing is.
  const running = STAGE_ORDER.find(
    (id) => state.stages[id].status === 'running' && !state.stages[id].paused
  );
  if (running) return running;
  const held = STAGE_ORDER.find((id) => state.stages[id].status === 'running');
  if (held) return held;
  if (state.humanRequired) return state.humanRequired.stage;
  if (state.failedStage) return state.failedStage;
  const done = STAGE_ORDER.filter((id) => state.stages[id].status === 'ok');
  return done.length ? done[done.length - 1] : STAGE_ORDER[0];
}
