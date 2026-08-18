import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  STAGES,
  shardStageFor,
  shardContext,
  loadCharter,
  renderCharter,
  readContract,
  readConfigFile,
  evidencePreamble,
} from '../src/index.js';

/**
 * A fanned-out stage writes ONE pair of files per shard, and every filename in its charter
 * has to agree about which pair.
 *
 * This is not hypothetical tidiness. The preamble used to be built from the parent stage
 * while the rest of the charter was built from the shard, so a harvest agent was told —
 * under a heading reading "Non-negotiable operating rules" — to write `02_items.json` and
 * `02_items.evidence.jsonl`, while the validator read `02_items.part-ynet.json` and
 * `02_items.part-ynet.evidence.jsonl`. It obeyed the non-negotiable half. Every shard then
 * failed on `unsourced claim: evidence_id … has no record`, for evidence it had genuinely
 * fetched and genuinely logged — to the other file. Eighteen shards, three attempts each.
 */

const harvest = STAGES.find((s) => s.id === 'harvest');

/** The parent context, exactly as runPipeline builds it. */
function parentContext(stage) {
  return {
    run_id: 'r1',
    stage_id: stage.id,
    stage_title: stage.title,
    artifact_name: stage.artifact,
    evidence_name: `${stage.slug}.evidence.jsonl`,
    contract_json: readContract(stage.contract),
    operating_rules: evidencePreamble(stage),
    input_artifacts: '01_outlets.json',
    editorial_policy: readConfigFile('editorial-policy.md'),
    weights_yaml: readConfigFile('weights.yaml'),
    outlets_yaml: readConfigFile('outlets.he.yaml'),
    ledger_digest: '[]',
    today: '2026-08-15',
    shard_key: '(not a fanned-out stage)',
    shard_label: '(not a fanned-out stage)',
    shard_context: '{}',
  };
}

const SHARD = { key: 'ynet', label: 'Ynet (Yedioth Ahronoth)', ctx: { id: 'ynet' } };

describe('a shard charter names one pair of files, consistently', () => {
  const shardStage = shardStageFor(harvest, SHARD.key);

  test('the shard stage keeps the parent contract but takes its own files', () => {
    assert.equal(shardStage.artifact, '02_items.part-ynet.json');
    assert.equal(shardStage.slug, '02_items.part-ynet');
    assert.equal(shardStage.contract, harvest.contract, 'a shard satisfies the same schema as the whole');
    assert.equal(shardStage.network, harvest.network);
  });

  test('the operating rules move to the shard with everything else', () => {
    const ctx = shardContext(parentContext(harvest), shardStage, SHARD);
    assert.match(ctx.operating_rules, /02_items\.part-ynet\.json/);
    assert.match(ctx.operating_rules, /02_items\.part-ynet\.evidence\.jsonl/);
    assert.equal(ctx.artifact_name, '02_items.part-ynet.json');
    assert.equal(ctx.evidence_name, '02_items.part-ynet.evidence.jsonl');
  });

  test('THE REGRESSION: the rendered charter never names the parent files', () => {
    const charter = loadCharter(harvest.charter);
    const rendered = renderCharter(charter.text, shardContext(parentContext(harvest), shardStage, SHARD));

    // `02_items.part-ynet.json` does not contain the substring `02_items.json`, so a plain
    // search is an honest test of whether the parent name appears anywhere.
    assert.ok(
      !rendered.includes('02_items.json'),
      'the parent artifact must not be named to a shard — it is what sends the agent to the wrong file'
    );
    assert.ok(
      !rendered.includes('02_items.evidence.jsonl'),
      'the parent evidence log must not be named to a shard'
    );
    assert.ok(rendered.includes('02_items.part-ynet.json'));
    assert.ok(rendered.includes('02_items.part-ynet.evidence.jsonl'));
  });

  test('shard keys that are not filename-safe are still confined to one pair', () => {
    const odd = shardStageFor(harvest, 'Arutz Sheva / Israel National News');
    assert.ok(!odd.artifact.includes('/'), 'a shard key must never escape the run directory');
    assert.equal(`${odd.slug}.json`, odd.artifact, 'artifact and evidence log must derive from one slug');
  });

  test('every fanned-out stage in the registry survives this', () => {
    for (const stage of STAGES.filter((s) => s.fanout)) {
      const ss = shardStageFor(stage, 'k');
      const ctx = shardContext(parentContext(stage), ss, { key: 'k', label: 'K', ctx: {} });
      const rendered = renderCharter(loadCharter(stage.charter).text, ctx);
      assert.ok(!rendered.includes(stage.artifact), `${stage.id} charter still names its parent artifact`);
      assert.ok(
        !rendered.includes(`${stage.slug}.evidence.jsonl`),
        `${stage.id} charter still names its parent evidence log`
      );
    }
  });
});
