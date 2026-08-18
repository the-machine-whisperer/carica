import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { STAGES, selectShards, describeStageCrash } from '../src/index.js';

/**
 * Every fanned-out stage has to survive its own `select`, whichever shape it answers in.
 *
 * The allowlist work taught the call site to destructure `{shards, skipped, missing}`, which
 * only the harvest returns. Ideate, prompt and render return a plain array, so `shards` came
 * back undefined and `shards.length` threw a TypeError out of `runPipeline` — the Concepts
 * step dying with an empty event log and a bare exit code. These tests cover all four fanned
 * stages, not just the one the feature was written against.
 */

const FANNED = STAGES.filter((s) => s.fanout);

/** Enough of each stage's input artifact to produce shards. */
const SOURCE = {
  harvest: { outlets: [{ id: 'ynet', name_en: 'Ynet' }, { id: 'walla', name_en: 'Walla' }] },
  ideate: {
    candidates: [
      { story_id: 'st_a', verdict: 'keep' },
      { story_id: 'st_b', verdict: 'drop' },
      { story_id: 'st_c', verdict: 'keep' },
    ],
  },
  prompt: { candidates: [{ story_id: 'st_a' }, { story_id: 'st_c' }] },
  render: {
    verdicts: [
      { story_id: 'st_a', concept_id: 'c1', verdict: 'PASS' },
      { story_id: 'st_a', concept_id: 'c2', verdict: 'BLOCK' },
    ],
  },
};

describe('selectShards normalises both select shapes', () => {
  test('every fanned stage yields usable shards — the crash was stage-specific', () => {
    for (const stage of FANNED) {
      const out = selectShards(stage, SOURCE[stage.id], []);
      assert.ok(Array.isArray(out.shards), `${stage.id}: shards must be an array`);
      assert.ok(Array.isArray(out.skipped), `${stage.id}: skipped must be an array`);
      assert.ok(Array.isArray(out.missing), `${stage.id}: missing must be an array`);
      assert.ok(out.shards.length > 0, `${stage.id}: expected shards from its own input`);
      for (const s of out.shards) {
        assert.ok(s.key, `${stage.id}: every shard needs a key`);
      }
    }
  });

  test('ideate drops the candidates the verifier rejected, and keeps the rest', () => {
    const ideate = STAGES.find((s) => s.id === 'ideate');
    const { shards } = selectShards(ideate, SOURCE.ideate, []);
    assert.deepEqual(shards.map((s) => s.key), ['st_a', 'st_c']);
  });

  test('the harvest still reports what the allowlist left out', () => {
    const harvest = STAGES.find((s) => s.id === 'harvest');
    const { shards, skipped } = selectShards(harvest, SOURCE.harvest, ['ynet']);
    assert.deepEqual(shards.map((s) => s.key), ['ynet']);
    assert.deepEqual(skipped, ['walla']);
  });

  test('a select that yields nothing is empty, not a crash', () => {
    const ideate = STAGES.find((s) => s.id === 'ideate');
    for (const source of [{}, { candidates: [] }, { candidates: [{ story_id: 'x', verdict: 'drop' }] }]) {
      const out = selectShards(ideate, source, []);
      assert.deepEqual(out, { shards: [], skipped: [], missing: [] });
    }
  });
});

describe('describeStageCrash', () => {
  const stage = { id: 'ideate', title: 'Ideate' };

  test('names the app as the culprit and says a retry will not help', () => {
    const err = new TypeError("Cannot read properties of undefined (reading 'length')");
    const [lead, detail] = describeStageCrash(err, stage);
    assert.match(lead, /^Ideate could not run/);
    assert.match(lead, /defect in this app/);
    assert.match(lead, /continuing will hit it again/i);
    assert.equal(detail, "TypeError: Cannot read properties of undefined (reading 'length')");
  });

  test('points at the first frame inside this project, skipping node internals', () => {
    const err = new Error('boom');
    err.stack = [
      'Error: boom',
      '    at node:internal/process/task_queues:95:5',
      '    at Object.<anonymous> (/app/node_modules/whatever/index.js:1:1)',
      '    at runFannedStage (/app/packages/pipeline/src/pipeline.js:491:34)',
      '    at runPipeline (/app/packages/pipeline/src/pipeline.js:360:22)',
    ].join('\n');
    const out = describeStageCrash(err, stage);
    assert.equal(out.length, 3);
    assert.match(out[2], /^thrown at runFannedStage \(\/app\/packages\/pipeline\/src\/pipeline\.js:491/);
  });

  test('a thrown non-Error still produces something readable', () => {
    const out = describeStageCrash('just a string', stage);
    assert.equal(out.length, 2);
    assert.equal(out[1], 'Error: just a string');
  });
});
