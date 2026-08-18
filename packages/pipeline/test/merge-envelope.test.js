import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateArtifact } from '@carica/core';

import { STAGES, mergedModel } from '../src/index.js';

/**
 * The envelope on a MERGED artifact is written by the pipeline, not by an agent — and it is
 * checked by the same schema, which requires `agent.model` to be a string.
 *
 * S2 shipped writing `"model": null` there, because no model is named on a normal run and
 * the null went through untouched. Every shard succeeded, the merge then failed its own
 * contract on `/agent/model must be string`, and the retry re-ran the agents twice against a
 * field none of them wrote. These tests pin the two halves of that: the value is always a
 * string, and it is the string that says what actually ran.
 */

const harvest = STAGES.find((s) => s.id === 'harvest');

const shard = (model) => ({ agent: { model, charter_sha: 'sha', attempt: 1 } });

describe('mergedModel', () => {
  test('no model configured — reports what the shards said they were', () => {
    assert.equal(mergedModel(null, [shard('gpt-5'), shard('gpt-5')]), 'gpt-5');
  });

  test('a configured model wins over the shards self-reports', () => {
    assert.equal(mergedModel('gpt-5-codex', [shard('gpt-5')]), 'gpt-5-codex');
  });

  test('shards that disagree are all recorded — provenance, not a guess', () => {
    assert.equal(mergedModel(null, [shard('gpt-5'), shard('gpt-5.6'), shard('gpt-5')]), 'gpt-5, gpt-5.6');
  });

  test('casing is not a disagreement — the real run answered three ways for two models', () => {
    const parts = [shard('gpt-5'), shard('GPT-5'), shard('gpt-5.6'), shard('GPT-5')];
    assert.equal(mergedModel(null, parts), 'gpt-5, gpt-5.6');
  });

  test('nothing configured and nothing reported still yields a string', () => {
    for (const parts of [[], [shard(null)], [shard('')], [{}], [undefined]]) {
      assert.equal(mergedModel(null, parts), 'codex-default');
    }
  });

  test('a blank configured model is not a model name', () => {
    assert.equal(mergedModel('   ', [shard('gpt-5')]), 'gpt-5');
  });
});

describe('the merged envelope satisfies the stage contract', () => {
  test('S2 validates with no model configured — the case that failed three times', () => {
    const merged = {
      schema_version: '1.0',
      stage: 'harvest',
      run_id: '2026-08-16T19-36-53Z_sunday-column',
      generated_at: '2026-08-16T19:40:00Z',
      agent: {
        model: mergedModel(null, [shard('gpt-5'), shard('GPT-5')]),
        charter_sha: 'sha',
        attempt: 1,
      },
      items: [],
      outlet_status: [{ outlet_id: 'ynet', ok: true, item_count: 0, robots_allowed: true }],
    };

    const res = validateArtifact(harvest.contract, merged);
    assert.ok(res.ok, res.errors.join('; '));
  });

  test('the null that shipped is exactly what the contract rejects', () => {
    const merged = {
      schema_version: '1.0',
      stage: 'harvest',
      run_id: 'r1',
      generated_at: '2026-08-16T19:40:00Z',
      agent: { model: null, charter_sha: 'sha', attempt: 1 },
      items: [],
      outlet_status: [{ outlet_id: 'ynet', ok: true, item_count: 0, robots_allowed: true }],
    };

    const res = validateArtifact(harvest.contract, merged);
    assert.equal(res.ok, false);
    assert.ok(
      res.errors.some((e) => e.includes('/agent/model') && e.includes('string')),
      res.errors.join('; ')
    );
  });
});
