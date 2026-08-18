import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import {
  resolveAllowlist,
  narrowOutletsYaml,
  narrowsRanking,
  intersectRanked,
  registryOutlets,
  MIN_RANKED_OUTLETS,
  readConfigFile,
  STAGES,
} from '../src/index.js';

/**
 * The allowlist narrows and never adds. Every test here is a form of that one sentence:
 * an outlet is harvested only if the editor allowed it AND step 1 actually ranked it, and
 * anything the editor asked for that did not survive is reported rather than dropped.
 */

const REGISTRY = readConfigFile('outlets.he.yaml');
const harvest = STAGES.find((s) => s.id === 'harvest');

describe('reading what the editor typed', () => {
  test('matches on id, English name and Hebrew name alike', () => {
    assert.deepEqual(resolveAllowlist(['ynet'], REGISTRY).ids, ['ynet']);
    assert.deepEqual(resolveAllowlist(['Haaretz'], REGISTRY).ids, ['haaretz']);
    assert.deepEqual(resolveAllowlist(['  YNET  '], REGISTRY).ids, ['ynet'], 'case and padding are the editor’s, not ours');
    const he = registryOutlets(REGISTRY).find((o) => o.id === 'haaretz')?.name_he;
    if (he) assert.deepEqual(resolveAllowlist([he], REGISTRY).ids, ['haaretz'], 'a Hebrew desk must be able to type Hebrew');
  });

  test('accepts a comma-separated line, as the CLI flag hands it over', () => {
    assert.deepEqual(resolveAllowlist('ynet, haaretz', REGISTRY).ids, ['ynet', 'haaretz']);
  });

  test('nothing means no restriction, not an empty universe', () => {
    for (const empty of [undefined, null, '', [], '   ']) {
      assert.deepEqual(resolveAllowlist(empty, REGISTRY).ids, [], `${JSON.stringify(empty)} must mean "all"`);
    }
  });

  test('an unrecognised outlet is reported, never silently dropped', () => {
    const { ids, unknown } = resolveAllowlist(['ynet', 'the daily planet'], REGISTRY);
    assert.deepEqual(ids, ['ynet']);
    assert.deepEqual(unknown, ['the daily planet']);
  });

  test('duplicates collapse and registry order wins over typing order', () => {
    const { ids } = resolveAllowlist(['haaretz', 'ynet', 'Haaretz'], REGISTRY);
    assert.deepEqual(ids, ['ynet', 'haaretz'], 'ynet precedes haaretz in the registry');
  });
});

describe('narrowing what step 1 is shown', () => {
  test('keeps only the allowed outlets and says the universe was narrowed', () => {
    const ids = ['ynet', 'haaretz', 'mako_n12'];
    const doc = YAML.parse(narrowOutletsYaml(REGISTRY, ids));
    assert.deepEqual(new Set(doc.outlets.map((o) => o.id)), new Set(ids));
    assert.equal(doc.meta.allowlist.applied, true);
    assert.equal(doc.meta.allowlist.kept, 3);
    assert.match(doc.meta.allowlist.note, /not the whole Israeli press/);
  });

  test('the filtered registry keeps registry order, whatever order it was asked in', () => {
    // Order is the registry's throughout — it is what artifacts and rankings use, and a
    // stable order is what makes two runs comparable.
    const doc = YAML.parse(narrowOutletsYaml(REGISTRY, ['haaretz', 'ynet']));
    const registryOrder = registryOutlets(REGISTRY)
      .map((o) => o.id)
      .filter((id) => ['haaretz', 'ynet'].includes(id));
    assert.deepEqual(doc.outlets.map((o) => o.id), registryOrder);
  });

  test('the untouched registry is returned when nothing is allowed', () => {
    assert.equal(narrowOutletsYaml(REGISTRY, []), REGISTRY);
  });

  test('below the ranking floor, step 1 keeps the whole registry', () => {
    // The outlets contract requires 5. Narrowing to 3 would make S1 fail its own schema,
    // so the harvest narrows alone.
    assert.equal(narrowsRanking(['ynet', 'haaretz']), false);
    assert.equal(narrowsRanking(['a', 'b', 'c', 'd', 'e']), true);
    assert.equal(MIN_RANKED_OUTLETS, 5);
  });

  test('the floor matches what the contract actually demands', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { CONTRACTS_DIR } = await import('@carica/core');
    const schema = JSON.parse(fs.readFileSync(path.join(CONTRACTS_DIR, '01_outlets.schema.json'), 'utf8'));
    assert.equal(
      schema.properties.outlets.minItems,
      MIN_RANKED_OUTLETS,
      'if the contract changes its floor, MIN_RANKED_OUTLETS must move with it or runs will fail schema'
    );
  });
});

describe('allowed ∩ ranked', () => {
  const ranked = [{ id: 'ynet' }, { id: 'haaretz' }, { id: 'walla' }];

  test('no allowlist harvests everything that was ranked', () => {
    const { kept, skipped, missing } = intersectRanked(ranked, []);
    assert.equal(kept.length, 3);
    assert.deepEqual(skipped, []);
    assert.deepEqual(missing, []);
  });

  test('only the intersection is harvested', () => {
    const { kept, skipped } = intersectRanked(ranked, ['ynet', 'walla']);
    assert.deepEqual(kept.map((o) => o.id), ['ynet', 'walla']);
    assert.deepEqual(skipped, ['haaretz']);
  });

  test('an allowed outlet that step 1 never ranked is reported, not invented', () => {
    const { kept, missing } = intersectRanked(ranked, ['ynet', 'globes']);
    assert.deepEqual(kept.map((o) => o.id), ['ynet'], 'never harvest an outlet with no ranking behind it');
    assert.deepEqual(missing, ['globes']);
  });

  test('an allowlist that intersects nothing yields nothing — it must not fall back to all', () => {
    const { kept, missing } = intersectRanked(ranked, ['globes']);
    assert.equal(kept.length, 0, 'a silent fallback to every outlet is the opposite of what was asked');
    assert.deepEqual(missing, ['globes']);
  });
});

describe('the harvest fan-out honours it', () => {
  const artifact = { outlets: [{ id: 'ynet', name_en: 'Ynet' }, { id: 'haaretz', name_en: 'Haaretz' }] };

  test('one shard per allowed, ranked outlet', () => {
    const r = harvest.fanout.select(artifact, { allowlist: ['ynet'] });
    assert.deepEqual(r.shards.map((s) => s.key), ['ynet']);
    assert.deepEqual(r.skipped, ['haaretz']);
  });

  test('no allowlist still fans out over everything ranked', () => {
    assert.equal(harvest.fanout.select(artifact, {}).shards.length, 2);
    assert.equal(harvest.fanout.select(artifact).shards.length, 2, 'the options argument is optional');
  });

  test('each shard carries the outlet it is for', () => {
    const [shard] = harvest.fanout.select(artifact, { allowlist: ['haaretz'] }).shards;
    assert.equal(shard.label, 'Haaretz');
    assert.equal(shard.ctx.id, 'haaretz');
  });
});
