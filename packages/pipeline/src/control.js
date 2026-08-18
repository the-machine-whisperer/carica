import path from 'node:path';
import {
  readControl,
  tailControl,
  validateControlRecord,
  readEvents,
  readJson,
  deriveCheckpoint,
  writeCheckpoint,
} from '@carica/core';
import { STAGE_META } from './stages.js';

/**
 * The run's end of the control channel.
 *
 * `control.ndjson` is what the editor says to a run; this is the thing inside the run that
 * listens. Two facts about how instructions arrive shape everything below:
 *
 *   1. **Every instruction arrives more than once.** The server writes the record to
 *      `control.ndjson` first and then sends it over IPC, so a live worker sees it twice —
 *      once as a message, once as its own tail of the file it was written to. A resumed run
 *      sees it a third time, replaying the log before it starts. That is not a flaw in the
 *      delivery, it is the design: the file is what makes an instruction durable and the IPC
 *      is what makes it fast, and neither is allowed to be the only channel. So the applier
 *      is keyed on `request_id` and applying the same record five times is applying it once.
 *
 *   2. **Some instructions outlive the process they were aimed at and some do not.** A kill
 *      is a decision about WORK — "do not harvest Ynet this morning" — and it is still true
 *      tomorrow, so a resumed run replays it and declines that shard again. A pause is a
 *      hold on a RUNNING PROCESS; once that process is gone there is nothing being held, and
 *      a resumed run that started itself paused would look, to the person who just pressed
 *      Continue, exactly like a hang. So the replay honours kills and skips and deliberately
 *      does not re-impose a pause. Starting the run again IS the resume.
 *
 * Everything this applies goes through the job registry, which owns the pids, and every
 * instruction it hears produces BOTH halves of the pair — `control.request` when the run
 * first hears it, `control.applied` when it has done something about it. Both are written
 * here rather than one of them by the server, because the server writes no events at all:
 * this worker's EventBus owns the `seq` counter that every SSE client resumes from, and a
 * second writer would hand out a duplicate. An editor who pressed Kill and saw nothing
 * happen needs to be able to find out, from the run's own log, whether the run ever heard
 * them — and that answer is the request event, not the applied one.
 */

/** How much of the checkpoint's cost we are willing to pay for a shard finishing. */
export const CHECKPOINT_MIN_INTERVAL_MS = 750;

/**
 * state.json, kept roughly current as a run goes.
 *
 * Derived from `events.ndjson` on disk rather than from anything held in memory, because the
 * events are the authority and this file is only ever a cache of them. That also means a
 * resumed run's checkpoint covers the whole run, including the attempt before this process
 * existed, without this module having to know anything about resumption.
 *
 * `write()` NEVER THROWS. A run directory is evidence, not a transaction log: losing the
 * cheap read costs the runs list some speed and costs the run nothing at all, whereas taking
 * a run down because a cache could not be written would be an unforced disaster.
 *
 * @param {{dir: string, bus?: {emit: (t: string, p?: any) => any}, minIntervalMs?: number}} o
 */
export function createCheckpointer(o) {
  const { dir, bus = null, minIntervalMs = CHECKPOINT_MIN_INTERVAL_MS } = o;
  let lastWriteAt = 0;
  let skipped = 0;

  /**
   * @param {string} reason  what prompted this write — it goes in the event, so an operator
   *   reading the log can see the checkpoint keeping pace with the work
   * @param {{force?: boolean}} [opts] `force: false` throttles: a burst of eight shards
   *   finishing inside a second is one write, not eight. Every write that matters (a stage
   *   ending, a control record applied, the run closing out) is forced, so a throttled write
   *   being dropped only ever costs freshness between two writes that were going to happen.
   */
  function write(reason = 'stage.end', opts = {}) {
    const force = opts.force !== false;
    const now = Date.now();
    if (!force && now - lastWriteAt < minIntervalMs) {
      skipped++;
      return null;
    }
    try {
      const events = readEvents(path.join(dir, 'events.ndjson'));
      let manifest = null;
      try {
        manifest = readJson(path.join(dir, 'run.json'));
      } catch {
        /* a run with no readable manifest still has events, which is what matters here */
      }
      const checkpoint = deriveCheckpoint(events, { manifest, stageMeta: STAGE_META });
      writeCheckpoint(dir, checkpoint);
      lastWriteAt = Date.now();
      skipped = 0;
      bus?.emit('checkpoint.write', {
        reason,
        status: checkpoint.status,
        milestones: checkpoint.milestones.length,
        updated_at: checkpoint.updated_at,
      });
      return checkpoint;
    } catch {
      // Deliberately silent. There is no failure mode here worth a line in a run's permanent
      // record: the events are intact, and the checkpoint can be rebuilt from them by anyone
      // who wants it, at any time, for ever.
      return null;
    }
  }

  return { write, get deferred() { return skipped; } };
}

/**
 * Build the thing that applies control records to a live run.
 *
 * @param {{
 *   dir: string,
 *   bus: {emit: (t: string, p?: any) => any},
 *   jobs: ReturnType<import('@carica/codex').createJobRegistry>,
 *   onApplied?: (record: any, outcome: any) => void
 * }} o
 */
export function createControlApplier(o) {
  const { dir, bus, jobs, onApplied = null } = o;

  /** Every request_id this run has already acted on. See note 1 at the top of the file. */
  const seen = new Set();
  const heldStages = new Set();
  let runPaused = false;
  let runKilled = false;
  let runKillReason = null;
  let lastSeq = 0;
  let stopTail = null;

  const emit = (type, payload) => {
    try {
      bus.emit(type, payload);
    } catch {
      /* the event log must never be able to fail a control action */
    }
  };

  /**
   * The acknowledgement. `ok` answers "did this run act on it", which is not the same
   * question as "was the instruction reasonable": killing a shard that finished thirty
   * seconds ago is a perfectly sensible thing for an editor to have asked for and a thing
   * this run cannot do anything about, and the detail is where that gets said.
   */
  function announce(record, outcome) {
    emit('control.applied', {
      action: record?.action ?? null,
      target: record?.target ?? null,
      request_id: record?.request_id ?? null,
      by: record?.by ?? null,
      ok: outcome.ok !== false,
      enacted: outcome.enacted !== false,
      detail: outcome.detail ?? null,
      source: outcome.source ?? null,
    });
    if (onApplied) {
      try {
        onApplied(record, outcome);
      } catch {
        /* a checkpoint writer that throws must not take the run down with it */
      }
    }
    return outcome;
  }

  /**
   * @param {any} record a control record, from IPC, from the tail, or from the replay
   * @param {{source?: 'ipc'|'log'|'replay', replay?: boolean, retryKilled?: boolean}} [ctx]
   */
  function apply(record, ctx = {}) {
    const source = ctx.source ?? (ctx.replay ? 'replay' : 'ipc');
    const check = validateControlRecord(record);
    if (!check.ok) {
      // A malformed record is not acted on and IS acknowledged. It came from somewhere, and
      // silence would leave whoever sent it watching a run that appears to be ignoring them.
      return announce(record, {
        ok: false,
        enacted: false,
        source,
        detail: `not an instruction this run can act on: ${check.errors.join('; ')}`,
      });
    }

    if (typeof record.seq === 'number' && record.seq > lastSeq) lastSeq = record.seq;

    const id = record.request_id ?? null;
    if (id && seen.has(id)) {
      // The normal case, not an edge case: the IPC copy and the file copy of one click.
      // Nothing is done and nothing is said — a second `control.applied` for one instruction
      // would make the UI show the editor's single click twice.
      return { ok: true, enacted: false, duplicate: true, detail: 'already applied' };
    }
    if (id) seen.add(id);

    // The request half of the pair, and the run is the one that has to write it.
    //
    // The editor's click lands in `control.ndjson`, which the server writes — and the server
    // writes NO events, deliberately: this worker's EventBus owns `events.ndjson`'s `seq`
    // counter, and a second writer would hand out a duplicate `seq`, which is exactly what
    // every SSE client resumes from. So the only honest place to record that an instruction
    // exists is here, at the moment the run first hears it.
    //
    // Emitted once per `request_id`, before anything is done about it, so the gap between
    // hearing and acting stays visible instead of being collapsed into the acknowledgement.
    // `requested_at` carries the control record's own timestamp: that is when the person
    // pressed the button, which is not the same instant as this line being written, and the
    // difference between the two is precisely the lag an editor wants to be able to see.
    emit('control.request', {
      action: record.action,
      target: record.target,
      request_id: id,
      by: record.by ?? null,
      requested_at: record.ts ?? null,
      source,
    });

    const t = record.target;
    const by = record.by ?? 'editor';
    const stage = t.kind === 'run' ? null : t.stage;

    // A resumed run replaying its own log: kills and skips are decisions about work and are
    // re-applied; holds are not. See note 2 at the top of the file.
    if (ctx.replay) {
      if (record.action === 'pause' || record.action === 'resume') {
        return announce(record, {
          ok: true,
          enacted: false,
          source,
          detail:
            record.action === 'pause'
              ? 'a hold does not outlive the run it was holding — this run starts released'
              : 'nothing was being held when this run started',
        });
      }
      if (ctx.retryKilled && (record.action === 'kill' || record.action === 'skip')) {
        return announce(record, {
          ok: true,
          enacted: false,
          source,
          detail: 'you asked for the jobs you stopped to be tried again, so this is not being re-applied',
        });
      }
    }

    switch (record.action) {
      case 'pause': {
        if (t.kind === 'run') {
          jobs.pauseAll(by);
          runPaused = true;
          emit('run.paused', { by, request_id: id });
          return announce(record, { ok: true, source, detail: 'the run is held; nothing new will start' });
        }
        if (t.kind === 'stage') {
          jobs.pauseStage(stage, by);
          heldStages.add(stage);
          emit('stage.paused', { stage, by, request_id: id });
          return announce(record, { ok: true, source, detail: `${stage} is held` });
        }
        const res = jobs.pause(t.job_id, by);
        return announce(record, { ok: res.ok, enacted: res.ok, source, detail: res.detail });
      }

      case 'resume': {
        if (t.kind === 'run') {
          // The registry's resumeAll releases every hold there is, including stage-level
          // ones. That is its documented behaviour and it is the right one: an editor who
          // presses Resume on the whole run means the run, not "the run except the two
          // steps I held separately half an hour ago".
          jobs.resumeAll(by);
          runPaused = false;
          heldStages.clear();
          emit('run.resumed', { by, request_id: id });
          return announce(record, { ok: true, source, detail: 'the run is going again' });
        }
        if (t.kind === 'stage') {
          jobs.resumeStage(stage, by);
          heldStages.delete(stage);
          emit('stage.resumed', { stage, by, request_id: id });
          return announce(record, { ok: true, source, detail: `${stage} is going again` });
        }
        const res = jobs.resume(t.job_id, by);
        return announce(record, { ok: res.ok, enacted: res.ok, source, detail: res.detail });
      }

      case 'kill':
      case 'skip': {
        // Skip and kill are the same instruction told from two ends. "Skip this outlet" and
        // "stop this outlet" both mean the work does not happen: if it has not started it is
        // declined, if it is running it is terminated. They are kept as two words because
        // they read differently to a person — one is about a plan, the other about a process
        // — and the reason recorded says which one was pressed.
        const reason =
          record.action === 'skip' ? 'skipped by the editor' : 'stopped by the editor';

        if (t.kind === 'run') {
          if (record.action === 'skip') {
            return announce(record, {
              ok: false,
              enacted: false,
              source,
              detail: 'a whole run cannot be skipped — stop it, or skip the step you do not want',
            });
          }
          jobs.killAll(by, reason);
          runKilled = true;
          runKillReason = reason;
          return announce(record, { ok: true, source, detail: 'the run is stopping' });
        }
        if (t.kind === 'stage') {
          jobs.killStage(stage, by, reason);
          return announce(record, { ok: true, source, detail: `${stage} will not run` });
        }
        const res = jobs.kill(t.job_id, by, reason);
        return announce(record, { ok: res.ok !== false, source, detail: res.detail });
      }

      default:
        // Unreachable: validateControlRecord already refused anything else. Answered anyway,
        // because "unreachable" is a claim about today's vocabulary.
        return announce(record, { ok: false, enacted: false, source, detail: `unknown instruction: ${record.action}` });
    }
  }

  /**
   * Replay everything the editor said before this process existed.
   *
   * This is the whole of "a run remembers what you told it". Without it a resumed run
   * cheerfully re-runs the shard somebody killed twenty minutes ago: the killed shard wrote
   * no artifact, so every other signal on disk says it still needs doing, and only the
   * control log knows a person decided otherwise.
   *
   * @param {{retryKilled?: boolean}} [opts]
   */
  function replayLog(opts = {}) {
    let records = [];
    try {
      records = readControl(dir);
    } catch {
      // An unreadable control log is not a reason to refuse to run. It is a reason to say so
      // and carry on with what the run directory does hold.
      emit('stage.progress', { message: 'this run has a control log that could not be read; carrying on without it' });
      return { count: 0, lastSeq: 0 };
    }
    for (const rec of records) {
      apply(rec, { replay: true, source: 'replay', retryKilled: !!opts.retryKilled });
    }
    return { count: records.length, lastSeq };
  }

  /** Follow the log for the rest of the run. The IPC copy usually wins; this is the floor. */
  function follow() {
    if (stopTail) return stopTail;
    stopTail = tailControl(dir, lastSeq, (rec) => apply(rec, { source: 'log' }));
    return stopTail;
  }

  function stop() {
    if (!stopTail) return;
    try {
      stopTail();
    } catch {
      /* the tail is a polled timer; failing to clear it is not worth a thrown error */
    }
    stopTail = null;
  }

  return {
    apply,
    replayLog,
    follow,
    stop,
    isRunPaused: () => runPaused,
    isRunKilled: () => runKilled,
    runKillReason: () => runKillReason,
    heldStages: () => [...heldStages],
    appliedCount: () => seen.size,
  };
}
