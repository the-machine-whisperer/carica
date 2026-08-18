import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendControl,
  readControl,
  tailControl,
  controlState,
  validateControlRecord,
  deriveCheckpoint,
  writeCheckpoint,
  readCheckpoint,
  resumePoints,
  CHECKPOINT_FILE,
} from '../src/index.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carica-control-'));
const newRunDir = () => fs.mkdtempSync(path.join(tmpRoot, 'run-'));

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const ev = (seq, type, extra = {}) => ({
  seq,
  ts: `2026-08-15T10:00:${String(seq).padStart(2, '0')}Z`,
  type,
  ...extra,
});

describe('a malformed control record never reaches the worker', () => {
  test('the four verbs and three target kinds are accepted', () => {
    assert.ok(validateControlRecord({ action: 'pause', target: { kind: 'run' } }).ok);
    assert.ok(validateControlRecord({ action: 'resume', target: { kind: 'stage', stage: 'harvest' } }).ok);
    assert.ok(
      validateControlRecord({ action: 'kill', target: { kind: 'job', stage: 'harvest', job_id: 'harvest:ynet' } }).ok
    );
    assert.ok(
      validateControlRecord({ action: 'skip', target: { kind: 'job', stage: 'harvest', job_id: 'harvest:ynet' } }).ok
    );
  });

  test('an unknown action is refused by name', () => {
    const r = validateControlRecord({ action: 'obliterate', target: { kind: 'run' } });
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /unknown action/);
  });

  test('an unknown target kind is refused', () => {
    const r = validateControlRecord({ action: 'pause', target: { kind: 'outlet', outlet: 'ynet' } });
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /unknown target kind/);
  });

  test('a job target with no job_id is refused — "some job somewhere" is not a job', () => {
    const r = validateControlRecord({ action: 'kill', target: { kind: 'job', stage: 'harvest' } });
    assert.equal(r.ok, false);
    assert.match(r.errors.join(' '), /job_id/);
  });

  test('garbage does not throw', () => {
    assert.equal(validateControlRecord(null).ok, false);
    assert.equal(validateControlRecord('pause').ok, false);
    assert.equal(validateControlRecord({}).ok, false);
  });
});

describe('the control log on disk', () => {
  test('seq is monotonic and read back in order', () => {
    const dir = newRunDir();
    const a = appendControl(dir, { action: 'pause', target: { kind: 'run' }, by: 'editor' });
    const b = appendControl(dir, { action: 'resume', target: { kind: 'run' }, by: 'editor' });
    assert.equal(a.seq, 1);
    assert.equal(b.seq, 2);
    assert.ok(a.request_id, 'a record with no request_id cannot be deduplicated, so one is generated');
    assert.notEqual(a.request_id, b.request_id);

    const all = readControl(dir);
    assert.deepEqual(all.map((r) => r.action), ['pause', 'resume']);
    assert.deepEqual(readControl(dir, 1).map((r) => r.action), ['resume']);
    assert.equal(all[0].by, 'editor');
  });

  test('a caller-supplied request_id is kept, because that is what makes retries safe', () => {
    const dir = newRunDir();
    const rec = appendControl(dir, {
      action: 'kill',
      target: { kind: 'job', stage: 'harvest', job_id: 'harvest:ynet' },
      request_id: 'req-42',
    });
    assert.equal(rec.request_id, 'req-42');
    assert.equal(readControl(dir)[0].request_id, 'req-42');
  });

  test('an invalid record is refused rather than written — the file is append-only', () => {
    const dir = newRunDir();
    assert.throws(() => appendControl(dir, { action: 'nope', target: { kind: 'run' } }), /invalid control record/);
    assert.deepEqual(readControl(dir), []);
  });

  test('a torn last line does not break the reader or the next seq', () => {
    const dir = newRunDir();
    appendControl(dir, { action: 'pause', target: { kind: 'run' } });
    fs.appendFileSync(path.join(dir, 'control.ndjson'), '{"seq":2,"action":"pau');
    assert.equal(readControl(dir).length, 1);
    assert.equal(appendControl(dir, { action: 'resume', target: { kind: 'run' } }).seq, 2);
  });

  test('an absent control log reads as no records at all', () => {
    assert.deepEqual(readControl(newRunDir()), []);
  });

  test('tailControl replays what is there and then follows', async () => {
    const dir = newRunDir();
    appendControl(dir, { action: 'pause', target: { kind: 'run' }, request_id: 'r1' });

    const seen = [];
    const stop = tailControl(dir, 0, (r) => seen.push(r.request_id), 20);
    try {
      assert.deepEqual(seen, ['r1'], 'everything already on disk arrives on the first drain');
      appendControl(dir, { action: 'resume', target: { kind: 'run' }, request_id: 'r2' });
      await waitFor(() => seen.length === 2);
      assert.deepEqual(seen, ['r1', 'r2']);
    } finally {
      stop();
    }
  });
});

describe('controlState folds a log into standing intentions', () => {
  const rec = (seq, action, target, request_id) => ({
    seq,
    ts: `2026-08-15T10:00:0${seq}Z`,
    request_id: request_id ?? `req-${seq}`,
    action,
    target,
    by: 'editor',
  });

  test('pause → resume → kill lands where it should', () => {
    const s = controlState([
      rec(1, 'pause', { kind: 'run' }),
      rec(2, 'resume', { kind: 'run' }),
      rec(3, 'pause', { kind: 'stage', stage: 'harvest' }),
      rec(4, 'kill', { kind: 'job', stage: 'harvest', job_id: 'harvest:ynet' }),
      rec(5, 'skip', { kind: 'job', stage: 'harvest', job_id: 'harvest:mako' }),
    ]);
    assert.equal(s.paused, false, 'resume clears the matching pause');
    assert.deepEqual(s.pausedStages, ['harvest']);
    assert.deepEqual(s.killedJobs, ['harvest:ynet']);
    assert.deepEqual(s.skippedJobs, ['harvest:mako']);
    assert.deepEqual(s.applied, ['req-1', 'req-2', 'req-3', 'req-4', 'req-5']);
  });

  test('later records win', () => {
    const s = controlState([
      rec(1, 'pause', { kind: 'stage', stage: 'harvest' }),
      rec(2, 'resume', { kind: 'stage', stage: 'harvest' }),
      rec(3, 'pause', { kind: 'stage', stage: 'harvest' }),
    ]);
    assert.deepEqual(s.pausedStages, ['harvest']);
  });

  test('applying the same request twice is a no-op — the worker sees each one three times', () => {
    const once = rec(1, 'kill', { kind: 'job', stage: 'harvest', job_id: 'harvest:ynet' }, 'req-kill');
    const overIpc = { ...once };
    const fromTheFile = { ...once, seq: 1 };
    const onResume = { ...once };

    const s = controlState([overIpc, fromTheFile, onResume]);
    assert.deepEqual(s.killedJobs, ['harvest:ynet']);
    assert.deepEqual(s.applied, ['req-kill'], 'one intention, applied once');
  });

  test('a kill that arrives after a resume is not undone by it', () => {
    const s = controlState([
      rec(1, 'kill', { kind: 'job', stage: 'harvest', job_id: 'harvest:ynet' }),
      rec(2, 'resume', { kind: 'run' }),
    ]);
    assert.deepEqual(s.killedJobs, ['harvest:ynet'], 'there is nothing to un-kill to');
  });

  test('stage- and run-level kills survive the fold, so resume does not revive them', () => {
    const s = controlState([
      rec(1, 'kill', { kind: 'stage', stage: 'render' }),
      rec(2, 'kill', { kind: 'run' }),
    ]);
    assert.deepEqual(s.killedStages, ['render']);
    assert.equal(s.runKilled, true);
  });

  test('malformed records are ignored rather than folded', () => {
    const s = controlState([
      null,
      { action: 'kill', target: { kind: 'job', stage: 'harvest' }, request_id: 'bad' },
      rec(2, 'pause', { kind: 'run' }),
    ]);
    assert.equal(s.paused, true);
    assert.deepEqual(s.killedJobs, []);
    assert.deepEqual(s.applied, ['req-2']);
  });

  test('an empty log is a run under nobody’s hold', () => {
    const s = controlState();
    assert.deepEqual(s, {
      paused: false,
      pausedStages: [],
      killedJobs: [],
      skippedJobs: [],
      killedStages: [],
      skippedStages: [],
      runKilled: false,
      applied: [],
    });
  });
});

describe('the checkpoint is a cache of the projection', () => {
  const finishedRun = () => [
    ev(1, 'run.start', { run_id: 'r1', mode: 'live', from: 'harvest' }),
    ev(2, 'stage.start', { stage: 'outlets', label: 'outlets', artifact: '01_outlets.json' }),
    ev(3, 'stage.end', { stage: 'outlets', label: 'outlets', ok: true, skipped: true, reason: 'carried over' }),
    ev(4, 'stage.progress', { stage: 'harvest', shards: 2 }),
    ev(5, 'stage.start', { stage: 'harvest', label: 'harvest:Ynet', job_id: 'harvest:ynet', shard_key: 'ynet', shard_label: 'Ynet' }),
    ev(6, 'stage.start', { stage: 'harvest', label: 'harvest:Mako', job_id: 'harvest:mako', shard_key: 'mako', shard_label: 'Mako' }),
    ev(7, 'job.killed', { stage: 'harvest', job_id: 'harvest:mako', by: 'editor', reason: 'stuck' }),
    ev(8, 'stage.end', { stage: 'harvest', label: 'harvest:Ynet', job_id: 'harvest:ynet', ok: true }),
    ev(9, 'artifact.write', { stage: 'harvest', label: 'harvest', artifact: '02_items.json' }),
    ev(10, 'stage.end', { stage: 'harvest', label: 'harvest', ok: true, shards: 1, durationMs: 5000 }),
  ];

  test('it carries the run’s identity, its jobs and what the editor did', () => {
    const cp = deriveCheckpoint(finishedRun(), {
      stageMeta: { outlets: { n: 1, title: 'Outlet ranking' }, harvest: { n: 2, title: 'Harvest' } },
    });
    assert.equal(cp.schema_version, '1.0');
    assert.equal(cp.run_id, 'r1');
    assert.equal(cp.mode, 'live');
    assert.equal(cp.from, 'harvest');
    assert.equal(cp.stages.harvest.status, 'ok');
    assert.equal(cp.stages.harvest.artifact, '02_items.json');
    assert.equal(cp.stages.harvest.valid, true);
    assert.equal(cp.stages.harvest.duration_ms, 5000);
    assert.deepEqual(Object.keys(cp.stages.harvest.jobs), ['harvest:ynet', 'harvest:mako']);
    assert.equal(cp.stages.harvest.jobs['harvest:mako'].status, 'killed');
    assert.equal(cp.stages.harvest.jobs['harvest:mako'].label, 'Mako');
    assert.deepEqual(cp.control.killed_jobs, ['harvest:mako']);
    assert.equal(cp.stages.cluster.status, 'pending');
    assert.equal(cp.stages.cluster.valid, false);
  });

  test('it is pure — no clock, so the same events always derive the same file', () => {
    const a = deriveCheckpoint(finishedRun());
    const b = deriveCheckpoint(finishedRun());
    assert.deepEqual(a, b);
    assert.equal(a.updated_at, '2026-08-15T10:00:10Z', 'the last event’s own timestamp, not now()');
  });

  test('milestones are the finished steps plus the next one to do', () => {
    const cp = deriveCheckpoint(finishedRun(), {
      stageMeta: { cluster: { n: 3, title: 'Cluster' } },
    });
    assert.deepEqual(cp.milestones.map((m) => m.stage), ['outlets', 'harvest', 'cluster']);
    const next = cp.milestones[2];
    assert.equal(next.title, 'Cluster', 'titles come from the caller — core cannot import pipeline');
    assert.equal(next.n, 3);
    assert.equal(next.resumable, true, 'everything before it is on disk');
    assert.equal(cp.milestones[0].title, 'outlets', 'and fall back to the bare id when absent');
  });

  test('a gap makes everything after it a dead end', () => {
    // outlets never produced an artifact, so nothing downstream can be started from.
    const cp = deriveCheckpoint([
      ev(1, 'run.start', { run_id: 'r2' }),
      ev(2, 'stage.start', { stage: 'outlets', label: 'outlets' }),
      ev(3, 'stage.error', { stage: 'outlets', label: 'outlets', errors: ['schema: bad'] }),
    ]);
    assert.deepEqual(resumePoints(cp).map((m) => m.stage), ['outlets']);
  });

  test('resumePoints on nothing at all is an empty list, not a throw', () => {
    assert.deepEqual(resumePoints(null), []);
    assert.deepEqual(resumePoints({}), []);
  });

  test('a paused stage is reported as paused, which is what a resume picker acts on', () => {
    const cp = deriveCheckpoint([
      ev(1, 'stage.start', { stage: 'harvest', label: 'harvest' }),
      ev(2, 'stage.paused', { stage: 'harvest', by: 'editor' }),
    ]);
    assert.equal(cp.stages.harvest.status, 'paused');
    assert.deepEqual(cp.control.paused_stages, ['harvest']);
  });
});

describe('the checkpoint on disk', () => {
  test('it round-trips through write and read', () => {
    const dir = newRunDir();
    const cp = deriveCheckpoint([
      ev(1, 'run.start', { run_id: 'r3', mode: 'replay' }),
      ev(2, 'stage.start', { stage: 'outlets', label: 'outlets', artifact: '01_outlets.json' }),
      ev(3, 'stage.end', { stage: 'outlets', label: 'outlets', ok: true }),
    ]);
    writeCheckpoint(dir, cp);
    assert.deepEqual(readCheckpoint(dir), cp);
    assert.ok(fs.existsSync(path.join(dir, CHECKPOINT_FILE)));
  });

  test('an absent checkpoint reads as null — reproject from events instead', () => {
    assert.equal(readCheckpoint(newRunDir()), null);
  });

  test('a truncated checkpoint reads as null and does NOT throw', () => {
    // A run directory is evidence, not a transaction log. A torn cache must degrade to
    // "recompute from the events", never to a crash on the home screen.
    const dir = newRunDir();
    writeCheckpoint(dir, deriveCheckpoint([ev(1, 'run.start', { run_id: 'r4' })]));
    const file = path.join(dir, CHECKPOINT_FILE);
    const whole = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, whole.slice(0, Math.floor(whole.length / 2)), 'utf8');
    assert.equal(readCheckpoint(dir), null);
  });

  test('a checkpoint holding something that is not an object reads as null', () => {
    const dir = newRunDir();
    fs.writeFileSync(path.join(dir, CHECKPOINT_FILE), '"not a checkpoint"', 'utf8');
    assert.equal(readCheckpoint(dir), null);
  });
});

async function waitFor(cond, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}
