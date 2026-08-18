import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIXTURES_DIR, readJson } from '@carica/core';
import { runFannedStage, STAGES, loadCharter, buildCharterContext, readConfigFile } from '../src/index.js';

/**
 * Every fanned-out stage, driven for real.
 *
 * This is the test that was missing. The harvest had live coverage; ideate, prompt and
 * render had none, because the only offline route through them — the replay run in
 * `npm run gate` — short-circuits inside `runFannedStage` before `select` is ever called.
 * So a call-site change that suited the harvest's `select` and broke the other three passed
 * the whole suite and the gate, and then took the Concepts step out with a TypeError and an
 * empty event log.
 *
 * Offline, as ever: `CARICA_CODEX_BIN` points at a fake agent that slices the frozen
 * snapshot. No network, no `codex` binary, no cost.
 */

const SNAP = path.join(FIXTURES_DIR, '2026-08-11_sample');
const FAKE_AGENT = fileURLToPath(new URL('./fake-stage-agent.mjs', import.meta.url));
const FANNED = STAGES.filter((s) => s.fanout);

function recordingBus() {
  const events = [];
  return {
    events,
    emit: (type, payload = {}) => {
      events.push({ type, ...payload });
    },
    ofType: (type) => events.filter((e) => e.type === type),
  };
}

let tmpRoot;
let savedBin;
let savedFixture;

before(() => {
  fs.chmodSync(FAKE_AGENT, 0o755);
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carica-fanout-'));
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

/** A run directory holding the snapshot's artifacts, so a stage has its input to fan out on. */
function runDirFor(stage) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, `${stage.id}-`));
  for (const f of fs.readdirSync(SNAP)) {
    if (f.endsWith('.json') || f.endsWith('.jsonl')) fs.copyFileSync(path.join(SNAP, f), path.join(dir, f));
  }
  // The stage's own output must not already be sitting there, or there is nothing to prove.
  fs.rmSync(path.join(dir, stage.artifact), { force: true });
  return dir;
}

/** The charter context exactly as `runPipeline` builds it — not a hand-rolled stand-in. */
function contextFor(stage, dir) {
  return buildCharterContext({
    stage,
    dir,
    runId: path.basename(dir),
    policyText: readConfigFile('editorial-policy.md'),
    weightsText: readConfigFile('weights.yaml'),
    outletsText: readConfigFile('outlets.he.yaml'),
  });
}

/** Everything `runFannedStage` needs, minus the stage-specific bits. */
function fanArgs(stage, dir, bus) {
  return {
    stage,
    dir,
    bus,
    model: null,
    mode: 'live',
    charters: { [stage.id]: loadCharter(stage.charter) },
    ctx: contextFor(stage, dir),
    concurrency: 4,
    allowlist: [],
  };
}

describe('every fanned-out stage can actually fan out', () => {
  for (const stage of FANNED) {
    test(`${stage.id} shards, runs and merges`, async () => {
      const dir = runDirFor(stage);
      const bus = recordingBus();

      const result = await runFannedStage(fanArgs(stage, dir, bus));

      assert.ok(result.ok, `${stage.id} failed: ${JSON.stringify(result.errors)}`);

      // It really fanned out — one agent per shard, not one agent for the stage.
      const spawns = bus.ofType('agent.spawn');
      assert.ok(spawns.length > 0, `${stage.id}: no agent was spawned`);

      // And the merged artifact is on disk and satisfies the stage's own contract, which
      // `runFannedStage` checks for itself before returning ok.
      const merged = readJson(path.join(dir, stage.artifact));
      assert.equal(merged.schema_version, '1.0');
      assert.equal(typeof merged.agent.model, 'string');
    });
  }

  test('the fan-out is reached in live mode — not short-circuited as replay is', async () => {
    const ideate = STAGES.find((s) => s.id === 'ideate');
    const dir = runDirFor(ideate);
    const bus = recordingBus();

    await runFannedStage(fanArgs(ideate, dir, bus));

    // Two verified candidates in the snapshot, neither dropped: two shards, announced as
    // such. If this ever reads "1", the stage stopped fanning out and became one agent.
    const progress = bus.ofType('stage.progress').map((e) => e.message);
    assert.ok(
      progress.some((m) => /fanning out 2 shards/.test(m)),
      `expected a two-shard fan-out, saw: ${JSON.stringify(progress)}`
    );
  });
});
