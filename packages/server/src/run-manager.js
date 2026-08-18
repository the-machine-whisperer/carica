import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import {
  REPO_ROOT,
  RUNS_DIR,
  FIXTURES_DIR,
  readJson,
  appendEventToRun,
  finalizeRun,
  appendControl,
  readControl,
  controlState,
  validateControlRecord,
} from '@carica/core';
import { STAGES } from '@carica/pipeline';

/**
 * Starting, watching and stopping runs — the half of `carica run` that now lives behind
 * the app, so nobody has to open a terminal to make a cartoon.
 *
 * One run at a time, deliberately. A pipeline run fans out to a dozen concurrent agents
 * and spends real money; two overlapping runs would race on the ledger and make the
 * "what is happening right now" question unanswerable, which is the app's whole job.
 */

const WORKER = path.join(REPO_ROOT, 'packages', 'pipeline', 'src', 'worker.js');
const START_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 20_000;

/** An error carrying an HTTP status, so routes stay thin. */
export class RunError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

const STAGE_IDS = new Set(STAGES.map((s) => s.id));
const STAGE_IDS_ORDER = STAGES.map((s) => s.id);

export function createRunManager({ runsDir = RUNS_DIR, workerPath = WORKER, stopGraceMs = STOP_GRACE_MS } = {}) {
  /** @type {null | {runId: string|null, dir: string|null, child: any, mode: string, startedAt: string, requestedBy: string|null, stopping: boolean, from: string|null}} */
  let active = null;

  function activeSummary() {
    if (!active) return null;
    return {
      run_id: active.runId,
      mode: active.mode,
      started_at: active.startedAt,
      requested_by: active.requestedBy,
      stopping: active.stopping,
      from: active.from,
      pid: active.child?.pid ?? null,
    };
  }

  /**
   * Everything the browser is allowed to ask for, checked here rather than trusted.
   * @param {any} body
   */
  function normalise(body = {}) {
    const mode = body.mode === 'live' ? 'live' : 'replay';

    let fixture = null;
    if (mode === 'replay') {
      // Accept either a bare snapshot name or the `fixtures/<name>` form a run manifest
      // records, so "run this again" can pass the manifest value straight back.
      const name =
        typeof body.fixture === 'string' && body.fixture.trim()
          ? path.basename(body.fixture.trim().replace(/\/+$/, ''))
          : null;
      const candidates = listFixtures();
      if (!candidates.length) {
        throw new RunError('There are no practice snapshots on disk to replay.', 409);
      }
      const chosen = name ? candidates.find((f) => f.name === name) : candidates[0];
      if (!chosen) throw new RunError(`Unknown practice snapshot: ${name}`, 400);
      fixture = chosen.path;
    }

    const from = body.from ?? null;
    if (from && !STAGE_IDS.has(from)) {
      throw new RunError(`Unknown step: ${from}`, 400);
    }

    let resumeRunId = null;
    if (body.resumeRunId) {
      const id = safeRunId(body.resumeRunId);
      if (!id) throw new RunError('Invalid run id.', 400);
      if (!fs.existsSync(path.join(runsDir, id))) throw new RunError(`No such run: ${id}`, 404);
      resumeRunId = id;
      if (!from) throw new RunError('Continuing a run needs a step to continue from.', 400);
    }

    // Starting a NEW run partway through, on another run's earlier results. Distinct from
    // resuming: that carries on inside a run directory that already has them.
    let seedFrom = null;
    if (body.seedFrom) {
      const id = safeRunId(String(body.seedFrom));
      if (!id) throw new RunError('Invalid run to carry results over from.', 400);
      if (resumeRunId) {
        throw new RunError(
          'A run being continued already has its earlier results — it cannot also take them from somewhere else.',
          400
        );
      }
      if (!from) throw new RunError('Carrying results over needs a step to start at.', 400);
      if (from === STAGE_IDS_ORDER[0]) {
        throw new RunError(
          `Starting at the first step means running it, so there is nothing to carry over. Pick a later step.`,
          400
        );
      }
      seedFrom = id;
    }

    // Shards are network-bound agent processes, not CPU work — see DEFAULT_CONCURRENCY.
    const concurrency = clampInt(body.concurrency, 1, 18, 8);

    // Does a continued run re-attempt the jobs somebody deliberately stopped?
    //
    // No, unless asked — and the default matters more than it looks. A killed shard wrote
    // no artifact, so every other signal a resume can read says "this one still needs
    // doing"; only the control log knows a person decided otherwise. Silently re-running it
    // would spend money undoing an editorial decision, which is the one failure mode this
    // whole control plane exists to prevent. Saying yes here is the explicit "I killed that
    // by mistake, try it again" case — never a default.
    if (body.retryKilled != null && typeof body.retryKilled !== 'boolean') {
      throw new RunError('Re-trying the jobs you stopped is a yes-or-no choice.', 400);
    }
    const retryKilled = body.retryKilled === true;

    // The allowlist is only shape-checked here; resolving it against the registry (and
    // rejecting a name that is not in it) belongs to the pipeline, which reads that file.
    const allowlist = normaliseAllowlist(body.allowlist);
    const slug = slugify(body.slug) || (mode === 'replay' ? 'practice' : 'run');
    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined;

    return {
      mode,
      replay: fixture,
      from,
      resumeRunId,
      slug,
      concurrency,
      model,
      allowlist,
      seedFrom,
      retryKilled,
      autoApprove: mode === 'replay' ? true : !!body.autoApprove,
      runsDir,
    };
  }

  /**
   * Fork a run and resolve as soon as its directory exists — the browser needs the run id
   * to start streaming, not the finished result, which may be twenty minutes away.
   *
   * @param {any} body
   * @param {{requestedBy?: string}} [meta]
   */
  async function start(body = {}, meta = {}) {
    // async, so a refusal is a rejected promise like every other failure here rather than
    // a synchronous throw the caller has to handle a second way.
    if (active) {
      throw new RunError(
        `A run is already going (${active.runId ?? 'starting up'}). Stop it before starting another.`,
        409,
        { active: activeSummary() }
      );
    }

    const opts = normalise(body);

    return new Promise((resolve, reject) => {
      const child = fork(workerPath, [JSON.stringify(opts)], {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: process.env,
      });

      const job = {
        runId: null,
        dir: null,
        child,
        mode: opts.mode,
        startedAt: new Date().toISOString(),
        requestedBy: meta.requestedBy ?? null,
        stopping: false,
        from: opts.from,
        lastError: null,
      };
      active = job;

      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(arg);
      };

      const timer = setTimeout(() => {
        finish(reject, new RunError('The run did not start within 30 seconds; it has been stopped.', 504));
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, START_TIMEOUT_MS);

      // The worker's stderr is a last resort for diagnosing a run that dies before it can
      // write anything to the event log.
      let stderr = '';
      child.stderr?.on('data', (c) => {
        stderr = (stderr + c.toString()).slice(-4000);
      });
      child.stdout?.resume();

      child.on('message', (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'started') {
          job.runId = msg.runId;
          job.dir = msg.dir;
          finish(resolve, { runId: msg.runId, dir: msg.dir, mode: opts.mode, resumed: !!msg.resumed });
        } else if (msg.type === 'stopping') {
          job.stopping = true;
        } else if (msg.type === 'error') {
          // The run never began — free the slot now rather than making the user wait for
          // the child to exit before they can correct the mistake and try again.
          job.lastError = msg.message;
          if (active === job) active = null;
          finish(reject, new RunError(msg.message, 400));
        } else if (msg.type === 'done') {
          job.finalStatus = msg.status;
        }
      });

      child.on('error', (err) => {
        finish(reject, new RunError(`Could not start the run: ${err.message}`, 500));
      });

      child.on('exit', (code, sig) => {
        if (active === job) active = null;
        // A run that died without closing itself out would otherwise sit at "running"
        // in the app for ever. Close it here, honestly labelled.
        if (job.dir) reconcile(job, code, sig, stderr);
        if (!settled) {
          finish(
            reject,
            new RunError(
              job.lastError ?? `The run exited before it started (code ${code ?? sig}). ${stderr.slice(-500)}`.trim(),
              500
            )
          );
        }
      });
    });
  }

  /** SIGTERM first — a stage mid-write gets to finish — then a hard kill. */
  function stop(runId) {
    if (!active) throw new RunError('Nothing is running.', 409);
    if (runId && active.runId && runId !== active.runId) {
      throw new RunError(`That run is not the one currently going (${active.runId}).`, 409);
    }
    if (active.stopping) return { ok: true, already: true, run_id: active.runId };

    active.stopping = true;
    const child = active.child;
    try {
      child.kill('SIGTERM');
    } catch {
      /* already exiting */
    }
    const killer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }, stopGraceMs);
    if (killer.unref) killer.unref();

    return { ok: true, run_id: active.runId };
  }

  function isActive(runId) {
    return !!active && active.runId === runId;
  }

  /** The run directory a control request is aimed at, or a refusal the browser can show. */
  function controlDir(runId) {
    const id = safeRunId(runId);
    if (!id) throw new RunError('Invalid run id.', 400);
    const dir = path.join(runsDir, id);
    if (!fs.existsSync(dir)) throw new RunError(`No such run: ${id}`, 404);
    return { id, dir };
  }

  /**
   * Tell a run to pause, resume, kill or skip something.
   *
   * Two channels, in this order, and the order is the design:
   *
   *   1. `control.ndjson` — durable. Written first, always, whether or not anything is
   *      listening. The worker tails this file, and a resumed run replays it before it does
   *      anything else, so an instruction survives the process it was aimed at.
   *   2. IPC — fast. A message to the live child so the agent stops in a second rather than
   *      on the next poll. Pure latency; nothing depends on it arriving.
   *
   * Writing the file first is what makes "the editor pressed Kill just as the run died" end
   * with the job killed rather than the instruction lost.
   *
   * @param {string} runId
   * @param {{action: string, target: any, by?: string|null}} input
   * @returns {{ok: true, request_id: string, delivered: boolean}}
   */
  function control(runId, { action, target, by = null } = {}) {
    const { id, dir } = controlDir(runId);

    const check = validateControlRecord({ action, target, by });
    if (!check.ok) {
      throw new RunError('That is not an instruction a run can act on.', 400, { errors: check.errors });
    }

    // A stage id off the wire is checked against the graph, not trusted. A control record
    // naming a step that does not exist is un-appliable by definition, and it would sit in
    // an append-only file being re-read by every future resume for ever.
    if (target.kind === 'stage' || target.kind === 'job') {
      if (!STAGE_IDS.has(target.stage)) throw new RunError(`Unknown step: ${target.stage}`, 400);
    }

    /** @type {any} */
    let clean = { kind: 'run' };
    if (target.kind === 'stage') clean = { kind: 'stage', stage: target.stage };
    if (target.kind === 'job') {
      const jobId = safeJobId(target.job_id, target.stage);
      if (!jobId) {
        throw new RunError(
          `That is not a job in ${target.stage}. A job is the step itself ("${target.stage}") or one of its ` +
            `pieces ("${target.stage}:<outlet>").`,
          400
        );
      }
      clean = { kind: 'job', stage: target.stage, job_id: jobId };
    }
    // Only the three fields the contract defines are persisted: anything else the browser
    // sent would become permanent, unreadable noise in a file nothing can edit.

    const live = isActive(id) && !!active?.child?.connected;

    // Pause and resume are instructions to a process. Kill and skip are instructions about
    // a piece of WORK, and work outlives the process that was doing it: "do not re-run this
    // shard" is a perfectly sensible thing to say about a run that is currently stopped,
    // and the resume replays the control log before it picks up. So a kill or a skip
    // against a stopped run is recorded and honoured later; a pause or a resume against one
    // has nothing to suspend and is a refusal the editor should see.
    if (!live && (action === 'pause' || action === 'resume')) {
      throw new RunError(
        `That run is not going at the moment, so there is nothing to ${action === 'pause' ? 'pause' : 'resume'}.`,
        409,
        { active: activeSummary() }
      );
    }

    const record = appendControl(dir, { action, target: clean, by: by ?? null });

    // The event log is left to the worker. It owns `events.ndjson` while a run is going —
    // its EventBus holds an open handle and its own seq counter — and a second writer would
    // hand out a duplicate seq, which is precisely the number every SSE client resumes from.
    // What the editor asked for is already durable in control.ndjson; what came of it
    // arrives as `control.applied` from the process that actually applied it.
    let delivered = false;
    if (live) {
      try {
        active.child.send({ type: 'control', record });
        delivered = true;
      } catch {
        // The child went away between the check and the send. The record is on disk, which
        // is the channel that mattered; `delivered: false` says the run has not seen it yet.
      }
    }

    return { ok: true, request_id: record.request_id, delivered };
  }

  /**
   * Carry this run on from `from`, in its own directory, keeping its run id.
   *
   * Deliberately routed through start()/normalise() rather than a second start path: every
   * refusal a new run gets (one run at a time, a step that does not exist, a snapshot that
   * is not there) has to apply here too, and two code paths would drift within a month.
   * The original run's own configuration is read back out of its manifest so a continued
   * run replays the same snapshot and the same outlets it began with.
   *
   * @param {string} runId
   * @param {{from?: string, retryKilled?: boolean}} input
   * @param {{requestedBy?: string}} [meta]
   */
  async function resume(runId, { from, retryKilled = false } = {}, meta = {}) {
    const { id, dir } = controlDir(runId);

    if (active) {
      throw new RunError(
        `A run is already going (${active.runId ?? 'starting up'}). Stop it before continuing another.`,
        409,
        { active: activeSummary() }
      );
    }
    if (!from) throw new RunError('Continuing a run needs a step to continue from.', 400);

    let manifest = null;
    try {
      manifest = readJson(path.join(dir, 'run.json'));
    } catch {
      // A run directory with no readable manifest can still be continued — the artifacts on
      // disk are what a resume actually needs — it just cannot tell us how it was set up.
    }
    const config = manifest?.config ?? {};

    return start(
      {
        mode: config.mode === 'live' ? 'live' : 'replay',
        fixture: config.fixture ?? null,
        allowlist: config.allowlist ?? null,
        slug: manifest?.slug ?? null,
        resumeRunId: id,
        from,
        retryKilled,
      },
      meta
    );
  }

  return { start, stop, control, resume, getActive: activeSummary, isActive };
}

/**
 * Close out a run whose process is gone. Cancelled if we asked it to stop, failed if it
 * died on its own — never left dangling at "running", and never at "complete": this path
 * runs precisely because the run did not get to say how it ended.
 *
 * A paused run is the case worth spelling out. Its process is alive but idle, so it dies
 * the same way any other interrupted run does — except that it stopped because a person
 * said so. Calling that "failed" blames the machine for an editorial decision and, worse,
 * hides the fact that the work was deliberately held. It is closed out as cancelled, with
 * the pause named in the reason, and the control log still holds the instruction so the
 * run can be picked up where the editor left it.
 */
function reconcile(job, code, sig, stderr) {
  const manifestFile = path.join(job.dir, 'run.json');
  if (!fs.existsSync(manifestFile)) return;
  let manifest;
  try {
    manifest = readJson(manifestFile);
  } catch {
    return;
  }
  if (manifest.status !== 'running') return; // the pipeline already closed itself out

  let paused = false;
  try {
    paused = controlState(readControl(job.dir)).paused;
  } catch {
    /* no control log, or an unreadable one: this is a nicety, not a precondition */
  }

  const status = job.stopping || paused ? 'cancelled' : 'failed';
  // `job.lastError` is the message the worker itself reported over IPC before it died, and
  // it is the only sentence in this function that says WHY. It used to be recorded only when
  // the run failed before it started; a run that died after that was closed out as "the run
  // process exited unexpectedly (code 1)" while the actual error sat unread on the job. An
  // exit code is not a reason, and the editor had nowhere else to look — the pipeline never
  // got to write the event log either. Say what the worker said, and keep the code after it
  // for whoever needs it.
  const died = `the run process exited unexpectedly (${sig ?? `code ${code}`})`;
  const reason = job.stopping
    ? 'stopped by the editor'
    : paused
      ? `the run was paused, and its process ended while it was held (${sig ?? `code ${code}`})`
      : job.lastError
        ? `${job.lastError} (${sig ?? `code ${code}`})`
        : died;

  try {
    appendEventToRun(job.dir, 'run.end', {
      run_id: job.runId,
      status,
      failed_stage: null,
      reason,
    });
    finalizeRun(job.dir, status, {
      terminated: { code, signal: sig, reason, paused, stderr_tail: stderr ? stderr.slice(-800) : null },
    });
  } catch {
    /* the run directory is evidence, not a transaction log; a failed patch is not fatal */
  }
}

/** Practice snapshots available to replay, newest-looking first. */
export function listFixtures(dir = FIXTURES_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .filter((d) => fs.existsSync(path.join(dir, d.name, '01_outlets.json')))
    .map((d) => {
      const p = path.join(dir, d.name);
      const stages = fs.readdirSync(p).filter((f) => /^\d\d_.*\.json$/.test(f)).length;
      return { name: d.name, path: p, stages };
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

export function safeRunId(id) {
  if (typeof id !== 'string' || !id.length) return null;
  if (id.includes('..') || id.includes('/') || id.includes('\\') || path.isAbsolute(id)) return null;
  return id;
}

/**
 * A job id off the wire, checked as strictly as a run id.
 *
 * It is not a path, but it addresses a unit of agent work — a process — and it is written
 * into an append-only file that every future resume of this run replays. So it is checked
 * for shape (`<stageId>` for a plain step, `<stageId>:<shardKey>` for one shard) AND for
 * belonging: a job whose prefix is not the stage it was filed under is either a mistake in
 * the browser or an attempt to steer a stage the request did not name, and neither is worth
 * making permanent.
 *
 * @param {any} jobId
 * @param {string} [stage] the stage the job is claimed to belong to
 * @returns {string|null}
 */
export function safeJobId(jobId, stage) {
  if (typeof jobId !== 'string' || !jobId.length || jobId.length > 200) return null;
  if (jobId.includes('..')) return null; // the charset below would otherwise allow it
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(jobId)) return null;
  if (stage && jobId.split(':')[0] !== stage) return null;
  return jobId;
}

function slugify(s) {
  if (typeof s !== 'string') return '';
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * An allowlist off the wire: an array or a comma-separated string, or nothing at all.
 *
 * Deliberately does NOT check the names against the registry — that is the pipeline's job,
 * done once against the file it actually reads, so there is one answer to "is this a real
 * outlet" rather than two that can drift apart. Here we only refuse a shape we cannot use.
 */
export function normaliseAllowlist(input) {
  if (input == null) return null;
  const raw = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[,\n]/) : null;
  if (!raw) throw new RunError('The list of outlets must be a list, or a comma-separated line.', 400);
  const cleaned = raw
    .map((s) => String(s ?? '').trim())
    .filter(Boolean)
    .slice(0, 100);
  return cleaned.length ? [...new Set(cleaned)] : null;
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}
