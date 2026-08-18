import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIXTURES_DIR, appendControl, readCheckpoint, readEvents } from '@carica/core';
import { createJobRegistry } from '@carica/codex';
import {
  parallelLimit,
  runPipeline,
  runFannedStage,
  shardPartAlreadyGood,
  createControlApplier,
  refreshRunCheckpoint,
  verifyRun,
  STAGES,
} from '../src/index.js';

/**
 * Control and resumption — the two halves of "a run is something a person is in charge of".
 *
 * Control is the editor reaching into work that is already going: hold it, let it go, stop
 * that one piece. Resumption is the same run picking up where it stopped without redoing
 * what it already did, down to the individual shard. They are tested together because they
 * are the same fact seen twice: a decision the editor made has to survive both the seconds
 * it takes an agent to notice and the hours it might take before anyone comes back.
 *
 * Everything here is offline. Where a real child process is needed — and it is needed, since
 * "was this agent spawned?" is not a question a mock can answer honestly — the tests point
 * `CARICA_CODEX_BIN` at `fake-harvest-agent.mjs`, which slices the frozen snapshot instead
 * of fetching anything. No network, no `codex` binary, no cost, no flakiness.
 */

const SNAP = path.join(FIXTURES_DIR, '2026-08-11_sample');
const FAKE_AGENT = fileURLToPath(new URL('./fake-harvest-agent.mjs', import.meta.url));
const HARVEST = STAGES.find((s) => s.id === 'harvest');

/** A charter small enough to read, naming the two files a shard is allowed to touch. */
const SHARD_CHARTER = 'Write {{artifact_name}} and record what you fetched in {{evidence_name}}.';

/** A bus that only remembers. The real one appends NDJSON; nothing here needs a file. */
function recordingBus() {
  const events = [];
  return {
    events,
    emit: (type, payload = {}) => {
      const e = { type, ...payload };
      events.push(e);
      return e;
    },
    ofType: (type) => events.filter((e) => e.type === type),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let tmpRoot;
let savedBin;
let savedFixture;

before(() => {
  fs.chmodSync(FAKE_AGENT, 0o755); // a fresh checkout may not carry the exec bit
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carica-control-'));
  savedBin = process.env.CARICA_CODEX_BIN;
  savedFixture = process.env.CARICA_FAKE_FIXTURE;
  process.env.CARICA_CODEX_BIN = FAKE_AGENT;
  process.env.CARICA_FAKE_FIXTURE = SNAP;
});

after(() => {
  if (savedBin === undefined) delete process.env.CARICA_CODEX_BIN;
  else process.env.CARICA_CODEX_BIN = savedBin;
  if (savedFixture === undefined) delete process.env.CARICA_FAKE_FIXTURE;
  else process.env.CARICA_FAKE_FIXTURE = savedFixture;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env.CARICA_FAKE_DELAY_MS;
  delete process.env.CARICA_FAKE_BROKEN;
});

const newDir = (name = 'run-') => fs.mkdtempSync(path.join(tmpRoot, name));

/** A run directory holding just what a harvest fans out from. */
function harvestRunDir() {
  const dir = newDir('harvest-');
  fs.copyFileSync(path.join(SNAP, '01_outlets.json'), path.join(dir, '01_outlets.json'));
  return dir;
}

/** Drive one fanned-out stage, exactly as runPipeline drives it. */
function fanOut(dir, o = {}) {
  const bus = o.bus ?? recordingBus();
  const result = runFannedStage({
    stage: HARVEST,
    dir,
    bus,
    model: 'fake-model',
    mode: 'live',
    charters: { harvest: { text: SHARD_CHARTER, sha: 'fake-charter-sha' } },
    ctx: {},
    concurrency: o.concurrency ?? 4,
    allowlist: null,
    jobs: o.jobs ?? null,
    resume: !!o.resume,
    signal: o.signal ?? null,
  });
  return { bus, result };
}

// ---------------------------------------------------------------- the dispatch loop

describe('parallelLimit can hold work and decline it', () => {
  test('the classic two-argument call is untouched', async () => {
    const results = await parallelLimit(2, [async () => 'a', async () => 'b', async () => 'c']);
    assert.deepEqual(results, ['a', 'b', 'c']);
  });

  test('a cancelled task is never invoked, and the results still line up with the input', async () => {
    const ran = [];
    const tasks = [0, 1, 2, 3].map((i) => async () => {
      ran.push(i);
      return `ran-${i}`;
    });
    const skipped = [];

    const results = await parallelLimit(2, tasks, {
      isCancelled: (i) => i === 1 || i === 3,
      onSkip: (i) => {
        skipped.push(i);
        return { ok: false, killed: true };
      },
    });

    assert.deepEqual(ran, [0, 2], 'a cancelled task must not be started at all');
    assert.deepEqual(skipped, [1, 3]);
    assert.equal(results[0], 'ran-0');
    assert.equal(results[2], 'ran-2');
    // Order is the contract: the merge downstream pairs results with shards by index.
    assert.deepEqual(results[1], { ok: false, killed: true });
    assert.deepEqual(results[3], { ok: false, killed: true });
  });

  test('a held loop dispatches nothing, and drains once released — each task exactly once', async () => {
    // Two at a time, six tasks a tenth of a second each: the first wave is in flight at 30ms
    // and would be replaced at 100ms. The hold is asserted well past that, so "nothing new
    // started" is a claim about the loop and not about the stopwatch.
    let paused = false;
    const started = [];
    const tasks = Array.from({ length: 6 }, (_, i) => async () => {
      started.push(i);
      await sleep(100);
      return i;
    });

    const pending = parallelLimit(2, tasks, { isPaused: () => paused, pollMs: 10 });

    await sleep(30);
    paused = true;
    assert.deepEqual(started, [0, 1], 'the first wave was already in flight when the hold landed');

    // An in-flight task is NOT interrupted by this loop — suspending a live agent is the job
    // registry's SIGSTOP, not the dispatcher's business — so the pair that started finishes.
    await sleep(300);
    assert.deepEqual(started, [0, 1], 'a held loop must not start anything new');

    paused = false;
    const results = await pending;

    assert.deepEqual(results, [0, 1, 2, 3, 4, 5], 'everything ran, in order, after the release');
    assert.equal(started.length, tasks.length, 'no task was dispatched twice');
    assert.equal(new Set(started).size, tasks.length);
  });

  test('a run being stopped breaks the hold rather than waiting politely for ever', async () => {
    const signal = { aborted: false };
    const started = [];
    const tasks = Array.from({ length: 4 }, (_, i) => async () => started.push(i));

    const pending = parallelLimit(1, tasks, { isPaused: () => true, signal, pollMs: 10 });
    await sleep(50);
    assert.deepEqual(started, [], 'held means held');

    signal.aborted = true;
    const results = await pending;
    assert.deepEqual(started, [], 'a stopped run does not resume the queue on its way out');
    assert.deepEqual(results, [null, null, null, null]);
  });
});

// ------------------------------------------------------------- applying instructions

describe('applying an instruction is idempotent', () => {
  test('the same request_id twice is one instruction', () => {
    const dir = newDir('idem-');
    const bus = recordingBus();
    const jobs = createJobRegistry({ bus });
    const control = createControlApplier({ dir, bus, jobs });

    const record = {
      seq: 1,
      ts: new Date().toISOString(),
      request_id: 'req-once',
      action: 'kill',
      target: { kind: 'job', stage: 'harvest', job_id: 'harvest:ynet' },
      by: 'editor',
    };

    const first = control.apply(record, { source: 'ipc' });
    const second = control.apply(record, { source: 'log' });
    const third = control.apply({ ...record, seq: 9 }, { source: 'log' });

    assert.equal(first.ok, true);
    assert.equal(second.duplicate, true, 'the file copy of a record already applied over IPC');
    assert.equal(third.duplicate, true);
    assert.equal(jobs.isKilled('harvest:ynet'), true);
    assert.equal(
      bus.ofType('control.applied').length,
      1,
      'one click by the editor must not be acknowledged three times'
    );
  });

  test('an instruction this run cannot act on is refused, out loud', () => {
    const dir = newDir('bad-');
    const bus = recordingBus();
    const control = createControlApplier({ dir, bus, jobs: createJobRegistry({ bus }) });

    const res = control.apply({ request_id: 'r1', action: 'explode', target: { kind: 'run' } });
    assert.equal(res.ok, false);
    const [applied] = bus.ofType('control.applied');
    assert.equal(applied.ok, false);
    assert.match(applied.detail, /not an instruction this run can act on/);
  });

  test('a run-wide hold is a hold, and resuming releases the stages held under it', () => {
    const dir = newDir('hold-');
    const bus = recordingBus();
    const jobs = createJobRegistry({ bus });
    const control = createControlApplier({ dir, bus, jobs });

    control.apply({ request_id: 'p1', action: 'pause', target: { kind: 'stage', stage: 'harvest' } });
    assert.equal(jobs.isPaused('harvest:ynet'), true);
    assert.equal(bus.ofType('stage.paused')[0].stage, 'harvest');

    control.apply({ request_id: 'p2', action: 'pause', target: { kind: 'run' } });
    assert.equal(control.isRunPaused(), true);
    assert.equal(bus.ofType('run.paused').length, 1);

    control.apply({ request_id: 'r1', action: 'resume', target: { kind: 'run' } });
    assert.equal(control.isRunPaused(), false);
    assert.equal(jobs.isPaused('harvest:ynet'), false, 'Resume on the run means the run');
  });
});

describe('what a run remembers from before it was restarted', () => {
  /** A run directory with one instruction already in its control log. */
  function dirWithKill(name) {
    const dir = newDir(name);
    appendControl(dir, {
      action: 'kill',
      target: { kind: 'job', stage: 'harvest', job_id: 'harvest:ynet' },
      by: 'editor',
      request_id: 'kill-ynet',
    });
    appendControl(dir, { action: 'pause', target: { kind: 'run' }, by: 'editor', request_id: 'pause-run' });
    return dir;
  }

  test('a kill recorded while the run was stopped is applied again when it starts', () => {
    const dir = dirWithKill('replay-');
    const bus = recordingBus();
    const jobs = createJobRegistry({ bus });
    const control = createControlApplier({ dir, bus, jobs });

    const { count } = control.replayLog({ retryKilled: false });
    assert.equal(count, 2);
    assert.equal(jobs.isKilled('harvest:ynet'), true, 'the editor stopped that shard; it stays stopped');
  });

  test('retryKilled is the explicit "I stopped that by mistake" and does not re-apply it', () => {
    const dir = dirWithKill('retry-');
    const bus = recordingBus();
    const jobs = createJobRegistry({ bus });
    const control = createControlApplier({ dir, bus, jobs });

    control.replayLog({ retryKilled: true });
    assert.equal(jobs.isKilled('harvest:ynet'), false);
    const kill = bus.ofType('control.applied').find((e) => e.action === 'kill');
    assert.equal(kill.enacted, false);
    assert.match(kill.detail, /tried again/);
  });

  test('a hold does not survive the process it was holding', () => {
    const dir = dirWithKill('unheld-');
    const bus = recordingBus();
    const control = createControlApplier({ dir, bus, jobs: createJobRegistry({ bus }) });

    control.replayLog({});
    assert.equal(control.isRunPaused(), false, 'a run that starts up held is indistinguishable from a hang');
    const pause = bus.ofType('control.applied').find((e) => e.action === 'pause');
    assert.equal(pause.enacted, false);
  });
});

// ------------------------------------------------------------------ a real fan-out

describe('a fanned-out stage under editorial control', () => {
  test('the whole thing works offline, as the baseline everything else is measured against', async () => {
    const dir = harvestRunDir();
    const { bus, result } = fanOut(dir);
    const res = await result;

    assert.equal(res.ok, true, JSON.stringify(res.errors));
    assert.equal(bus.ofType('agent.spawn').length, 5, 'one agent per ranked outlet');
    const merged = JSON.parse(fs.readFileSync(path.join(dir, '02_items.json'), 'utf8'));
    assert.equal(merged.items.length, 5);
    assert.equal(merged.outlet_status.length, 5);
  });

  test('a shard killed while it is queued is never spawned, and the rest still merge', async () => {
    const dir = harvestRunDir();
    const bus = recordingBus();
    const jobs = createJobRegistry({ bus });
    const control = createControlApplier({ dir, bus, jobs });

    // Exactly what the server writes when the editor presses Kill on one outlet's tile.
    const record = appendControl(dir, {
      action: 'kill',
      target: { kind: 'job', stage: 'harvest', job_id: 'harvest:ynet' },
      by: 'editor',
    });
    control.apply(record, { source: 'ipc' });

    const res = await fanOut(dir, { bus, jobs, concurrency: 2 }).result;

    assert.equal(res.ok, true, 'four outlets out of five is partial coverage, not a failure');

    const spawnedFor = bus.ofType('agent.spawn').map((e) => e.job_id);
    assert.ok(!spawnedFor.includes('harvest:ynet'), `ynet was spawned anyway: ${spawnedFor.join(', ')}`);
    assert.equal(spawnedFor.length, 4);
    assert.ok(!fs.existsSync(path.join(dir, '02_items.part-ynet.json')), 'a declined shard writes nothing');

    const [skipped] = bus.ofType('job.skipped');
    assert.equal(skipped.job_id, 'harvest:ynet');

    const degraded = bus.ofType('stage.progress').find((e) => e.degraded);
    assert.ok(degraded, 'a missing shard is a recorded gap, not a silent omission');
    assert.match(degraded.message, /1 stopped by you/);

    const merged = JSON.parse(fs.readFileSync(path.join(dir, '02_items.json'), 'utf8'));
    assert.equal(merged.items.length, 3, 'ynet contributed two items and neither is here');
    assert.ok(!merged.items.some((i) => i.outlet_id === 'ynet'));
    assert.ok(!merged.outlet_status.some((s) => s.outlet_id === 'ynet'));
    assert.equal(bus.ofType('stage.error').length, 0);
  });

  test('a held run starts no agents, and starts them all when it is let go', async () => {
    const dir = harvestRunDir();
    const bus = recordingBus();
    const jobs = createJobRegistry({ bus });
    const control = createControlApplier({ dir, bus, jobs });

    control.apply(appendControl(dir, { action: 'pause', target: { kind: 'run' }, by: 'editor' }));
    assert.equal(control.isRunPaused(), true);

    const pending = fanOut(dir, { bus, jobs, control, concurrency: 2 }).result;

    await sleep(300);
    assert.equal(bus.ofType('agent.spawn').length, 0, 'a held run must not spend a penny while it is held');
    assert.ok(!fs.existsSync(path.join(dir, '02_items.json')));

    control.apply(appendControl(dir, { action: 'resume', target: { kind: 'run' }, by: 'editor' }));
    const res = await pending;

    assert.equal(res.ok, true, JSON.stringify(res.errors));
    assert.equal(bus.ofType('agent.spawn').length, 5, 'everything held back ran, once each');
    assert.equal(bus.ofType('run.paused').length, 1);
    assert.equal(bus.ofType('run.resumed').length, 1);
  });

  test('a stage whose every piece was stopped is cancelled, not failed', async () => {
    const dir = harvestRunDir();
    const bus = recordingBus();
    const jobs = createJobRegistry({ bus });
    const control = createControlApplier({ dir, bus, jobs });

    control.apply(appendControl(dir, { action: 'kill', target: { kind: 'stage', stage: 'harvest' }, by: 'editor' }));

    const res = await fanOut(dir, { bus, jobs }).result;

    assert.equal(res.ok, false);
    assert.equal(res.killed, true);
    assert.equal(res.cancelled, true);
    assert.match(res.errors[0], /you stopped every piece/);
    assert.equal(bus.ofType('agent.spawn').length, 0, 'nothing may be spawned for a killed stage');
    assert.equal(bus.ofType('stage.error').length, 0, 'the editor stopping the work is not the work failing');
    assert.equal(bus.ofType('job.skipped').length, 5);
    assert.ok(!fs.existsSync(path.join(dir, '02_items.json')), 'nothing came through, so nothing was merged');
  });
});

// -------------------------------------------------------------- shard-level resume

describe('a continued run does not gather what it already gathered', () => {
  test('a part file that still validates is reused; one that does not is fetched again', async () => {
    const dir = harvestRunDir();

    // The first attempt: everything comes through.
    await fanOut(dir).result;
    fs.rmSync(path.join(dir, '02_items.json'));

    // Then the machine went to sleep halfway through writing one of them.
    const halfWritten = path.join(dir, '02_items.part-haaretz.json');
    fs.writeFileSync(halfWritten, JSON.stringify({ schema_version: '1.0', stage: 'harvest' }), 'utf8');

    assert.ok(shardPartAlreadyGood(dir, HARVEST, 'ynet'), 'a complete part is reusable');
    assert.equal(shardPartAlreadyGood(dir, HARVEST, 'haaretz'), null, 'a part that fails its contract is not');
    assert.equal(shardPartAlreadyGood(dir, HARVEST, 'not_an_outlet'), null);

    const bus = recordingBus();
    const res = await fanOut(dir, { bus, resume: true }).result;

    assert.equal(res.ok, true, JSON.stringify(res.errors));
    const reused = bus.ofType('job.skipped');
    assert.equal(reused.length, 4, 'four of five were already on disk');
    assert.equal(reused[0].reason, 'already gathered');
    assert.ok(reused.every((e) => e.job_id.startsWith('harvest:')));

    const spawned = bus.ofType('agent.spawn').map((e) => e.job_id);
    assert.deepEqual(spawned, ['harvest:haaretz'], 'only the piece that was not finished is done again');

    const merged = JSON.parse(fs.readFileSync(path.join(dir, '02_items.json'), 'utf8'));
    assert.equal(merged.items.length, 5, 'the reused parts are merged in exactly as they were');
  });

  test('a FRESH run never adopts a part file lying around in the directory', async () => {
    const dir = harvestRunDir();
    await fanOut(dir).result;
    fs.rmSync(path.join(dir, '02_items.json'));

    const bus = recordingBus();
    const res = await fanOut(dir, { bus }).result; // resume: false

    assert.equal(res.ok, true);
    assert.equal(bus.ofType('job.skipped').length, 0);
    assert.equal(bus.ofType('agent.spawn').length, 5, 'this morning’s news is not yesterday’s part files');
  });
});

// ------------------------------------------------------- the whole pipeline, offline

describe('a run, its checkpoint and its second attempt', () => {
  let runsDir;
  let first;

  before(async () => {
    runsDir = newDir('runs-');
    first = await runPipeline({ replay: SNAP, runsDir, slug: 'checkpoint' });
  });

  test('state.json is written, round-trips, and agrees with what is on disk', () => {
    assert.equal(first.status, 'complete');

    const checkpoint = readCheckpoint(first.dir);
    assert.ok(checkpoint, 'a finished run must leave a checkpoint behind');
    assert.equal(checkpoint.schema_version, '1.0');
    assert.equal(checkpoint.run_id, first.runId);
    assert.equal(checkpoint.status, 'complete');
    assert.equal(checkpoint.mode, 'replay');
    assert.equal(checkpoint.control.paused, false);
    assert.deepEqual(checkpoint.control.killed_jobs, []);

    // The milestones are a promise about what is on disk. Hold them to the audit.
    const audit = verifyRun(first.dir);
    const good = audit.rows.filter((r) => r.present && r.ok).map((r) => r.stage);
    assert.deepEqual(
      checkpoint.milestones.map((m) => m.stage),
      good,
      'every milestone must correspond to an artifact that satisfies its contract'
    );
    assert.ok(checkpoint.milestones.every((m) => m.resumable));
    assert.deepEqual(
      checkpoint.milestones.map((m) => m.title).slice(0, 2),
      ['Outlet ranking', 'Harvest'],
      'the titles come from the stage registry, which core cannot import'
    );

    // The checkpoint is a cache and nothing more: it must be reproducible from the events.
    const rebuilt = refreshRunCheckpoint(first.dir, { write: false });
    assert.deepEqual(rebuilt.milestones, checkpoint.milestones);
    assert.ok(readEvents(path.join(first.dir, 'events.ndjson')).some((e) => e.type === 'checkpoint.write'));
  });

  test('a step the editor stopped ends the run as cancelled, and stays stopped on the next attempt', async () => {
    // Wind the run back to just before the step we are about to stop.
    for (const stage of STAGES.slice(2)) {
      fs.rmSync(path.join(first.dir, stage.artifact), { force: true });
    }
    appendControl(first.dir, {
      action: 'kill',
      target: { kind: 'job', stage: 'cluster', job_id: 'cluster' },
      by: 'editor',
      request_id: 'kill-cluster',
    });

    const stopped = await runPipeline({
      replay: SNAP,
      runsDir,
      resumeRunId: first.runId,
      from: 'cluster',
    });

    assert.equal(stopped.status, 'cancelled', 'the editor stopping a step is not the run failing');
    assert.equal(stopped.failed, null);
    assert.ok(!fs.existsSync(path.join(first.dir, '03_stories.json')), 'the stopped step wrote nothing');

    const events = readEvents(path.join(first.dir, 'events.ndjson'));
    assert.ok(
      events.some((e) => e.type === 'control.applied' && e.request_id === 'kill-cluster'),
      'the instruction recorded before this attempt started was replayed'
    );
    assert.ok(events.some((e) => e.type === 'job.skipped' && e.job_id === 'cluster'));
    assert.ok(events.some((e) => e.type === 'stage.progress' && /Continue this run from/.test(e.message ?? '')));

    const checkpoint = readCheckpoint(first.dir);
    assert.equal(checkpoint.status, 'cancelled');
    assert.equal(checkpoint.stages.cluster.jobs.cluster.status, 'skipped', 'the checkpoint says who stopped what');
    assert.ok(
      checkpoint.milestones.some((m) => m.stage === 'cluster' && m.resumable),
      'the step that was stopped is exactly where this run can be picked up again'
    );

    // ...and again, this time saying "no, do try it".
    const retried = await runPipeline({
      replay: SNAP,
      runsDir,
      resumeRunId: first.runId,
      from: 'cluster',
      retryKilled: true,
    });
    assert.equal(retried.status, 'complete');
    assert.ok(fs.existsSync(path.join(first.dir, '03_stories.json')));
  });
});
