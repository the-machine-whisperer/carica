/**
 * The job registry — the ONE place that knows which OS process belongs to which job.
 *
 * A "job" is one addressable unit of agent work: a plain stage (`job_id = "outlets"`) or a
 * single fan-out shard (`job_id = "harvest:ynet"` — the shard KEY, not the display label).
 * The editor watching a run wants to say "pause that one", "kill that one", and the only way
 * to honour that is to know the pid behind it.
 *
 * Three things about this file are deliberate, and none of them are obvious:
 *
 * **1. It records INTENT, not just live pids.** Killing a shard that is still queued behind
 * the concurrency limit has to stick: `isKilled()` keeps answering true, so the dispatch loop
 * declines to start it and the run reports it as skipped instead of quietly running it two
 * seconds later. The same goes for a stage-wide or run-wide pause: a job that registers
 * *after* the pause was asked for is suspended the moment it is registered, because the
 * editor paused a stage, not a pid.
 *
 * **2. Pause is SIGSTOP, and SIGSTOP is not universally available.** On a platform that
 * cannot suspend a process, we say so — `{ok: false}` and a `stage.progress` note in the run
 * log — rather than emitting `job.paused` over a job that is merrily still working. A UI
 * showing "paused" over a running agent is worse than a UI showing "could not pause".
 *
 * **3. Every signal is wrapped.** The process may have exited a millisecond ago; that is a
 * normal race, not an error, and it must never throw out of an HTTP handler.
 *
 * The registry holds no credentials and spawns nothing — it only signals children that
 * `runCodex` created. The whole credential story stays in exec.js, where it belongs.
 */

/** SIGTERM first, then SIGKILL — the same escalation the server uses to stop a whole run. */
export const KILL_GRACE_MS = 5000;

/** `harvest:ynet` belongs to stage `harvest`; `outlets` belongs to stage `outlets`. */
function stageOf(jobId, fallback) {
  const id = String(jobId ?? '');
  const colon = id.indexOf(':');
  return colon === -1 ? id || (fallback ?? id) : id.slice(0, colon);
}

/**
 * Send one signal to one child, tolerantly.
 *
 * A child that has already exited is not a failure of the request — the editor asked for the
 * job to stop and the job has stopped. An unsupported signal (SIGSTOP on Windows) IS a
 * failure, and one we report rather than paper over.
 *
 * @returns {{ok: boolean, detail: string|null}}
 */
function signalChild(child, sig) {
  if (!child) return { ok: false, detail: 'no process is running for that job' };
  if (child.exitCode !== null || child.signalCode !== null) {
    return { ok: false, detail: 'the agent process had already exited' };
  }
  try {
    const delivered = child.kill(sig);
    return delivered
      ? { ok: true, detail: null }
      : { ok: false, detail: `the agent process did not accept ${sig}` };
  } catch (err) {
    return { ok: false, detail: `${sig} failed: ${err?.message ?? String(err)}` };
  }
}

/**
 * @typedef {Object} JobRecord
 * @property {string} id             job_id
 * @property {string} stage          stage id
 * @property {string} label          display label (`harvest:Ynet`)
 * @property {string|null} key       shard key, when this job is a shard
 * @property {any} child             the ChildProcess, while it is alive
 * @property {any} controls          runCodex's timer/kill controls, while it is alive
 * @property {number|null} pid
 * @property {'queued'|'running'|'paused'|'killed'|'skipped'|'done'} state
 * @property {boolean} killed
 * @property {boolean} paused
 * @property {string|null} killReason
 */

/**
 * @param {{bus?: {emit: (t: string, p?: any) => any}, onChange?: (status: any) => void}} [o]
 */
export function createJobRegistry(o = {}) {
  const bus = o.bus ?? null;
  const onChange = typeof o.onChange === 'function' ? o.onChange : null;

  /** @type {Map<string, JobRecord>} */
  const jobs = new Map();
  /** Stages the editor paused — every job of theirs, present or future, is suspended. */
  const pausedStages = new Set();
  /** Stages the editor killed — no job of theirs may start. */
  const killedStages = new Set();
  let allPaused = false;
  let allKilled = false;
  let allKillReason = null;

  const emit = (type, payload) => {
    try {
      bus?.emit(type, payload);
    } catch {
      /* the event log must never be able to fail a control action */
    }
  };

  const changed = () => {
    if (!onChange) return;
    try {
      onChange(status());
    } catch {
      /* a checkpoint writer that throws must not take the run down with it */
    }
  };

  /**
   * Get the record for a job, inventing one if the job has not been registered yet.
   * That invention is the whole point: it is how "kill the shard that has not started"
   * becomes a fact the dispatch loop can read.
   */
  function ensure(jobId, seed = {}) {
    let rec = jobs.get(jobId);
    if (!rec) {
      rec = {
        id: jobId,
        stage: seed.stage ?? stageOf(jobId),
        label: seed.label ?? jobId,
        key: seed.key ?? null,
        child: null,
        controls: null,
        pid: null,
        state: 'queued',
        killed: false,
        paused: false,
        killReason: null,
      };
      jobs.set(jobId, rec);
    } else {
      if (seed.stage) rec.stage = seed.stage;
      if (seed.label) rec.label = seed.label;
      if (seed.key) rec.key = seed.key;
    }
    return rec;
  }

  function isKilled(jobId) {
    if (allKilled) return true;
    if (killedStages.has(stageOf(jobId))) return true;
    return !!jobs.get(jobId)?.killed;
  }

  function isPaused(jobId) {
    if (allPaused) return true;
    if (pausedStages.has(stageOf(jobId))) return true;
    return !!jobs.get(jobId)?.paused;
  }

  function killedJobs() {
    return [...jobs.values()].filter((r) => r.killed).map((r) => r.id);
  }

  function status() {
    return {
      jobs: [...jobs.values()].map((r) => ({
        id: r.id,
        stage: r.stage,
        label: r.label,
        key: r.key,
        pid: r.pid,
        state: r.state,
        paused: r.paused,
        killed: r.killed,
      })),
      paused: { all: allPaused, stages: [...pausedStages], jobs: [...jobs.values()].filter((r) => r.paused).map((r) => r.id) },
      killed: { all: allKilled, stages: [...killedStages] },
      killedJobs: killedJobs(),
    };
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * A child has just been spawned for this job. Called synchronously from `runCodex`'s
   * `onSpawn`, before a single line of output has arrived, so that a pause or kill issued
   * one millisecond after the spawn still lands on a pid we know about.
   *
   * If the editor already asked for this job to stop or to hold, we apply that here rather
   * than trusting the caller to have checked — the request came first, the process second.
   *
   * @param {string} jobId
   * @param {{stage: string, label?: string, key?: string|null, child: any, controls?: any}} info
   */
  function register(jobId, info) {
    const rec = ensure(jobId, { stage: info.stage, label: info.label, key: info.key });
    rec.child = info.child ?? null;
    rec.controls = info.controls ?? null;
    rec.pid = info.child?.pid ?? null;
    rec.state = 'running';

    if (isKilled(jobId)) {
      // Killed while it was queued and started anyway (a race, or a caller that did not
      // check). Stop it now; the alternative is an agent nobody asked for burning tokens.
      kill(jobId, 'system', rec.killReason ?? allKillReason ?? 'killed before it started');
      return rec;
    }
    if (isPaused(jobId)) {
      // Its stage (or the whole run) is held. A job may not start working around a pause
      // just because it happened to be dispatched after it.
      pause(jobId, 'system');
      return rec;
    }
    changed();
    return rec;
  }

  /**
   * The child is gone. The record stays — `killed` must keep answering true after the
   * process has exited, because "was this job killed?" is asked again when the stage
   * result is interpreted.
   */
  function unregister(jobId) {
    const rec = jobs.get(jobId);
    if (!rec) return;
    rec.child = null;
    rec.controls = null;
    rec.pid = null;
    if (rec.state !== 'killed' && rec.state !== 'skipped') rec.state = 'done';
    rec.paused = false;
    changed();
  }

  // --------------------------------------------------------------------- pause

  /**
   * Suspend the agent process with SIGSTOP. The child keeps its memory, its open sockets
   * and its place in the world; it simply stops being scheduled until SIGCONT.
   *
   * A queued job (no process yet) is marked paused instead, which is what stops the
   * dispatch loop from starting it.
   *
   * @returns {{ok: boolean, detail: string|null, state: string}}
   */
  function pause(jobId, by = 'editor') {
    const rec = ensure(jobId);
    if (rec.killed) return { ok: false, detail: 'that job was already stopped', state: rec.state };

    if (!rec.child) {
      rec.paused = true;
      if (rec.state === 'running') rec.state = 'paused';
      changed();
      emit('job.paused', { stage: rec.stage, job_id: rec.id, by, detail: 'queued — it will not be started until you resume it' });
      return { ok: true, detail: 'queued — it will not be started until you resume it', state: rec.state };
    }

    if (rec.paused) return { ok: true, detail: 'already paused', state: rec.state };

    const sent = signalChild(rec.child, 'SIGSTOP');
    if (!sent.ok) {
      // Honest degradation. We do NOT emit job.paused: the agent is still running, and
      // saying otherwise would put a lie in the run's permanent record.
      emit('stage.progress', {
        stage: rec.stage,
        job_id: rec.id,
        label: rec.label,
        message: `could not pause ${rec.label} — ${sent.detail}`,
        degraded: true,
      });
      return { ok: false, detail: sent.detail, state: rec.state };
    }

    rec.paused = true;
    rec.state = 'paused';
    // A suspended agent is not a slow agent: freeze its stage timeout too, or a four-minute
    // coffee break would be reported as a timeout the agent never had. See exec.js.
    try {
      rec.controls?.pauseTimer?.();
    } catch {
      /* the timer is a convenience; never fail a pause over it */
    }
    changed();
    emit('job.paused', { stage: rec.stage, job_id: rec.id, by, pid: rec.pid });
    return { ok: true, detail: null, state: rec.state };
  }

  /** SIGCONT. Also clears a queued job's hold so the dispatch loop may start it. */
  function resume(jobId, by = 'editor') {
    const rec = ensure(jobId);
    if (rec.killed) return { ok: false, detail: 'that job was stopped; it cannot be resumed', state: rec.state };
    if (!rec.paused) return { ok: true, detail: 'that job was not paused', state: rec.state };

    if (!rec.child) {
      rec.paused = false;
      if (rec.state === 'paused') rec.state = 'queued';
      changed();
      emit('job.resumed', { stage: rec.stage, job_id: rec.id, by, detail: 'queued — it may start again' });
      return { ok: true, detail: null, state: rec.state };
    }

    const sent = signalChild(rec.child, 'SIGCONT');
    if (!sent.ok) return { ok: false, detail: sent.detail, state: rec.state };

    rec.paused = false;
    rec.state = 'running';
    try {
      rec.controls?.resumeTimer?.();
    } catch {
      /* see pause() */
    }
    changed();
    emit('job.resumed', { stage: rec.stage, job_id: rec.id, by, pid: rec.pid });
    return { ok: true, detail: null, state: rec.state };
  }

  // ---------------------------------------------------------------------- kill

  /**
   * Stop this job for good: SIGTERM, then SIGKILL after a grace period, exactly the
   * escalation the server uses on a whole run.
   *
   * Returns immediately — the SIGKILL runs on an unref'd timer, so a pending escalation can
   * never be the reason the process stays alive.
   *
   * A job with no process yet is *marked* killed and nothing more. Nothing was running, so
   * there is nothing to kill and no `job.killed` to emit; when the dispatch loop later
   * declines it, `markSkipped` records that honestly as `job.skipped`.
   */
  function kill(jobId, by = 'editor', reason = 'stopped by the editor') {
    const rec = ensure(jobId);
    const alreadyKilled = rec.killed;
    rec.killed = true;
    rec.killReason = reason;

    if (!rec.child) {
      rec.state = rec.state === 'skipped' ? 'skipped' : 'queued';
      changed();
      return { ok: true, detail: 'that job had not started; it will not be started', state: rec.state, spawned: false };
    }

    if (alreadyKilled && rec.state === 'killed') {
      return { ok: true, detail: 'already stopping', state: rec.state, spawned: true };
    }

    const child = rec.child;
    // Tell runCodex WHY the child is about to die, so the stage runner can tell "the editor
    // stopped this" apart from "it timed out" and from "it exited non-zero". Those three
    // produce three completely different sentences to the operator.
    try {
      rec.controls?.markKilled?.(reason);
    } catch {
      /* best effort; the close handler infers a kill from the signal anyway */
    }

    // A SIGSTOPped process never gets to act on SIGTERM — it is not scheduled. Continue it
    // first so the polite signal has a chance to be the one that works.
    if (rec.paused) signalChild(child, 'SIGCONT');

    signalChild(child, 'SIGTERM');
    const killer = setTimeout(() => {
      signalChild(child, 'SIGKILL');
    }, KILL_GRACE_MS);
    if (killer.unref) killer.unref();

    rec.paused = false;
    rec.state = 'killed';
    changed();
    emit('job.killed', { stage: rec.stage, job_id: rec.id, by, reason, pid: rec.pid });
    return { ok: true, detail: null, state: rec.state, spawned: true };
  }

  /**
   * A job that was killed (or otherwise dropped) before it ever ran. Nothing was killed —
   * something was declined — and the run's record should say the true thing.
   */
  function markSkipped(jobId, { stage, reason } = {}) {
    const rec = ensure(jobId, { stage });
    rec.state = 'skipped';
    rec.child = null;
    rec.controls = null;
    rec.pid = null;
    changed();
    emit('job.skipped', {
      stage: rec.stage,
      job_id: rec.id,
      label: rec.label,
      reason: reason ?? rec.killReason ?? 'stopped before it started',
    });
    return { ok: true, state: rec.state };
  }

  // -------------------------------------------------------- stage / run scoped

  const jobsOfStage = (stageId) => [...jobs.values()].filter((r) => r.stage === stageId);

  function fanOut(records, fn) {
    const results = records.map((r) => ({ job_id: r.id, ...fn(r) }));
    return { ok: results.every((r) => r.ok !== false), count: results.length, results };
  }

  /**
   * Pause a whole stage — including its shards that have not started yet, which is why the
   * stage id is remembered and not merely mapped onto the jobs that happen to exist now.
   */
  function pauseStage(stageId, by = 'editor') {
    pausedStages.add(stageId);
    const out = fanOut(jobsOfStage(stageId), (r) => pause(r.id, by));
    if (!out.count) {
      // Nothing of this stage is running yet; the hold still stands and still belongs in
      // the log, otherwise the UI has nothing to show for the click.
      emit('job.paused', { stage: stageId, job_id: stageId, by, detail: 'stage held — nothing of it is running yet' });
      changed();
    }
    return out;
  }

  function resumeStage(stageId, by = 'editor') {
    pausedStages.delete(stageId);
    const out = fanOut(jobsOfStage(stageId), (r) => resume(r.id, by));
    if (!out.count) {
      emit('job.resumed', { stage: stageId, job_id: stageId, by, detail: 'stage released' });
      changed();
    }
    return out;
  }

  function killStage(stageId, by = 'editor', reason = 'stopped by the editor') {
    killedStages.add(stageId);
    const out = fanOut(jobsOfStage(stageId), (r) => kill(r.id, by, reason));
    if (!out.count) {
      changed();
    }
    return out;
  }

  function pauseAll(by = 'editor') {
    allPaused = true;
    const out = fanOut([...jobs.values()], (r) => pause(r.id, by));
    changed();
    return out;
  }

  /** Release everything: the run-wide hold, every stage hold, every individual job. */
  function resumeAll(by = 'editor') {
    allPaused = false;
    pausedStages.clear();
    const out = fanOut([...jobs.values()], (r) => resume(r.id, by));
    changed();
    return out;
  }

  function killAll(by = 'editor', reason = 'stopped by the editor') {
    allKilled = true;
    allKillReason = reason;
    const out = fanOut([...jobs.values()], (r) => kill(r.id, by, reason));
    changed();
    return out;
  }

  return {
    register,
    unregister,
    pause,
    resume,
    kill,
    pauseStage,
    resumeStage,
    killStage,
    pauseAll,
    resumeAll,
    killAll,
    isKilled,
    isPaused,
    pausedStages: () => [...pausedStages],
    killedJobs,
    markSkipped,
    status,
  };
}
