import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractCodexError, meaningfulStderr, describeProcessFailure, summariseAgentEvent } from '../src/stage-runner.js';
import { buildCodexArgs } from '../src/exec.js';

/**
 * These exist because of a real run that failed three times and reported nothing useful.
 *
 * `codex exec --json` puts its event stream — including the failure — on STDOUT. The stage
 * runner reported only stderr, whose sole line was Codex's benign "reading stdin" notice.
 * The operator therefore saw `codex exited 1` under a heading claiming the output had failed
 * its evidence checks, when in fact no output had ever been produced and the real cause was
 * a 400 from the API naming an unusable model.
 */

const MODEL_400 =
  '{"type":"error","status":400,"error":{"type":"invalid_request_error",' +
  '"message":"The \'gpt-5-codex\' model is not supported when using Codex with a ChatGPT account."}}';

const STAGE = { id: 'outlets', slug: '01_outlets', artifact: '01_outlets.json' };

describe('reading a codex failure out of the --json stream', () => {
  test('finds the message in a turn.failed event on stdout', () => {
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 't_1' }),
      JSON.stringify({ type: 'turn.failed', error: { message: MODEL_400 } }),
    ].join('\n');
    assert.deepEqual(extractCodexError(stdout), [
      "400 — The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.",
    ]);
  });

  test('finds the message in a bare error event', () => {
    const stdout = JSON.stringify({ type: 'error', message: 'stream disconnected before completion' });
    assert.deepEqual(extractCodexError(stdout), ['stream disconnected before completion']);
  });

  test('the same failure repeated across attempts is reported once', () => {
    const stdout = [
      JSON.stringify({ type: 'error', message: MODEL_400 }),
      JSON.stringify({ type: 'turn.failed', error: { message: MODEL_400 } }),
    ].join('\n');
    assert.equal(extractCodexError(stdout).length, 1);
  });

  test('survives interleaved non-JSON output', () => {
    const stdout = ['warming up', '', JSON.stringify({ type: 'error', message: 'boom' }), 'trailing'].join('\n');
    assert.deepEqual(extractCodexError(stdout), ['boom']);
  });

  test('a clean stream yields nothing', () => {
    const stdout = JSON.stringify({ type: 'turn.completed', usage: {} });
    assert.deepEqual(extractCodexError(stdout), []);
  });
});

describe('stderr is not evidence of a cause on its own', () => {
  test("Codex's stdin notice is not reported as the failure", () => {
    assert.equal(meaningfulStderr('Reading additional input from stdin... \n'), null);
    assert.equal(meaningfulStderr('Reading prompt from stdin...'), null);
  });

  test('a real stderr line still comes through', () => {
    assert.equal(
      meaningfulStderr('Reading additional input from stdin...\nerror: unexpected argument --json'),
      'error: unexpected argument --json'
    );
  });
});

describe('what the operator is told when the runtime fails', () => {
  test('names the cause, not just the exit code', () => {
    const errors = describeProcessFailure(
      { code: 1, timedOut: false, stderr: 'Reading additional input from stdin...', stdout: JSON.stringify({ type: 'turn.failed', error: { message: MODEL_400 } }) },
      STAGE
    );
    assert.match(errors[0], /exited 1 without writing 01_outlets\.json/);
    assert.ok(
      errors.some((e) => e.includes('not supported when using Codex with a ChatGPT account')),
      `the cause must survive into the report, got: ${JSON.stringify(errors)}`
    );
    assert.ok(errors.some((e) => e.includes('01_outlets.transcript.jsonl')));
  });

  test('a timeout says so', () => {
    const errors = describeProcessFailure(
      { code: null, timedOut: true, stderr: '', stdout: '' },
      { ...STAGE, timeoutMs: 60_000 }
    );
    assert.match(errors[0], /still running after 60s/);
  });

  test('silence is reported as silence, not as a passing check', () => {
    const errors = describeProcessFailure({ code: 127, timedOut: false, stderr: '', stdout: '' }, STAGE);
    assert.ok(errors.some((e) => e.includes('printed nothing at all')));
  });
});

describe('the model is the sign-in’s choice unless overridden', () => {
  test('no model configured means no --model flag', () => {
    const args = buildCodexArgs({ prompt: 'p', cwd: '/tmp/r', model: null, network: true });
    assert.ok(!args.includes('--model'), 'a pinned default would override what the account can use');
  });

  test('an explicit model is still honoured', () => {
    const args = buildCodexArgs({ prompt: 'p', cwd: '/tmp/r', model: 'gpt-5.1', network: true });
    assert.equal(args[args.indexOf('--model') + 1], 'gpt-5.1');
  });
});

describe('turning the codex event stream into watchable activity', () => {
  const item = (type, itemType, extra = {}) => ({ type, item: { id: 'item_1', type: itemType, ...extra } });

  test('a command in flight, then its exit code', () => {
    const started = summariseAgentEvent(
      item('item.started', 'command_execution', { command: '/bin/bash -lc "curl -s https://ynet.co.il/robots.txt"', exit_code: null })
    );
    assert.equal(started.kind, 'command');
    assert.equal(started.status, 'started');
    assert.equal(started.text, 'curl -s https://ynet.co.il/robots.txt', 'the bash -lc wrapper is noise');

    const done = summariseAgentEvent(
      item('item.completed', 'command_execution', { command: 'ls', exit_code: 0, aggregated_output: 'a\nb\n' })
    );
    assert.equal(done.status, 'completed');
    assert.equal(done.exit_code, 0);
    assert.equal(done.output, 'a b');
  });

  test('a non-zero exit is surfaced as a failure, not a completion', () => {
    const a = summariseAgentEvent(item('item.completed', 'command_execution', { command: 'python3 x.py', exit_code: 1 }));
    assert.equal(a.status, 'failed');
    assert.equal(a.exit_code, 1);
  });

  test('the same item id is carried through so a feed can update in place', () => {
    const a = summariseAgentEvent(item('item.started', 'command_execution', { command: 'ls' }));
    const b = summariseAgentEvent(item('item.completed', 'command_execution', { command: 'ls', exit_code: 0 }));
    assert.equal(a.item_id, b.item_id);
  });

  test('a search reports its queries, and the empty opening event is skipped', () => {
    assert.equal(summariseAgentEvent(item('item.started', 'web_search', { query: '', action: { type: 'other' } })), null);
    const a = summariseAgentEvent(
      item('item.completed', 'web_search', { query: 'x', action: { type: 'search', queries: ['ynet traffic', 'mako traffic'] } })
    );
    assert.equal(a.kind, 'search');
    assert.deepEqual(a.queries, ['ynet traffic', 'mako traffic']);
  });

  test('a file change reports names, not absolute paths', () => {
    const a = summariseAgentEvent(
      item('item.completed', 'file_change', { changes: [{ path: '/long/way/from/here/gather_s1.py', kind: 'add' }] })
    );
    assert.deepEqual(a.files, ['gather_s1.py']);
  });

  test('token usage comes through on turn.completed', () => {
    const a = summariseAgentEvent({ type: 'turn.completed', usage: { input_tokens: 519548, output_tokens: 8606 } });
    assert.equal(a.kind, 'usage');
    assert.equal(a.usage.input, 519548);
  });

  test('lifecycle chatter is not activity', () => {
    assert.equal(summariseAgentEvent({ type: 'thread.started', thread_id: 'x' }), null);
    assert.equal(summariseAgentEvent({ type: 'turn.started' }), null);
    assert.equal(summariseAgentEvent(null), null);
  });

  test('long output is truncated — events.ndjson is a record, not a firehose', () => {
    const a = summariseAgentEvent(
      item('item.completed', 'command_execution', { command: 'x'.repeat(5000), exit_code: 0, aggregated_output: 'y'.repeat(9000) })
    );
    assert.ok(a.text.length <= 201, `command was ${a.text.length} chars`);
    assert.ok(a.output.length <= 401, `output was ${a.output.length} chars`);
  });
});
