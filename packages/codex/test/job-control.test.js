import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createJobRegistry } from '../src/jobs.js';
import { runStage } from '../src/stage-runner.js';
import { runCodex } from '../src/exec.js';

/**
 * A run is something an editor watches, and a stage that cannot be paused or stopped while it
 * is in flight is a run they can only watch. These tests are about that: a real child process
 * with a real pid, really suspended and really killed.
 *
 * They spawn `fake-agent.mjs` as the agent binary rather than mocking the spawn, because the
 * thing under test IS the process — SIGSTOP is not something a mock can be wrong about in an
 * interesting way. Every timing assertion is made against an observable (the fake's heartbeat
 * file, the registry's own state), with margins measured in hundreds of milliseconds, because
 * a flaky test inside `npm run gate` is worse than no test at all.
 */

const FAKE_AGENT = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));

const STAGE = {
  id: 'harvest',
  slug: '02_harvest',
  artifact: '02_harvest.json',
  contract: 'harvest',
  timeoutMs: 60_000,
};

/** A bus that only remembers. The real one appends NDJSON; nothing here needs a file. */
function recordingBus() {
  const events = [];
  return {
    events,
    emit: (type, payload = {}) => {
      events.push({ type, ...payload });
      return { type, ...payload };
    },
    ofType: (type) => events.filter((e) => e.type === type),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until a condition holds. Generous by default: correctness, not stopwatch precision. */
async function waitFor(fn, { timeoutMs = 8000, intervalMs = 25, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(intervalMs);
  }
}

let tmpRoot;
let savedBin;

before(() => {
  fs.chmodSync(FAKE_AGENT, 0o755); // a fresh checkout may not carry the exec bit
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carica-jobs-'));
  savedBin = process.env.CARICA_CODEX_BIN;
  process.env.CARICA_CODEX_BIN = FAKE_AGENT;
});

after(() => {
  if (savedBin === undefined) delete process.env.CARICA_CODEX_BIN;
  else process.env.CARICA_CODEX_BIN = savedBin;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env.CARICA_FAKE_HEARTBEAT;
  delete process.env.CARICA_FAKE_LIFETIME_MS;
  delete process.env.CARICA_FAKE_TICK_MS;
  delete process.env.CARICA_FAKE_EXIT;
});

const newRunDir = () => fs.mkdtempSync(path.join(tmpRoot, 'run-'));

// ------------------------------------------------------------ the registry alone

describe('the registry records intent, not just live pids', () => {
  test('a job killed before it is registered stays killed', () => {
    const jobs = createJobRegistry(); // no bus — it must work without one
    jobs.kill('harvest:mako', 'editor', 'not worth the tokens');
    assert.equal(jobs.isKilled('harvest:mako'), true);
    assert.deepEqual(jobs.killedJobs(), ['harvest:mako']);
    assert.equal(jobs.status().jobs[0].state, 'queued', 'nothing was killed — it was never started');
  });

  test('killing a stage reaches shards that do not exist yet', () => {
    const jobs = createJobRegistry();
    jobs.killStage('harvest', 'editor', 'stop the whole step');
    assert.equal(jobs.isKilled('harvest:ynet'), true);
    assert.equal(jobs.isKilled('facts'), false, 'other stages are untouched');
  });

  test('pausing a queued job holds it, and resuming releases it', () => {
    const bus = recordingBus();
    const jobs = createJobRegistry({ bus });
    jobs.pause('harvest:ynet', 'editor');
    assert.equal(jobs.isPaused('harvest:ynet'), true);
    assert.equal(bus.ofType('job.paused')[0].job_id, 'harvest:ynet');

    jobs.resume('harvest:ynet', 'editor');
    assert.equal(jobs.isPaused('harvest:ynet'), false);
    assert.equal(bus.ofType('job.resumed')[0].by, 'editor');
  });

  test('a stage pause is inherited by shards dispatched afterwards', () => {
    const jobs = createJobRegistry();
    jobs.pauseStage('harvest', 'editor');
    assert.deepEqual(jobs.pausedStages(), ['harvest']);
    assert.equal(jobs.isPaused('harvest:ynet'), true);
    jobs.resumeAll('editor');
    assert.equal(jobs.isPaused('harvest:ynet'), false);
  });

  test('a job that never ran is skipped, not killed', () => {
    const bus = recordingBus();
    const jobs = createJobRegistry({ bus });
    jobs.kill('harvest:mako', 'editor', 'dropped');
    assert.equal(bus.ofType('job.killed').length, 0, 'nothing was running to kill');
    jobs.markSkipped('harvest:mako', { stage: 'harvest', reason: 'dropped' });
    const [skipped] = bus.ofType('job.skipped');
    assert.equal(skipped.job_id, 'harvest:mako');
    assert.equal(skipped.reason, 'dropped');
  });

  test('onChange fires on state changes so a caller can checkpoint', () => {
    let calls = 0;
    const jobs = createJobRegistry({ onChange: () => calls++ });
    jobs.kill('outlets', 'editor', 'x');
    jobs.markSkipped('outlets', { stage: 'outlets' });
    assert.ok(calls >= 2, `onChange fired ${calls} times`);
  });
});

// --------------------------------------------------------- a live child process

describe('a spawned job is addressable', () => {
  test('it is registered with a pid and appears in status()', async () => {
    process.env.CARICA_FAKE_LIFETIME_MS = '4000';
    const bus = recordingBus();
    const jobs = createJobRegistry({ bus });
    const runDir = newRunDir();

    const pending = runStage({
      stage: STAGE,
      runDir,
      charter: 'do the thing',
      model: 'test-model',
      bus,
      jobs,
      jobId: 'harvest:ynet',
      label: 'harvest:Ynet',
      shardKey: 'ynet',
      shardLabel: 'Ynet',
    });

    const job = await waitFor(() => jobs.status().jobs.find((j) => j.pid), { what: 'a registered pid' });
    assert.equal(job.id, 'harvest:ynet');
    assert.equal(job.stage, 'harvest');
    assert.equal(job.label, 'harvest:Ynet');
    assert.equal(job.state, 'running');
    assert.ok(Number.isInteger(job.pid) && job.pid > 0, `pid was ${job.pid}`);

    jobs.kill('harvest:ynet', 'editor', 'done looking');
    await pending;
    assert.equal(jobs.status().jobs.find((j) => j.id === 'harvest:ynet').pid, null, 'the pid is released on exit');
  });

  test('pause suspends the agent and resume lets it work again', async () => {
    const runDir = newRunDir();
    const heartbeat = path.join(runDir, 'heartbeat');
    process.env.CARICA_FAKE_HEARTBEAT = heartbeat;
    process.env.CARICA_FAKE_TICK_MS = '50';
    process.env.CARICA_FAKE_LIFETIME_MS = '20000';

    const bus = recordingBus();
    const jobs = createJobRegistry({ bus });
    const pending = runStage({ stage: STAGE, runDir, charter: 'c', model: 'm', bus, jobs, jobId: 'harvest' });

    const beats = () => (fs.existsSync(heartbeat) ? fs.statSync(heartbeat).size : 0);
    await waitFor(() => beats() > 2, { what: 'the agent to start working' });

    const paused = jobs.pause('harvest', 'editor');
    assert.equal(paused.ok, true, `SIGSTOP failed: ${paused.detail}`);
    assert.equal(jobs.isPaused('harvest'), true);

    await sleep(400); // let any in-flight write land before we take the reading
    const frozen = beats();
    await sleep(800); // 16 ticks' worth of work that must not happen
    assert.equal(beats(), frozen, 'a suspended agent must not still be working');
    assert.equal(bus.ofType('job.paused')[0].job_id, 'harvest');

    assert.equal(jobs.resume('harvest', 'editor').ok, true);
    await waitFor(() => beats() > frozen, { what: 'the resumed agent to work again' });
    assert.equal(bus.ofType('job.resumed').length, 1);

    jobs.kill('harvest', 'editor', 'test over');
    await pending;
  });

  test('a killed job is not retried, and a kill is not an error', async () => {
    process.env.CARICA_FAKE_LIFETIME_MS = '20000';
    const bus = recordingBus();
    const jobs = createJobRegistry({ bus });
    const runDir = newRunDir();

    const pending = runStage({ stage: STAGE, runDir, charter: 'c', model: 'm', bus, jobs, jobId: 'harvest' });
    await waitFor(() => jobs.status().jobs.find((j) => j.pid), { what: 'a registered pid' });
    const { pid } = jobs.status().jobs[0];

    jobs.kill('harvest', 'editor', 'the editor changed their mind');
    const res = await pending;

    assert.equal(res.ok, false);
    assert.equal(res.killed, true);
    assert.deepEqual(res.errors, ['stopped by the editor']);

    assert.equal(bus.ofType('agent.spawn').length, 1, 'a kill must not be answered with a retry');
    assert.equal(bus.ofType('agent.retry').length, 0);
    assert.equal(bus.ofType('stage.error').length, 0, 'a kill is an instruction carried out, not a failure');

    const [end] = bus.ofType('stage.end');
    assert.equal(end.ok, false);
    assert.equal(end.killed, true);

    const [killed] = bus.ofType('job.killed');
    assert.equal(killed.job_id, 'harvest');
    assert.equal(killed.by, 'editor');
    assert.equal(killed.reason, 'the editor changed their mind');

    await waitFor(() => !processAlive(pid), { what: 'the child process to be gone' });
  });

  test('a job killed while queued is declined and reported as skipped', async () => {
    process.env.CARICA_FAKE_LIFETIME_MS = '20000';
    const bus = recordingBus();
    const jobs = createJobRegistry({ bus });
    jobs.kill('harvest:mako', 'editor', 'not this outlet');

    const res = await runStage({
      stage: STAGE,
      runDir: newRunDir(),
      charter: 'c',
      model: 'm',
      bus,
      jobs,
      jobId: 'harvest:mako',
      label: 'harvest:Mako',
      shardKey: 'mako',
      shardLabel: 'Mako',
    });

    assert.equal(res.ok, false);
    assert.equal(res.skipped, true);
    assert.equal(bus.ofType('agent.spawn').length, 0, 'nothing may be spawned for a killed job');
    assert.equal(bus.ofType('stage.start').length, 0);
    assert.equal(bus.ofType('job.skipped')[0].job_id, 'harvest:mako');
  });

  test('every event carries the job identity, and label is unchanged', async () => {
    process.env.CARICA_FAKE_LIFETIME_MS = '20000';
    const bus = recordingBus();
    const jobs = createJobRegistry({ bus });

    const pending = runStage({
      stage: STAGE,
      runDir: newRunDir(),
      charter: 'c',
      model: 'm',
      bus,
      jobs,
      jobId: 'harvest:ynet',
      label: 'harvest:Ynet',
      shardKey: 'ynet',
      shardLabel: 'Ynet',
    });

    await waitFor(() => bus.ofType('agent.activity').length > 0, { what: 'agent activity' });
    jobs.kill('harvest:ynet', 'editor', 'seen enough');
    await pending;

    for (const type of ['stage.start', 'agent.spawn', 'agent.activity', 'stage.end']) {
      const [ev] = bus.ofType(type);
      assert.ok(ev, `no ${type} was emitted`);
      assert.equal(ev.job_id, 'harvest:ynet', `${type} lost its job_id`);
      assert.equal(ev.shard_key, 'ynet', `${type} lost its shard_key`);
      assert.equal(ev.shard_label, 'Ynet', `${type} lost its shard_label`);
      assert.equal(ev.label, 'harvest:Ynet', `${type} must keep emitting label exactly as before`);
      assert.equal(ev.stage, 'harvest');
    }
  });

  test('without a registry, nothing changes', async () => {
    process.env.CARICA_FAKE_LIFETIME_MS = '150';
    const bus = recordingBus();
    const res = await runStage({ stage: { ...STAGE, timeoutMs: 20_000 }, runDir: newRunDir(), charter: 'c', model: 'm', bus });
    // The fake writes no artifact, so this is the ordinary three-attempt contract failure —
    // the exact behaviour every existing caller has always had.
    assert.equal(res.ok, false);
    assert.equal(res.killed, undefined);
    assert.equal(bus.ofType('agent.spawn').length, 3);
    assert.equal(bus.ofType('stage.error').length, 1);
    assert.equal(bus.ofType('stage.start')[0].job_id, 'harvest', 'a plain stage is its own job');
  });
});

// ----------------------------------------------------------- runCodex directly

describe('runCodex tells three different stories apart', () => {
  test('a suspended job does not time out — the clock is a budget of running time', async () => {
    process.env.CARICA_FAKE_LIFETIME_MS = '1200';
    let resumeAt;
    const res = await runCodex({
      prompt: 'p',
      cwd: newRunDir(),
      timeoutMs: 500, // would fire long before the fake exits, if it were a wall-clock deadline
      onSpawn: (_child, controls) => {
        controls.pauseTimer();
        resumeAt = setTimeout(() => controls.resumeTimer(), 5000);
        resumeAt.unref?.();
      },
    });
    clearTimeout(resumeAt);
    assert.equal(res.timedOut, false, 'a job suspended on purpose has not hung');
    assert.equal(res.killed, false);
    assert.equal(res.code, 0);
  });

  test('a child terminated from outside reports killed, not a mystery exit code', async () => {
    process.env.CARICA_FAKE_LIFETIME_MS = '20000';
    const res = await runCodex({
      prompt: 'p',
      cwd: newRunDir(),
      timeoutMs: 30_000,
      onSpawn: (child) => setTimeout(() => child.kill('SIGTERM'), 100),
    });
    assert.equal(res.killed, true);
    assert.equal(res.timedOut, false);
    assert.match(res.killReason, /SIGTERM/);
  });

  test('an aborted job is never spawned at all', async () => {
    const res = await runCodex({
      prompt: 'p',
      cwd: newRunDir(),
      abort: { aborted: true, reason: 'stopped by the editor before it started' },
      onSpawn: () => assert.fail('a killed job must not be spawned'),
    });
    assert.equal(res.spawned, false);
    assert.equal(res.killed, true);
    assert.equal(res.killReason, 'stopped by the editor before it started');
  });
});

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
