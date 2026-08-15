import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRunManager } from '../src/run-manager.js';
import { createRun, readJson, readEvents, REPO_ROOT } from '@carica/core';

/**
 * Stopping a run.
 *
 * A replay run finishes in under a second, so cancelling a real one is a race no test
 * should try to win. Instead a stand-in worker creates a genuine run directory and then
 * sits there, which is exactly the shape of a live run: a process that will not end on
 * its own, holding a run directory that must not be left saying "running" for ever.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carica-stop-'));
const runsDir = path.join(tmp, 'runs');
fs.mkdirSync(runsDir, { recursive: true });

// The stand-ins live outside the repo, so they reach core by path rather than by name.
const CORE = pathToFileURL(path.join(REPO_ROOT, 'packages', 'core', 'src', 'index.js')).href;

const workerPath = path.join(tmp, 'idle-worker.mjs');
fs.writeFileSync(
  workerPath,
  `import { createRun } from '${CORE}';
const opts = JSON.parse(process.argv[2] ?? '{}');
const { runId, dir } = createRun({ slug: opts.slug, runsDir: opts.runsDir, config: { mode: opts.mode } });
process.send?.({ type: 'started', runId, dir, resumed: false });
// Ignore SIGTERM's default so the parent's grace period and hard kill are both exercised.
process.on('SIGTERM', () => process.send?.({ type: 'stopping' }));
setInterval(() => {}, 1000);
`
);

// Belt and braces: a stand-in that outlived its test would keep this process alive.
const spawned = [];
after(() => {
  for (const pid of spawned) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('stopping a run', () => {
  test('start reports the run id, stop closes the run out as cancelled', async () => {
    // A short grace period keeps the test quick; the mechanism is identical.
    const runner = createRunManager({ runsDir, workerPath, stopGraceMs: 800 });

    const started = await runner.start({ mode: 'replay', slug: 'stoppable' });
    spawned.push(runner.getActive().pid);
    assert.ok(started.runId, 'the run id must come back as soon as the directory exists');
    assert.equal(runner.isActive(started.runId), true);
    assert.equal(runner.getActive().run_id, started.runId);

    const dir = path.join(runsDir, started.runId);
    assert.equal(readJson(path.join(dir, 'run.json')).status, 'running');

    // A second run must be refused while this one holds the slot.
    await assert.rejects(() => runner.start({ mode: 'replay' }), /already going/);

    runner.stop(started.runId);
    assert.equal(runner.getActive().stopping, true);

    // The stand-in ignores SIGTERM, so this also proves the hard kill lands.
    const deadline = Date.now() + 20_000;
    while (runner.getActive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.equal(runner.getActive(), null, 'the job must be released when the process dies');

    const manifest = readJson(path.join(dir, 'run.json'));
    assert.equal(manifest.status, 'cancelled', 'a stopped run must not be left saying "running"');
    assert.match(manifest.terminated.reason, /stopped by the editor/);

    const events = readEvents(path.join(dir, 'events.ndjson'));
    assert.equal(events.at(-1).type, 'run.end');
    assert.equal(events.at(-1).status, 'cancelled', 'the app learns the run ended the same way it learns everything else');
  });

  test('a run that dies on its own is recorded as failed, not left hanging', async () => {
    const crasher = path.join(tmp, 'crash-worker.mjs');
    fs.writeFileSync(
      crasher,
      `import { createRun } from '${CORE}';
const opts = JSON.parse(process.argv[2] ?? '{}');
const { runId, dir } = createRun({ slug: opts.slug, runsDir: opts.runsDir, config: { mode: opts.mode } });
process.send?.({ type: 'started', runId, dir, resumed: false });
setTimeout(() => process.exit(3), 150);
`
    );

    const runner = createRunManager({ runsDir, workerPath: crasher });
    const started = await runner.start({ mode: 'replay', slug: 'crasher' });

    const deadline = Date.now() + 20_000;
    while (runner.getActive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));

    const manifest = readJson(path.join(runsDir, started.runId, 'run.json'));
    assert.equal(manifest.status, 'failed');
    assert.match(manifest.terminated.reason, /exited unexpectedly/);
  });

  test('a worker that fails before it starts surfaces the reason', async () => {
    const thrower = path.join(tmp, 'throw-worker.mjs');
    fs.writeFileSync(thrower, `process.send?.({ type: 'error', message: 'no snapshot to replay' });\nprocess.exit(1);\n`);
    const runner = createRunManager({ runsDir, workerPath: thrower });
    await assert.rejects(() => runner.start({ mode: 'replay' }), /no snapshot to replay/);
    assert.equal(runner.getActive(), null, 'a failed start must not leave the slot occupied');
  });

  test('a run directory created by another process is left alone', () => {
    const { runId } = createRun({ slug: 'not-ours', runsDir });
    const runner = createRunManager({ runsDir, workerPath });
    assert.equal(runner.isActive(runId), false);
    assert.equal(readJson(path.join(runsDir, runId, 'run.json')).status, 'running');
  });
});
