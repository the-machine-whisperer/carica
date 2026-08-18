import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FIXTURES_DIR, readJson } from '@carica/core';
import { resolveSeedSource, seedEarlierStages, STAGES } from '../src/index.js';

/**
 * Starting a run partway through, on results another run already produced.
 *
 * Steps 1 and 2 are the expensive half of the pipeline — the only ones that fan out to an
 * agent per outlet and the only ones that go to the open web. Re-running them to try a
 * different rubric is waste. The rules that keep this from being a lie:
 *
 *   - every carried artifact is checked against its own contract before the run starts;
 *   - `run_id` is rewritten, so an artifact never claims to belong to a run it was not in;
 *   - a source missing what is needed is refused by name, not started and failed later.
 */

const SNAP = path.join(FIXTURES_DIR, '2026-08-11_sample');
let tmp;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carica-seed-'));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const freshRun = (name) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

describe('finding what to carry results over from', () => {
  test('a fixture snapshot is found by name', () => {
    assert.equal(resolveSeedSource('2026-08-11_sample'), SNAP);
  });

  test('an absolute path is taken as given', () => {
    assert.equal(resolveSeedSource(SNAP), SNAP);
  });

  test('a name that is neither is refused, by name', () => {
    assert.throws(() => resolveSeedSource('not-a-run'), /No run or snapshot called "not-a-run"/);
  });

  test('nothing at all is refused rather than defaulting to something', () => {
    assert.throws(() => resolveSeedSource(''), /No run to carry results over from/);
    assert.throws(() => resolveSeedSource(undefined), /No run to carry results over from/);
  });
});

describe('carrying earlier steps over', () => {
  test('copies exactly the steps before the starting point, and no further', () => {
    const dir = freshRun('start-at-cluster');
    const { copied, problems } = seedEarlierStages({ dir, fromId: 'cluster', sourceDir: SNAP });

    assert.deepEqual(problems, []);
    assert.deepEqual(copied, ['outlets', 'harvest'], 'the two expensive steps, and only those');
    assert.ok(fs.existsSync(path.join(dir, '01_outlets.json')));
    assert.ok(fs.existsSync(path.join(dir, '02_items.json')));
    assert.ok(!fs.existsSync(path.join(dir, '03_stories.json')), 'the step being started at must not be pre-filled');
  });

  test('evidence logs come with their artifacts — a carried number stays sourced', () => {
    const dir = freshRun('with-evidence');
    seedEarlierStages({ dir, fromId: 'cluster', sourceDir: SNAP });
    assert.ok(fs.existsSync(path.join(dir, '01_outlets.evidence.jsonl')));
    assert.ok(fs.existsSync(path.join(dir, '02_items.evidence.jsonl')));
  });

  test('a carried artifact belongs to THIS run, not the one it came from', () => {
    const dir = freshRun('2026-01-01T00-00-00Z_mine');
    seedEarlierStages({ dir, fromId: 'cluster', sourceDir: SNAP });
    const carried = readJson(path.join(dir, '01_outlets.json'));
    assert.equal(carried.run_id, '2026-01-01T00-00-00Z_mine');
    assert.notEqual(carried.run_id, readJson(path.join(SNAP, '01_outlets.json')).run_id);
  });

  test('starting near the end carries everything before it', () => {
    const dir = freshRun('start-at-publish');
    const { copied, problems } = seedEarlierStages({ dir, fromId: 'publish', sourceDir: SNAP });
    assert.deepEqual(problems, []);
    assert.equal(copied.length, STAGES.length - 1);
  });

  test('a source missing an artifact is reported, not silently skipped', () => {
    const thin = freshRun('thin-source');
    fs.copyFileSync(path.join(SNAP, '01_outlets.json'), path.join(thin, '01_outlets.json'));
    fs.copyFileSync(path.join(SNAP, '01_outlets.evidence.jsonl'), path.join(thin, '01_outlets.evidence.jsonl'));

    const dir = freshRun('wants-too-much');
    const { copied, problems } = seedEarlierStages({ dir, fromId: 'cluster', sourceDir: thin });
    assert.deepEqual(copied, ['outlets']);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /02_items\.json/);
  });

  test('an artifact that does not satisfy its contract is refused', () => {
    const broken = freshRun('broken-source');
    for (const f of ['01_outlets.json', '01_outlets.evidence.jsonl', '02_items.json', '02_items.evidence.jsonl']) {
      fs.copyFileSync(path.join(SNAP, f), path.join(broken, f));
    }
    // Strip the outlets down below the ranking floor its contract requires.
    const bad = readJson(path.join(broken, '01_outlets.json'));
    bad.outlets = bad.outlets.slice(0, 2);
    fs.writeFileSync(path.join(broken, '01_outlets.json'), JSON.stringify(bad, null, 2));

    const dir = freshRun('refuses-broken');
    const { copied, problems } = seedEarlierStages({ dir, fromId: 'cluster', sourceDir: broken });
    assert.ok(!copied.includes('outlets'), 'starting a run on results that do not validate fails later, confusingly');
    assert.ok(problems.some((p) => /fewer than 5/.test(p)), problems.join(' | '));
  });

  test('an unreadable artifact is a reported problem, not a crash', () => {
    const junk = freshRun('junk-source');
    fs.writeFileSync(path.join(junk, '01_outlets.json'), '{not json');
    const dir = freshRun('handles-junk');
    const { problems } = seedEarlierStages({ dir, fromId: 'harvest', sourceDir: junk });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /not readable JSON/);
  });

  test('the carried steps are announced as skipped, not as work this run did', () => {
    const dir = freshRun('emits-events');
    const events = [];
    seedEarlierStages({ dir, fromId: 'cluster', sourceDir: SNAP, bus: { emit: (type, p) => events.push({ type, ...p }) } });

    const ends = events.filter((e) => e.type === 'stage.end');
    assert.equal(ends.length, 2);
    assert.ok(ends.every((e) => e.skipped && e.ok), 'a carried step is skipped, and it is not a failure');
    assert.match(ends[0].reason, /carried over from 2026-08-11_sample/);

    const writes = events.filter((e) => e.type === 'artifact.write');
    assert.ok(writes.every((w) => w.carried_over_from === '2026-08-11_sample'));
    assert.ok(writes[0].evidence_records > 0, 'the evidence count comes with it');
  });

  test('an unknown starting step is refused', () => {
    const dir = freshRun('bad-stage');
    assert.throws(() => seedEarlierStages({ dir, fromId: 'nonsense', sourceDir: SNAP }), /unknown stage/);
  });
});
