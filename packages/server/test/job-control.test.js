import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/index.js';
import { createRunManager } from '../src/run-manager.js';
import { RUNS_DIR, createRun, appendEventToRun, readControl, controlState } from '@carica/core';

/**
 * Steering a run: pause, resume, kill, skip — and picking one up again afterwards.
 *
 * The tests that earn their keep here are the ones about instructions with no process to
 * receive them. A kill filed against a run that is not going is not a mistake: it means
 * "when this is continued, do not re-run that one", and the only thing standing between
 * that decision and a resume that ignores it is control.ndjson being written whether or not
 * anybody was listening. So most of what follows runs with NOTHING active, which is the
 * awkward case, rather than against a live run, which is the easy one.
 *
 * The live half is exercised with a stand-in worker, the same trick stop.test.js uses: a
 * real replay run finishes in under a second, so racing one is a test that fails on a busy
 * machine and passes on a quiet one. A process that holds a run directory and does nothing
 * is the shape we actually need, and it needs no Codex binary to be one.
 */

let app;
/** A run directory with a plausible history, made here and cleaned up at the end. */
let runId;
let runDir;
const madeRuns = [];
const spawned = [];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carica-control-'));
const tmpRuns = path.join(tmp, 'runs');
fs.mkdirSync(tmpRuns, { recursive: true });

// A stand-in for the pipeline worker: records the options it was forked with, answers to
// the run id it was told to resume, and stays alive so IPC has somewhere to land.
const workerPath = path.join(tmp, 'holding-worker.mjs');
fs.writeFileSync(
  workerPath,
  `import fs from 'node:fs';
import path from 'node:path';
const opts = JSON.parse(process.argv[2] ?? '{}');
fs.writeFileSync(path.join(opts.runsDir, 'last-opts.json'), JSON.stringify(opts));
const runId = opts.resumeRunId ?? 'unnamed';
process.send?.({ type: 'started', runId, dir: path.join(opts.runsDir, runId), resumed: !!opts.resumeRunId });
process.on('message', (msg) => {
  fs.appendFileSync(path.join(opts.runsDir, 'ipc.ndjson'), JSON.stringify(msg) + '\\n');
});
setInterval(() => {}, 1000);
`
);

before(async () => {
  const created = createRun({ slug: 'job-control-test', runsDir: RUNS_DIR, config: { mode: 'replay' } });
  runId = created.runId;
  runDir = created.dir;
  madeRuns.push(runId);

  // Two steps done, the third mid-flight — a run with somewhere to pick up from.
  appendEventToRun(runDir, 'run.start', { run_id: runId, mode: 'replay', from: null });
  for (const [stage, artifact] of [
    ['outlets', '01_outlets.json'],
    ['harvest', '02_harvest.json'],
  ]) {
    appendEventToRun(runDir, 'stage.start', { stage });
    appendEventToRun(runDir, 'artifact.write', { stage, artifact });
    appendEventToRun(runDir, 'stage.end', { stage, ok: true, artifact });
  }
  appendEventToRun(runDir, 'stage.start', { stage: 'cluster' });

  app = await buildServer();
});

after(async () => {
  await app?.close();
  for (const pid of spawned) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  for (const id of madeRuns) {
    const dir = path.join(RUNS_DIR, id);
    if (fs.existsSync(dir) && id.includes('job-control-test')) fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const control = (id, payload) => app.inject({ method: 'POST', url: `/api/runs/${encodeURIComponent(id)}/control`, payload });

describe('asking a run to do something', () => {
  test('a run that is not there cannot be steered', async () => {
    const r = await control('no-such-run-at-all', { action: 'pause', target: { kind: 'run' } });
    assert.equal(r.statusCode, 404);
  });

  test('an action nobody has ever heard of is refused, in words', async () => {
    const r = await control(runId, { action: 'obliterate', target: { kind: 'run' } });
    assert.equal(r.statusCode, 400);
    assert.ok(r.json().error.length > 20, 'the browser shows this to an editor verbatim');
    assert.match(r.json().errors.join(' '), /unknown action/i);
  });

  test('a job target with no job_id is refused rather than guessed at', async () => {
    // The dangerous shape: it reads as a valid instruction and quietly means "some job,
    // somewhere in this step". There is no such job, and killing it would kill something.
    const r = await control(runId, { action: 'kill', target: { kind: 'job', stage: 'harvest' } });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().errors.join(' '), /job_id/);
  });

  test('a step that does not exist is refused before it is written down', async () => {
    const r = await control(runId, { action: 'skip', target: { kind: 'stage', stage: 'sketching' } });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /Unknown step/);
    assert.equal(readControl(runDir).some((rec) => rec.target?.stage === 'sketching'), false);
  });

  test('a job id that does not belong to the step it was filed under is refused', async () => {
    for (const jobId of ['../../etc/passwd', 'cluster:ynet', 'harvest/ynet', 'harvest:../x']) {
      const r = await control(runId, { action: 'kill', target: { kind: 'job', stage: 'harvest', job_id: jobId } });
      assert.equal(r.statusCode, 400, `${jobId} must be refused`);
      assert.match(r.json().error, /not a job in harvest/);
    }
  });

  test('a valid instruction is written to control.ndjson and comes back with a receipt', async () => {
    const r = await control(runId, {
      action: 'kill',
      target: { kind: 'job', stage: 'harvest', job_id: 'harvest:ynet' },
      by: 'test editor',
    });
    assert.equal(r.statusCode, 200, r.payload);
    const body = r.json();
    assert.equal(body.ok, true);
    assert.ok(body.request_id, 'the receipt is what makes the instruction deduplicable');
    assert.equal(body.delivered, false, 'nothing is running, so nothing was told directly');

    const file = path.join(runDir, 'control.ndjson');
    assert.ok(fs.existsSync(file), 'the file is the durable channel; it is written first, always');
    const records = readControl(runDir);
    const written = records.find((rec) => rec.request_id === body.request_id);
    assert.equal(written.action, 'kill');
    assert.deepEqual(written.target, { kind: 'job', stage: 'harvest', job_id: 'harvest:ynet' });
    assert.equal(written.by, 'test editor', 'an instruction is attributable, like a decision');
  });

  test('killing a job on a stopped run is an instruction to the next resume, not an error', async () => {
    // This is the whole reason the file is written before anything is delivered: the work
    // outlives the process that was doing it, and "do not re-run that shard" has to survive
    // the run it was aimed at.
    const r = await control(runId, {
      action: 'skip',
      target: { kind: 'job', stage: 'harvest', job_id: 'harvest:haaretz' },
    });
    assert.equal(r.statusCode, 200);
    assert.ok(controlState(readControl(runDir)).skippedJobs.includes('harvest:haaretz'));
  });

  test('pausing a run that is not going says so rather than pretending', async () => {
    for (const action of ['pause', 'resume']) {
      const r = await control(runId, { action, target: { kind: 'run' } });
      assert.equal(r.statusCode, 409, `${action} on a stopped run`);
      assert.match(r.json().error, /not going/);
    }
    // And nothing was recorded: a refusal must not leave a half-instruction on disk.
    assert.equal(readControl(runDir).some((rec) => rec.action === 'pause'), false);
  });

  test('the control log is readable, so a decision is auditable and not merely effective', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/runs/${runId}/control` });
    assert.equal(r.statusCode, 200);
    const { records, state } = r.json();
    assert.ok(records.length >= 2);
    assert.ok(records.every((rec) => typeof rec.seq === 'number' && rec.ts && rec.request_id));
    assert.ok(state.killedJobs.includes('harvest:ynet'));
    assert.equal(state.paused, false);
  });
});

describe('where a run would pick up', () => {
  test('a run with events but no state.json still knows its resume points', async () => {
    // Every run made before the checkpoint existed is in exactly this position, and its
    // artifacts are on disk like anyone else's. Deriving from the events is what stops the
    // cache being the reason an old run cannot be continued.
    assert.equal(fs.existsSync(path.join(runDir, 'state.json')), false, 'this run never wrote one');

    const r = await app.inject({ method: 'GET', url: `/api/runs/${runId}/checkpoint` });
    assert.equal(r.statusCode, 200);
    const { checkpoint } = r.json();
    assert.equal(checkpoint.run_id, runId);
    assert.equal(checkpoint.stages.outlets.status, 'ok');
    assert.equal(checkpoint.stages.outlets.valid, true);
    assert.equal(checkpoint.stages.cluster.status, 'running');

    const resumable = checkpoint.milestones.filter((m) => m.resumable).map((m) => m.stage);
    assert.deepEqual(resumable, ['outlets', 'harvest', 'cluster'], 'two done, plus the next thing to do');
    assert.ok(checkpoint.milestones.every((m) => m.title && typeof m.n === 'number'), 'titles come from the stage graph');
  });

  test('a torn checkpoint degrades to the derived one instead of taking the screen down', async () => {
    const file = path.join(runDir, 'state.json');
    fs.writeFileSync(file, '{"schema_version": "1.0", "stages"');
    try {
      const r = await app.inject({ method: 'GET', url: `/api/runs/${runId}/checkpoint` });
      assert.equal(r.statusCode, 200);
      assert.equal(r.json().checkpoint.stages.outlets.status, 'ok');
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  test('the run screen gets the checkpoint and the control log in the poll it already makes', async () => {
    const body = (await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).json();
    assert.equal(body.checkpoint.run_id, runId);
    assert.ok(body.control.records.length >= 2);
    assert.ok(body.control.state.killedJobs.includes('harvest:ynet'));
    assert.equal(body.state.status, 'running', 'the projection is untouched by any of this');
  });

  test('a run with a directory and nothing in it has no checkpoint to offer', async () => {
    const bare = createRun({ slug: 'job-control-test-bare', runsDir: RUNS_DIR });
    madeRuns.push(bare.runId);
    const r = await app.inject({ method: 'GET', url: `/api/runs/${bare.runId}/checkpoint` });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().checkpoint, null, 'null is an answer; a 500 is not');
  });
});

describe('continuing a run', () => {
  test('continuing needs a step, and it has to be a real one', async () => {
    const none = await app.inject({ method: 'POST', url: `/api/runs/${runId}/resume`, payload: {} });
    assert.equal(none.statusCode, 400);
    assert.match(none.json().error, /step to continue from/);

    const wrong = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/resume`,
      payload: { from: 'sketch' },
    });
    assert.equal(wrong.statusCode, 400);
    assert.match(wrong.json().error, /no step called/i);
    assert.match(wrong.json().error, /outlets, harvest/, 'the message names the steps that would work');
  });

  test('a run that is not there cannot be continued', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/runs/no-such-run/resume', payload: { from: 'score' } });
    assert.equal(r.statusCode, 404);
  });

  test('a valid step starts the run again, keeping its id', async () => {
    // A stub, so this tests the route's contract rather than racing a real pipeline.
    const calls = [];
    const stubbed = await buildServer({
      runner: {
        start: () => ({ runId: 'x' }),
        stop: () => ({ ok: true }),
        getActive: () => null,
        isActive: () => false,
        resume: (id, opts, meta) => {
          calls.push({ id, opts, meta });
          return { runId: id, dir: null, mode: 'replay', resumed: true };
        },
      },
    });
    const r = await stubbed.inject({
      method: 'POST',
      url: `/api/runs/${runId}/resume`,
      payload: { from: 'score', retryKilled: true, requested_by: 'test editor' },
    });
    assert.equal(r.statusCode, 200, r.payload);
    assert.deepEqual(r.json(), { ok: true, run_id: runId, resumed: true });
    assert.equal(calls[0].id, runId);
    assert.equal(calls[0].opts.from, 'score');
    assert.equal(calls[0].opts.retryKilled, true, 'the editor asked for the stopped jobs to be re-tried');
    assert.equal(calls[0].meta.requestedBy, 'test editor');
    await stubbed.close();
  });
});

describe('run ids off the wire reach the filesystem, so every route checks them', () => {
  const evil = ['../config', '..%2f..%2fpackage.json', '/etc/passwd', 'a/../../b'];
  const routes = [
    ['GET', (id) => `/api/runs/${encodeURIComponent(id)}/checkpoint`, undefined],
    ['GET', (id) => `/api/runs/${encodeURIComponent(id)}/control`, undefined],
    ['POST', (id) => `/api/runs/${encodeURIComponent(id)}/control`, { action: 'kill', target: { kind: 'run' } }],
    ['POST', (id) => `/api/runs/${encodeURIComponent(id)}/resume`, { from: 'score' }],
  ];

  for (const [method, url, payload] of routes) {
    for (const bad of evil) {
      test(`${method} ${url('<id>')} refuses ${bad}`, async () => {
        const r = await app.inject({ method, url: url(bad), payload });
        assert.equal(r.statusCode, 404, `must not act on ${bad}`);
      });
    }
  }
});

describe('a run that is actually going', () => {
  /** Start the stand-in on a run of our own, and hand back a manager holding it. */
  async function holdingRun(slug) {
    const created = createRun({ slug, runsDir: tmpRuns, config: { mode: 'replay' } });
    const runner = createRunManager({ runsDir: tmpRuns, workerPath, stopGraceMs: 500 });
    const started = await runner.resume(created.runId, { from: 'score' });
    spawned.push(runner.getActive().pid);
    return { runner, runId: created.runId, started };
  }

  test('continuing forks the run again with its id, its step and its earlier settings', async () => {
    const { runner, runId: id, started } = await holdingRun('resumable');
    assert.equal(started.runId, id, 'a continued run keeps its id — one run, one story');
    assert.equal(started.resumed, true);
    assert.equal(runner.isActive(id), true);

    const opts = JSON.parse(fs.readFileSync(path.join(tmpRuns, 'last-opts.json'), 'utf8'));
    assert.equal(opts.resumeRunId, id);
    assert.equal(opts.from, 'score');
    assert.equal(opts.mode, 'replay', 'the mode is read back out of the run being continued');
    assert.equal(opts.retryKilled, false, 'jobs an editor stopped stay stopped unless asked otherwise');

    // And the ordinary refusals still apply, because this goes through start().
    await assert.rejects(() => runner.start({ mode: 'replay' }), /already going/);
    await assert.rejects(() => runner.resume(id, { from: 'score' }), /already going/);
    runner.stop(id);
  });

  test('re-trying the stopped jobs is asked for explicitly, and is a yes-or-no answer', async () => {
    const created = createRun({ slug: 'retry-killed', runsDir: tmpRuns, config: { mode: 'replay' } });
    const runner = createRunManager({ runsDir: tmpRuns, workerPath, stopGraceMs: 500 });

    await assert.rejects(() => runner.resume(created.runId, { from: 'score', retryKilled: 'yes please' }), /yes-or-no/);

    await runner.resume(created.runId, { from: 'score', retryKilled: true });
    spawned.push(runner.getActive().pid);
    const opts = JSON.parse(fs.readFileSync(path.join(tmpRuns, 'last-opts.json'), 'utf8'));
    assert.equal(opts.retryKilled, true);
    runner.stop(created.runId);
  });

  test('a live run is told directly, and the file is still written first', async () => {
    const { runner, runId: id } = await holdingRun('steerable');
    const dir = path.join(tmpRuns, id);

    const paused = runner.control(id, { action: 'pause', target: { kind: 'run' }, by: 'test editor' });
    assert.equal(paused.ok, true);
    assert.equal(paused.delivered, true, 'IPC is the latency channel; a live run gets the message now');

    const onDisk = readControl(dir);
    assert.equal(onDisk.at(-1).request_id, paused.request_id, 'the durable channel is written whatever IPC does');

    // The stand-in logs everything it is sent, so this is the worker's view of the message.
    const deadline = Date.now() + 4000;
    let seen = [];
    while (Date.now() < deadline) {
      const file = path.join(tmpRuns, 'ipc.ndjson');
      seen = fs.existsSync(file)
        ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
        : [];
      if (seen.some((m) => m.record?.request_id === paused.request_id)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const message = seen.find((m) => m.record?.request_id === paused.request_id);
    assert.ok(message, 'the worker never received the control message');
    assert.equal(message.type, 'control');
    assert.deepEqual(message.record.target, { kind: 'run' });
    assert.equal(message.record.by, 'test editor');

    runner.stop(id);
  });

  test('a run paused when its process dies is not written off as a failure', async () => {
    const { runner, runId: id } = await holdingRun('paused-then-killed');
    const dir = path.join(tmpRuns, id);
    runner.control(id, { action: 'pause', target: { kind: 'run' }, by: 'test editor' });

    // Killed outright, as a closing laptop kills it: nothing cooperative about this.
    process.kill(runner.getActive().pid, 'SIGKILL');
    const deadline = Date.now() + 10_000;
    while (runner.getActive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));

    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
    assert.notEqual(manifest.status, 'complete', 'a run that never finished must never say it did');
    assert.notEqual(manifest.status, 'running', 'nor may it be left hanging');
    assert.equal(manifest.status, 'cancelled', 'it stopped because a person said so, not because it broke');
    assert.match(manifest.terminated.reason, /paused/);
    assert.equal(controlState(readControl(dir)).paused, true, 'the instruction outlives the process');
  });
});
