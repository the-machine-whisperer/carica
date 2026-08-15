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

/** @typedef {'pending'|'running'|'ok'|'failed'|'skipped'} StageStatus */

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
  };
}

/**
 * @param {Array<any>} events
 * @returns {{
 *   runId: string|null, mode: string|null, model: string|null, concurrency: number|null,
 *   status: 'idle'|'running'|'complete'|'failed'|'awaiting_human',
 *   startedAt: string|null, endedAt: string|null, failedStage: string|null,
 *   humanRequired: {stage:string,message:string}|null,
 *   stages: Record<string, ReturnType<typeof blankStage>>,
 *   order: string[], lastSeq: number, eventCount: number
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
    humanRequired: null,
    stages,
    order: STAGE_ORDER,
    lastSeq: 0,
    eventCount: 0,
  };

  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    state.eventCount++;
    if (typeof e.seq === 'number' && e.seq > state.lastSeq) state.lastSeq = e.seq;

    // Shard events carry labels like "harvest:Ynet"; fold them onto the parent stage.
    const s = e.stage && stages[e.stage] ? stages[e.stage] : null;

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
        break;

      case 'stage.start':
        if (!s) break;
        // A shard starting must not reset a parent that is already running.
        if (s.status !== 'running') {
          s.status = 'running';
          s.startedAt = e.ts ?? null;
        }
        if (e.artifact && !e.label?.includes(':')) s.artifact = e.artifact;
        if (e.replay || e.mode === 'replay') s.replay = true;
        break;

      case 'stage.progress':
        if (!s) break;
        if (e.message) s.progress.push({ ts: e.ts, message: e.message });
        if (typeof e.shards === 'number') s.shards = e.shards;
        if (e.degraded) s.degraded = true;
        break;

      case 'agent.spawn':
        if (!s) break;
        if (typeof e.attempt === 'number') s.attempts = Math.max(s.attempts, e.attempt);
        break;

      case 'agent.retry':
        if (!s) break;
        s.retries.push({ attempt: e.attempt, reason: e.reason, errors: e.errors ?? [], label: e.label });
        break;

      case 'artifact.write':
        if (!s) break;
        if (e.artifact && !e.label?.includes(':')) s.artifact = e.artifact;
        if (typeof e.evidence_records === 'number') s.evidenceRecords = e.evidence_records;
        if (typeof e.evidence_refs === 'number') s.evidenceRefs = e.evidence_refs;
        break;

      case 'stage.end': {
        if (!s) break;
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

      case 'stage.error':
        if (!s) break;
        s.status = 'failed';
        s.endedAt = e.ts ?? null;
        if (typeof e.durationMs === 'number') s.durationMs = e.durationMs;
        s.errors.push(...(e.errors ?? []));
        break;

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

  // Derive duration where the emitter did not supply one.
  for (const id of STAGE_ORDER) {
    const s = stages[id];
    if (s.durationMs == null && s.startedAt && s.endedAt) {
      s.durationMs = new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime();
    }
  }

  return state;
}

/** Convenience: the stage the user most likely wants to be looking at right now. */
export function activeStage(state) {
  const running = STAGE_ORDER.find((id) => state.stages[id].status === 'running');
  if (running) return running;
  if (state.humanRequired) return state.humanRequired.stage;
  if (state.failedStage) return state.failedStage;
  const done = STAGE_ORDER.filter((id) => state.stages[id].status === 'ok');
  return done.length ? done[done.length - 1] : STAGE_ORDER[0];
}
