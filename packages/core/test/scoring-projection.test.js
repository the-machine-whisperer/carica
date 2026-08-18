import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  weightedTotal,
  rerank,
  floorBreaches,
  arithmeticString,
  DIMENSION_KEYS,
  projectRun,
  activeStage,
  STAGE_ORDER,
  FIXTURES_DIR,
  ACTIVITY_LIMIT,
} from '../src/index.js';

const SNAP = path.join(FIXTURES_DIR, '2026-08-11_sample');
const scored = JSON.parse(fs.readFileSync(path.join(SNAP, '05_scored.json'), 'utf8'));

describe('scoring arithmetic matches the artifact', () => {
  test('recomputes every candidate total exactly as S5 reported it', () => {
    for (const c of scored.candidates) {
      assert.equal(
        weightedTotal(c.dimensions, scored.weights),
        c.weighted_total,
        `${c.story_id}: UI arithmetic must reproduce the artifact's own total, or the sliders lie`
      );
    }
  });

  test('covers all nine dimensions', () => {
    assert.equal(DIMENSION_KEYS.length, 9);
    for (const k of DIMENSION_KEYS) assert.ok(k in scored.weights, `weights missing ${k}`);
  });

  test('legal_risk subtracts', () => {
    const dims = Object.fromEntries(DIMENSION_KEYS.map((k) => [k, { score: 0 }]));
    dims.legal_risk = { score: 10 };
    assert.ok(weightedTotal(dims, scored.weights) < 0, 'risk must reduce the total');
  });

  test('arithmetic string ends in the computed total', () => {
    const c = scored.candidates[0];
    const s = arithmeticString(c.dimensions, scored.weights);
    assert.ok(s.endsWith(c.weighted_total.toFixed(2)), s);
  });
});

describe('re-ranking is capable of actually changing the order', () => {
  test('default weights reproduce the artifact ranking', () => {
    const ranked = rerank(scored.candidates, scored.weights);
    assert.deepEqual(
      ranked.map((c) => c.story_id),
      [...scored.candidates].sort((a, b) => a.rank - b.rank).map((c) => c.story_id)
    );
  });

  test('an editor who only cares about legibility gets a DIFFERENT winner', () => {
    // st_night_vote wins by default (7.32 vs 6.26) but st_recycled_renders scores
    // legibility 9 vs 8. A slider that cannot flip this is decorative.
    const before = rerank(scored.candidates, scored.weights)[0].story_id;
    const legibilityOnly = Object.fromEntries(DIMENSION_KEYS.map((k) => [k, 0]));
    legibilityOnly.legibility = 1;
    const after = rerank(scored.candidates, legibilityOnly)[0].story_id;
    assert.notEqual(after, before, 're-weighting must be able to change the winner');
    assert.equal(after, 'st_recycled_renders');
  });

  test('ranks are dense and start at 1', () => {
    const ranked = rerank(scored.candidates, scored.weights);
    assert.deepEqual(ranked.map((c) => c.rank), ranked.map((_, i) => i + 1));
  });

  test('empty input does not throw', () => {
    assert.deepEqual(rerank(undefined, scored.weights), []);
  });
});

describe('floors are gates, not preferences', () => {
  const floors = { legibility_min: 4, legal_risk_max: 7, shelf_life_min: 3 };

  test('clean candidate breaches nothing', () => {
    assert.deepEqual(floorBreaches(scored.candidates[0].dimensions, floors), []);
  });

  test('illegible candidate is caught', () => {
    const dims = { ...scored.candidates[0].dimensions, legibility: { score: 2 } };
    assert.equal(floorBreaches(dims, floors).length, 1);
  });

  test('high legal risk is caught', () => {
    const dims = { ...scored.candidates[0].dimensions, legal_risk: { score: 9 } };
    assert.match(floorBreaches(dims, floors)[0], /standards desk/);
  });
});

describe('event projection', () => {
  const ev = (seq, type, extra = {}) => ({ seq, ts: `2026-08-11T10:00:${String(seq).padStart(2, '0')}Z`, type, ...extra });

  test('projects a real run log from disk', () => {
    // Use the newest run directory produced by the replay gate, if present — which means
    // the newest COMPLETE one. Taking the newest of all runs picks up a failed live run the
    // moment there is one, and then asserts it completed, which it plainly did not.
    const runsDir = path.join(FIXTURES_DIR, '..', 'runs');
    if (!fs.existsSync(runsDir)) return;
    const dirs = fs
      .readdirSync(runsDir)
      .filter((d) => fs.existsSync(path.join(runsDir, d, 'events.ndjson')))
      .filter((d) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(runsDir, d, 'run.json'), 'utf8')).status === 'complete';
        } catch {
          return false;
        }
      });
    if (!dirs.length) return;
    const file = path.join(runsDir, dirs.sort().pop(), 'events.ndjson');
    const events = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const state = projectRun(events);
    assert.equal(state.status, 'complete');
    for (const id of STAGE_ORDER) {
      // `skipped` is a finished step too: a run started partway through carries its earlier
      // steps over from another run rather than redoing them, and they project as skipped.
      assert.ok(
        ['ok', 'skipped'].includes(state.stages[id].status),
        `${id} should have finished in the replay run, got ${state.stages[id].status}`
      );
    }
  });

  test('pending until started', () => {
    const s = projectRun([ev(1, 'run.start', { run_id: 'r', mode: 'live' })]);
    assert.equal(s.stages.outlets.status, 'pending');
    assert.equal(s.status, 'running');
  });

  test('running, then ok, with duration', () => {
    const s = projectRun([
      ev(1, 'run.start', { run_id: 'r' }),
      ev(2, 'stage.start', { stage: 'outlets', label: 'outlets' }),
      ev(5, 'stage.end', { stage: 'outlets', label: 'outlets', ok: true, durationMs: 4200 }),
    ]);
    assert.equal(s.stages.outlets.status, 'ok');
    assert.equal(s.stages.outlets.durationMs, 4200);
  });

  test('stage.error marks failed and keeps the errors', () => {
    const s = projectRun([
      ev(1, 'stage.start', { stage: 'score', label: 'score' }),
      ev(2, 'stage.error', { stage: 'score', label: 'score', errors: ['schema: /candidates must NOT have fewer than 1 items'] }),
    ]);
    assert.equal(s.stages.score.status, 'failed');
    assert.match(s.stages.score.errors[0], /fewer than 1/);
  });

  test('shard events fold onto the parent without resetting it', () => {
    const s = projectRun([
      ev(1, 'stage.start', { stage: 'harvest', label: 'harvest', artifact: '02_items.json' }),
      ev(2, 'stage.progress', { stage: 'harvest', message: 'fanning out 5 shards', shards: 5 }),
      ev(3, 'stage.start', { stage: 'harvest', label: 'harvest:Ynet', artifact: '02_items.part-ynet.json' }),
      ev(4, 'stage.end', { stage: 'harvest', label: 'harvest:Ynet', ok: true }),
      ev(5, 'stage.end', { stage: 'harvest', label: 'harvest:Mako', ok: true }),
    ]);
    assert.equal(s.stages.harvest.status, 'running', 'a finished shard must not finish the parent');
    assert.equal(s.stages.harvest.shards, 5);
    assert.equal(s.stages.harvest.shardsCompleted, 2);
    assert.equal(s.stages.harvest.artifact, '02_items.json', 'parent artifact must not be overwritten by a shard part file');
  });

  test('degraded fan-out is surfaced', () => {
    const s = projectRun([
      ev(1, 'stage.start', { stage: 'harvest', label: 'harvest' }),
      ev(2, 'stage.progress', { stage: 'harvest', message: '1 of 5 shards failed', degraded: true }),
    ]);
    assert.equal(s.stages.harvest.degraded, true);
  });

  test('retries are retained for the drawer', () => {
    const s = projectRun([
      ev(1, 'stage.start', { stage: 'score', label: 'score' }),
      ev(2, 'agent.retry', { stage: 'score', attempt: 1, reason: 'contract_violation', errors: ['schema: bad'] }),
    ]);
    assert.equal(s.stages.score.retries.length, 1);
    assert.equal(s.stages.score.retries[0].reason, 'contract_violation');
  });

  test('human checkpoint halts and is surfaced', () => {
    const s = projectRun([
      ev(1, 'run.start', { run_id: 'r' }),
      ev(2, 'human.required', { stage: 'publish', message: 'Editorial approval required.' }),
    ]);
    assert.equal(s.status, 'awaiting_human');
    assert.equal(s.humanRequired.stage, 'publish');
    assert.equal(activeStage(s), 'publish');
  });

  test('lastSeq tracks the high-water mark for SSE resume', () => {
    const s = projectRun([ev(1, 'run.start'), ev(7, 'stage.start', { stage: 'outlets' })]);
    assert.equal(s.lastSeq, 7);
  });

  test('garbage events do not throw', () => {
    const s = projectRun([null, 'nonsense', {}, { type: 'unknown.thing', stage: 'nope' }]);
    assert.equal(s.status, 'idle');
  });

  test('activeStage prefers the running stage', () => {
    const s = projectRun([
      ev(1, 'stage.start', { stage: 'outlets' }),
      ev(2, 'stage.end', { stage: 'outlets', ok: true }),
      ev(3, 'stage.start', { stage: 'harvest' }),
    ]);
    assert.equal(activeStage(s), 'harvest');
  });
});

describe('agent activity projection', () => {
  const ev = (seq, type, extra = {}) => ({ seq, ts: `2026-08-11T10:00:${String(seq).padStart(2, '0')}Z`, type, ...extra });
  const act = (seq, extra) => ev(seq, 'agent.activity', { stage: 'outlets', ...extra });

  test('a command in flight is replaced by its result, not duplicated', () => {
    const state = projectRun([
      ev(1, 'run.start', { run_id: 'r' }),
      ev(2, 'stage.start', { stage: 'outlets', label: 'outlets' }),
      act(3, { kind: 'command', status: 'started', item_id: 'i1', text: 'curl ynet' }),
      act(4, { kind: 'command', status: 'completed', item_id: 'i1', text: 'curl ynet', exit_code: 0, output: 'ok' }),
    ]);
    const a = state.stages.outlets.activity;
    assert.equal(a.length, 1, 'one command happened, so one row');
    assert.equal(a[0].status, 'completed');
    assert.equal(a[0].exitCode, 0);
    assert.equal(state.stages.outlets.activityCounts.command, 1);
  });

  test('counts and token usage accumulate', () => {
    const state = projectRun([
      ev(1, 'stage.start', { stage: 'outlets', label: 'outlets' }),
      act(2, { kind: 'command', status: 'completed', item_id: 'i1', text: 'a' }),
      act(3, { kind: 'search', status: 'completed', item_id: 'i2', text: 'b' }),
      act(4, { kind: 'file', status: 'completed', item_id: 'i3', text: 'c' }),
      act(5, { kind: 'usage', usage: { input: 100, output: 20, cached: 0, reasoning: 5 } }),
    ]);
    const s = state.stages.outlets;
    assert.equal(s.activityCounts.command, 1);
    assert.equal(s.activityCounts.search, 1);
    assert.equal(s.activityCounts.file, 1);
    assert.equal(s.tokens.input, 100);
    assert.equal(s.activity.length, 3, 'usage is a total, not a row in the feed');
  });

  test('a retry clears the feed — the previous attempt is not still happening', () => {
    const state = projectRun([
      ev(1, 'stage.start', { stage: 'outlets', label: 'outlets' }),
      act(2, { kind: 'command', status: 'completed', item_id: 'i1', text: 'a' }),
      ev(3, 'agent.retry', { stage: 'outlets', attempt: 1, reason: 'contract_violation', errors: ['schema: bad'] }),
      act(4, { kind: 'command', status: 'completed', item_id: 'i2', text: 'b' }),
    ]);
    const a = state.stages.outlets.activity;
    assert.equal(a.length, 1);
    assert.equal(a[0].text, 'b');
  });

  test('the feed is bounded, so a long stage cannot grow it without limit', () => {
    const events = [ev(1, 'stage.start', { stage: 'outlets', label: 'outlets' })];
    for (let i = 0; i < ACTIVITY_LIMIT + 40; i++) {
      events.push(act(i + 2, { kind: 'command', status: 'completed', item_id: `i${i}`, text: `cmd ${i}` }));
    }
    const s = projectRun(events).stages.outlets;
    assert.equal(s.activity.length, ACTIVITY_LIMIT);
    assert.equal(s.activity[s.activity.length - 1].text, `cmd ${ACTIVITY_LIMIT + 39}`, 'the tail is what is kept');
    assert.equal(s.activityCounts.command, ACTIVITY_LIMIT + 40, 'the count is of everything, not just the tail');
  });

  test('shard activity is folded onto the parent stage, keeping its label', () => {
    const state = projectRun([
      ev(1, 'stage.start', { stage: 'harvest', label: 'harvest' }),
      ev(2, 'agent.activity', { stage: 'harvest', label: 'harvest:Ynet', kind: 'command', status: 'completed', item_id: 'i1', text: 'curl' }),
    ]);
    assert.equal(state.stages.harvest.activity[0].label, 'harvest:Ynet');
  });

  test('the newest move is exposed for a one-line "what now"', () => {
    const state = projectRun([
      ev(1, 'stage.start', { stage: 'outlets', label: 'outlets' }),
      act(2, { kind: 'command', status: 'completed', item_id: 'i1', text: 'first' }),
      act(3, { kind: 'search', status: 'completed', item_id: 'i2', text: 'last' }),
    ]);
    assert.equal(state.lastActivity.text, 'last');
    assert.equal(state.lastActivity.stage, 'outlets');
  });
});
