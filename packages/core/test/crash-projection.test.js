import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { projectRun } from '../src/index.js';

/**
 * A crash INSIDE the app is a different kind of failure from a rejected artifact, and the
 * projection is where that difference has to survive — the screen decides which explanation
 * to print from what it reads here.
 *
 * Get it wrong and the app tells an editor their output "has to satisfy a fixed shape and
 * cite its sources" about a step that threw before it wrote a byte, then invites them to
 * retry it forever. That is what a real Concepts failure looked like.
 */

const ev = (seq, type, extra = {}) => ({
  seq,
  ts: `2026-08-16T20:42:0${seq}Z`,
  type,
  ...extra,
});

const STACK = [
  "TypeError: Cannot read properties of undefined (reading 'length')",
  '    at runFannedStage (/app/packages/pipeline/src/pipeline.js:491:34)',
].join('\n');

describe('a stage that crashed says so', () => {
  test('the crash flag and its stack reach the stage', () => {
    const state = projectRun([
      ev(1, 'run.start', { run_id: 'r' }),
      ev(2, 'stage.start', { stage: 'ideate', label: 'ideate', job_id: 'ideate' }),
      ev(3, 'stage.error', {
        stage: 'ideate',
        label: 'ideate',
        errors: ['Ideate could not run: …', "TypeError: Cannot read properties of undefined (reading 'length')"],
        crash: true,
        stack: STACK,
      }),
      ev(4, 'run.end', { run_id: 'r', status: 'failed', failed_stage: 'ideate' }),
    ]);

    const ideate = state.stages.ideate;
    assert.equal(ideate.status, 'failed');
    assert.equal(ideate.crashed, true);
    assert.equal(ideate.crashStack, STACK);
    assert.equal(state.failedStage, 'ideate');
    // The errors still read as errors — the flag adds a distinction, it does not replace one.
    assert.equal(ideate.errors.length, 2);
  });

  test('an ordinary contract failure is NOT marked as a crash', () => {
    const state = projectRun([
      ev(1, 'run.start', { run_id: 'r' }),
      ev(2, 'stage.start', { stage: 'harvest', label: 'harvest', job_id: 'harvest' }),
      ev(3, 'agent.retry', { stage: 'harvest', attempt: 1, reason: 'contract_violation', errors: ['schema: …'] }),
      ev(4, 'stage.error', { stage: 'harvest', label: 'harvest', errors: ['schema: /agent/model must be string'] }),
    ]);

    assert.equal(state.stages.harvest.status, 'failed');
    assert.equal(state.stages.harvest.crashed, false);
    assert.equal(state.stages.harvest.crashStack, null);
  });

  test('a stage nobody has touched starts clean', () => {
    const state = projectRun([ev(1, 'run.start', { run_id: 'r' })]);
    for (const s of Object.values(state.stages)) {
      assert.equal(s.crashed, false);
      assert.equal(s.crashStack, null);
    }
  });

  test('a crash event without a stack is still a crash', () => {
    const state = projectRun([
      ev(1, 'run.start', { run_id: 'r' }),
      ev(2, 'stage.start', { stage: 'ideate', label: 'ideate', job_id: 'ideate' }),
      ev(3, 'stage.error', { stage: 'ideate', label: 'ideate', errors: ['boom'], crash: true }),
    ]);
    assert.equal(state.stages.ideate.crashed, true);
    assert.equal(state.stages.ideate.crashStack, null);
  });
});

/**
 * `run.end` carries a reason, and the screen needs it — most of all in the case where the
 * run ended without naming a step, when it is the only thing anybody wrote down.
 */
describe('how the run ended survives into the state', () => {
  test('a run that died without naming a step still carries its reason', () => {
    const state = projectRun([
      ev(1, 'run.start', { run_id: 'r' }),
      ev(2, 'run.end', {
        run_id: 'r',
        status: 'failed',
        failed_stage: null,
        reason: 'the run process exited unexpectedly (code 1)',
      }),
    ]);

    assert.equal(state.status, 'failed');
    assert.equal(state.failedStage, null);
    assert.equal(state.endReason, 'the run process exited unexpectedly (code 1)');
  });

  test('a run that ended normally has no reason to give', () => {
    const state = projectRun([
      ev(1, 'run.start', { run_id: 'r' }),
      ev(2, 'run.end', { run_id: 'r', status: 'complete', failed_stage: null }),
    ]);
    assert.equal(state.endReason, null);
  });

  test('a cancelled run keeps the words the editor will recognise', () => {
    const state = projectRun([
      ev(1, 'run.start', { run_id: 'r' }),
      ev(2, 'run.end', { run_id: 'r', status: 'cancelled', failed_stage: null, reason: 'stopped by the editor' }),
    ]);
    assert.equal(state.status, 'cancelled');
    assert.equal(state.endReason, 'stopped by the editor');
  });

  test('a run still going has not ended and says nothing about why', () => {
    const state = projectRun([ev(1, 'run.start', { run_id: 'r' })]);
    assert.equal(state.endReason, null);
  });
});
