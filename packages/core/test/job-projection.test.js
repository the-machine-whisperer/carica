import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { projectRun, jobsOf, activeStage, JOB_ACTIVITY_LIMIT } from '../src/index.js';

/**
 * The job model.
 *
 * A "job" is one unit of agent work — a shard of a fanned-out stage, or a plain stage
 * standing alone. These tests pin down the two things that make it useful: that a shard has
 * an identity the editor can aim at, and that an editor's decision about a shard outranks
 * whatever the agent reports afterwards.
 */

const ev = (seq, type, extra = {}) => ({
  seq,
  ts: `2026-08-15T10:00:${String(seq).padStart(2, '0')}Z`,
  type,
  ...extra,
});

/** A fanned harvest as the pipeline emits it today, with explicit job identity. */
function fannedHarvest() {
  const events = [
    ev(1, 'run.start', { run_id: 'r' }),
    ev(2, 'stage.progress', { stage: 'harvest', message: 'fanning out 3 shards', shards: 3 }),
  ];
  let seq = 3;
  for (const [key, label] of [['ynet', 'Ynet'], ['mako', 'Mako'], ['walla', 'Walla']]) {
    events.push(
      ev(seq++, 'stage.start', {
        stage: 'harvest',
        label: `harvest:${label}`,
        job_id: `harvest:${key}`,
        shard_key: key,
        shard_label: label,
        artifact: `02_items.part-${key}.json`,
      })
    );
  }
  return { events, next: seq };
}

describe('a fanned stage becomes one job per shard', () => {
  test('three shards, three jobs, keyed by shard key and in first-seen order', () => {
    const { events } = fannedHarvest();
    const s = projectRun(events).stages.harvest;

    assert.deepEqual(s.jobOrder, ['harvest:ynet', 'harvest:mako', 'harvest:walla']);
    assert.equal(Object.keys(s.jobs).length, 3);
    assert.equal(s.jobs['harvest:ynet'].label, 'Ynet', 'the display label is what a person reads');
    assert.equal(s.jobs['harvest:ynet'].key, 'ynet', 'the key is what the control channel names');
    assert.equal(s.jobs['harvest:ynet'].status, 'running');
    assert.equal(s.jobs['harvest:ynet'].artifact, '02_items.part-ynet.json');
    assert.equal(s.status, 'running', 'the parent is still the parent');
  });

  test('a fanned stage has NO self-job, even though its parent events name it', () => {
    const { events, next } = fannedHarvest();
    events.push(
      ev(next, 'artifact.write', { stage: 'harvest', label: 'harvest', artifact: '02_items.json' }),
      ev(next + 1, 'stage.end', { stage: 'harvest', label: 'harvest', ok: true, shards: 3 })
    );
    const s = projectRun(events).stages.harvest;
    assert.equal(s.jobs.harvest, undefined, 'the merge is the stage’s work, not a fourth shard');
    assert.equal(s.jobOrder.length, 3);
    assert.equal(s.artifact, '02_items.json');
  });

  test('a parent stage.start that arrived before the fan-out was known is not left behind', () => {
    // Ordering hazard: the self-job is created, THEN the stage reveals itself as a fan-out.
    const s = projectRun([
      ev(1, 'stage.start', { stage: 'harvest', label: 'harvest', artifact: '02_items.json' }),
      ev(2, 'stage.progress', { stage: 'harvest', shards: 2 }),
      ev(3, 'stage.start', { stage: 'harvest', label: 'harvest:Ynet' }),
    ]).stages.harvest;
    assert.deepEqual(s.jobOrder, ['harvest:Ynet']);
  });

  test('a plain stage gets exactly one job, whose id is the stage id', () => {
    const state = projectRun([
      ev(1, 'stage.start', { stage: 'score', label: 'score', artifact: '05_scored.json' }),
      ev(2, 'stage.end', { stage: 'score', label: 'score', ok: true, durationMs: 900 }),
    ]);
    const s = state.stages.score;
    assert.deepEqual(s.jobOrder, ['score'], 'so every node on screen can be drawn the same way');
    assert.equal(s.jobs.score.status, 'ok');
    assert.equal(s.jobs.score.durationMs, 900);
    assert.deepEqual(jobsOf(state, 'score'), [s.jobs.score]);
  });

  test('jobsOf returns jobOrder, not whatever Object.keys felt like', () => {
    const { events } = fannedHarvest();
    const state = projectRun(events);
    assert.deepEqual(
      jobsOf(state, 'harvest').map((j) => j.id),
      ['harvest:ynet', 'harvest:mako', 'harvest:walla']
    );
    assert.deepEqual(jobsOf(state, 'no-such-stage'), []);
  });
});

describe('an old event log with no job_id still projects jobs', () => {
  test('shard identity is derived from the label alone', () => {
    // This is the backwards-compatibility guarantee. A run directory recorded before job
    // identity existed is still evidence, and evidence has to stay readable.
    const s = projectRun([
      ev(1, 'stage.start', { stage: 'harvest', label: 'harvest', artifact: '02_items.json' }),
      ev(2, 'stage.progress', { stage: 'harvest', message: 'fanning out 2 shards', shards: 2 }),
      ev(3, 'stage.start', { stage: 'harvest', label: 'harvest:Ynet', artifact: '02_items.part-ynet.json' }),
      ev(4, 'stage.start', { stage: 'harvest', label: 'harvest:Mako', artifact: '02_items.part-mako.json' }),
      ev(5, 'agent.spawn', { stage: 'harvest', label: 'harvest:Ynet', attempt: 2 }),
      ev(6, 'stage.end', { stage: 'harvest', label: 'harvest:Ynet', ok: true }),
      ev(7, 'stage.end', { stage: 'harvest', label: 'harvest:Mako', ok: false }),
    ]).stages.harvest;

    assert.deepEqual(s.jobOrder, ['harvest:Ynet', 'harvest:Mako']);
    assert.equal(s.jobs['harvest:Ynet'].status, 'ok');
    assert.equal(s.jobs['harvest:Ynet'].attempts, 2);
    assert.equal(s.jobs['harvest:Mako'].status, 'failed');
    assert.equal(s.jobs['harvest:Ynet'].label, 'Ynet');
    assert.equal(s.shardsCompleted, 1, 'the old shard counter keeps working alongside the new model');
  });
});

describe('an editor’s decision about a job is final', () => {
  test('a killed shard stays killed when a later stage.end says it succeeded', () => {
    const s = projectRun([
      ev(1, 'stage.progress', { stage: 'harvest', shards: 2 }),
      ev(2, 'stage.start', { stage: 'harvest', label: 'harvest:Ynet', job_id: 'harvest:ynet', shard_key: 'ynet' }),
      ev(3, 'stage.start', { stage: 'harvest', label: 'harvest:Mako', job_id: 'harvest:mako', shard_key: 'mako' }),
      ev(4, 'job.killed', { stage: 'harvest', job_id: 'harvest:ynet', by: 'editor', reason: 'paywall loop' }),
      // The agent was already mid-write when the kill landed. It reports success anyway.
      ev(5, 'stage.end', { stage: 'harvest', label: 'harvest:Ynet', job_id: 'harvest:ynet', ok: true }),
      ev(6, 'stage.end', { stage: 'harvest', label: 'harvest:Mako', job_id: 'harvest:mako', ok: true }),
    ]).stages.harvest;

    assert.equal(s.jobs['harvest:ynet'].status, 'killed', 'the agent does not get to overrule the editor');
    assert.equal(s.jobs['harvest:ynet'].reason, 'paywall loop');
    assert.equal(s.jobs['harvest:mako'].status, 'ok');
  });

  test('a skipped job survives a later stage.error too', () => {
    const s = projectRun([
      ev(1, 'stage.progress', { stage: 'harvest', shards: 1 }),
      ev(2, 'stage.start', { stage: 'harvest', label: 'harvest:Ynet', job_id: 'harvest:ynet' }),
      ev(3, 'job.skipped', { stage: 'harvest', job_id: 'harvest:ynet', reason: 'reused from checkpoint' }),
      ev(4, 'stage.error', { stage: 'harvest', label: 'harvest:Ynet', job_id: 'harvest:ynet', errors: ['boom'] }),
    ]).stages.harvest;
    assert.equal(s.jobs['harvest:ynet'].status, 'skipped');
  });

  test('a stage whose jobs were ALL stopped ends skipped, not failed', () => {
    // Reporting the editor's own decision back to them as a failure is both wrong and rude.
    const state = projectRun([
      ev(1, 'stage.progress', { stage: 'harvest', shards: 2 }),
      ev(2, 'stage.start', { stage: 'harvest', label: 'harvest:Ynet', job_id: 'harvest:ynet' }),
      ev(3, 'stage.start', { stage: 'harvest', label: 'harvest:Mako', job_id: 'harvest:mako' }),
      ev(4, 'job.killed', { stage: 'harvest', job_id: 'harvest:ynet', by: 'editor' }),
      ev(5, 'job.skipped', { stage: 'harvest', job_id: 'harvest:mako', reason: 'nothing left to harvest' }),
      ev(6, 'stage.error', { stage: 'harvest', label: 'harvest', errors: ['all 2 shards failed'] }),
    ]);
    assert.equal(state.stages.harvest.status, 'skipped');
    assert.deepEqual(state.killedJobs, ['harvest:ynet']);
    assert.equal(state.jobTotals.killed, 1);
    assert.equal(state.jobTotals.skipped, 1);
  });

  test('one killed shard out of two does not turn the stage into a skip', () => {
    const s = projectRun([
      ev(1, 'stage.progress', { stage: 'harvest', shards: 2 }),
      ev(2, 'stage.start', { stage: 'harvest', label: 'harvest:Ynet', job_id: 'harvest:ynet' }),
      ev(3, 'stage.start', { stage: 'harvest', label: 'harvest:Mako', job_id: 'harvest:mako' }),
      ev(4, 'job.killed', { stage: 'harvest', job_id: 'harvest:ynet' }),
      ev(5, 'stage.end', { stage: 'harvest', label: 'harvest:Mako', job_id: 'harvest:mako', ok: true }),
      ev(6, 'stage.end', { stage: 'harvest', label: 'harvest', ok: true, shards: 1 }),
    ]).stages.harvest;
    assert.equal(s.status, 'ok', 'partial coverage is still coverage');
  });
});

describe('holding work', () => {
  test('pausing a stage pauses every job running inside it, and resuming restores them', () => {
    const events = [
      ev(1, 'stage.progress', { stage: 'harvest', shards: 2 }),
      ev(2, 'stage.start', { stage: 'harvest', label: 'harvest:Ynet', job_id: 'harvest:ynet' }),
      ev(3, 'stage.start', { stage: 'harvest', label: 'harvest:Mako', job_id: 'harvest:mako' }),
      ev(4, 'stage.end', { stage: 'harvest', label: 'harvest:Mako', job_id: 'harvest:mako', ok: true }),
      ev(5, 'stage.paused', { stage: 'harvest', by: 'editor' }),
    ];
    const held = projectRun(events);
    assert.equal(held.stages.harvest.paused, true);
    assert.deepEqual(held.pausedStages, ['harvest']);
    assert.equal(held.stages.harvest.jobs['harvest:ynet'].status, 'paused');
    assert.equal(held.stages.harvest.jobs['harvest:mako'].status, 'ok', 'a finished job is not un-finished');
    assert.equal(held.jobTotals.paused, 1);

    const resumed = projectRun([...events, ev(6, 'stage.resumed', { stage: 'harvest' })]);
    assert.equal(resumed.stages.harvest.paused, false);
    assert.equal(resumed.stages.harvest.jobs['harvest:ynet'].status, 'running');
  });

  test('run.paused is a top-level fact, and run.resumed clears it', () => {
    const paused = projectRun([ev(1, 'run.start', { run_id: 'r' }), ev(2, 'run.paused', { by: 'editor' })]);
    assert.equal(paused.paused, true);
    const back = projectRun([
      ev(1, 'run.start', { run_id: 'r' }),
      ev(2, 'run.paused', { by: 'editor' }),
      ev(3, 'run.resumed', { by: 'editor' }),
    ]);
    assert.equal(back.paused, false);
  });

  test('job.paused and job.resumed move a single job without touching its neighbours', () => {
    const s = projectRun([
      ev(1, 'stage.progress', { stage: 'harvest', shards: 2 }),
      ev(2, 'stage.start', { stage: 'harvest', label: 'harvest:Ynet', job_id: 'harvest:ynet' }),
      ev(3, 'stage.start', { stage: 'harvest', label: 'harvest:Mako', job_id: 'harvest:mako' }),
      ev(4, 'job.paused', { stage: 'harvest', job_id: 'harvest:ynet', by: 'editor' }),
    ]).stages.harvest;
    assert.equal(s.jobs['harvest:ynet'].status, 'paused');
    assert.equal(s.jobs['harvest:mako'].status, 'running');
  });

  test('activeStage looks past a held stage to one that is genuinely running', () => {
    const state = projectRun([
      ev(1, 'stage.start', { stage: 'outlets', label: 'outlets' }),
      ev(2, 'stage.paused', { stage: 'outlets', by: 'editor' }),
      ev(3, 'stage.start', { stage: 'harvest', label: 'harvest' }),
    ]);
    assert.equal(activeStage(state), 'harvest');
  });

  test('a held stage is still the answer when nothing else is running', () => {
    const state = projectRun([
      ev(1, 'stage.start', { stage: 'outlets', label: 'outlets' }),
      ev(2, 'stage.paused', { stage: 'outlets', by: 'editor' }),
    ]);
    assert.equal(activeStage(state), 'outlets');
  });
});

describe('job activity is attributed and bounded', () => {
  const act = (seq, extra) => ev(seq, 'agent.activity', { stage: 'harvest', ...extra });

  test('each shard keeps its own feed, and the stage keeps the combined one', () => {
    const state = projectRun([
      ev(1, 'stage.progress', { stage: 'harvest', shards: 2 }),
      act(2, { label: 'harvest:Ynet', job_id: 'harvest:ynet', kind: 'command', item_id: 'a', text: 'curl ynet' }),
      act(3, { label: 'harvest:Mako', job_id: 'harvest:mako', kind: 'search', item_id: 'b', text: 'mako feed' }),
    ]);
    const s = state.stages.harvest;
    assert.equal(s.activity.length, 2, 'the stage feed still sees everything');
    assert.equal(s.jobs['harvest:ynet'].activity.length, 1);
    assert.equal(s.jobs['harvest:ynet'].activity[0].text, 'curl ynet');
    assert.equal(s.jobs['harvest:mako'].activity[0].text, 'mako feed');
    assert.equal(s.jobs['harvest:ynet'].activityCounts.command, 1);
    assert.equal(s.jobs['harvest:mako'].activityCounts.search, 1);
    assert.equal(state.lastActivity.jobId, 'harvest:mako');
  });

  test('an item_id seen twice updates the job feed in place rather than appending', () => {
    const s = projectRun([
      ev(1, 'stage.progress', { stage: 'harvest', shards: 1 }),
      act(2, { job_id: 'harvest:ynet', kind: 'command', status: 'started', item_id: 'i1', text: 'curl ynet' }),
      act(3, {
        job_id: 'harvest:ynet',
        kind: 'command',
        status: 'completed',
        item_id: 'i1',
        text: 'curl ynet',
        exit_code: 0,
      }),
    ]).stages.harvest;
    const job = s.jobs['harvest:ynet'];
    assert.equal(job.activity.length, 1, 'one command happened, so one row');
    assert.equal(job.activity[0].status, 'completed');
    assert.equal(job.activity[0].exitCode, 0);
    assert.equal(job.activityCounts.command, 1, 'and it is counted once');
  });

  test('a job feed is bounded at JOB_ACTIVITY_LIMIT — eighteen shards is a lot of memory', () => {
    const events = [ev(1, 'stage.progress', { stage: 'harvest', shards: 1 })];
    const n = JOB_ACTIVITY_LIMIT + 15;
    for (let i = 0; i < n; i++) {
      events.push(act(i + 2, { job_id: 'harvest:ynet', kind: 'command', item_id: `i${i}`, text: `cmd ${i}` }));
    }
    const job = projectRun(events).stages.harvest.jobs['harvest:ynet'];
    assert.equal(job.activity.length, JOB_ACTIVITY_LIMIT);
    assert.equal(job.activity[job.activity.length - 1].text, `cmd ${n - 1}`, 'the tail is what is kept');
    assert.equal(job.activityCounts.command, n, 'the count is of everything, not just the tail');
  });

  test('a retry clears only the retried job’s feed', () => {
    const s = projectRun([
      ev(1, 'stage.progress', { stage: 'harvest', shards: 2 }),
      act(2, { job_id: 'harvest:ynet', kind: 'command', item_id: 'a', text: 'first try' }),
      act(3, { job_id: 'harvest:mako', kind: 'command', item_id: 'b', text: 'mako work' }),
      ev(4, 'agent.retry', { stage: 'harvest', job_id: 'harvest:ynet', attempt: 1, reason: 'contract_violation' }),
    ]).stages.harvest;
    assert.equal(s.jobs['harvest:ynet'].activity.length, 0);
    assert.equal(s.jobs['harvest:ynet'].retries.length, 1);
    assert.equal(s.jobs['harvest:mako'].activity.length, 1, 'another shard is still working');
  });

  test('token usage lands on the job as well as the stage', () => {
    const s = projectRun([
      ev(1, 'stage.progress', { stage: 'harvest', shards: 1 }),
      ev(2, 'agent.activity', {
        stage: 'harvest',
        job_id: 'harvest:ynet',
        kind: 'usage',
        usage: { input: 100, output: 20, cached: 0, reasoning: 5 },
      }),
    ]).stages.harvest;
    assert.equal(s.tokens.input, 100);
    assert.equal(s.jobs['harvest:ynet'].tokens.input, 100);
    assert.equal(s.jobs['harvest:ynet'].activity.length, 0, 'usage is a total, not a row in the feed');
  });
});

describe('the projection stays pure and total', () => {
  test('the same events twice give the same state', () => {
    const { events } = fannedHarvest();
    assert.deepEqual(projectRun(events), projectRun(events));
  });

  test('job events for an unknown stage do not throw', () => {
    const state = projectRun([
      ev(1, 'job.killed', { stage: 'not-a-stage', job_id: 'x:y' }),
      ev(2, 'stage.paused', { stage: 'nope' }),
      ev(3, 'job.resumed', {}),
    ]);
    assert.equal(state.status, 'idle');
    assert.deepEqual(state.killedJobs, []);
  });
});
