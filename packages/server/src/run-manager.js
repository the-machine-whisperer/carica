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

    const concurrency = clampInt(body.concurrency, 1, 12, 4);
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

  return { start, stop, getActive: activeSummary, isActive };
}

/**
 * Close out a run whose process is gone. Cancelled if we asked it to stop, failed if it
 * died on its own — never left dangling at "running".
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

  const status = job.stopping ? 'cancelled' : 'failed';
  const reason = job.stopping
    ? 'stopped by the editor'
    : `the run process exited unexpectedly (${sig ?? `code ${code}`})`;

  try {
    appendEventToRun(job.dir, 'run.end', {
      run_id: job.runId,
      status,
      failed_stage: null,
      reason,
    });
    finalizeRun(job.dir, status, {
      terminated: { code, signal: sig, reason, stderr_tail: stderr ? stderr.slice(-800) : null },
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

function slugify(s) {
  if (typeof s !== 'string') return '';
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}
