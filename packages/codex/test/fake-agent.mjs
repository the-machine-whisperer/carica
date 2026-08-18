#!/usr/bin/env node
/**
 * A stand-in for `codex exec`.
 *
 * There is no `codex` binary on the machine this project is developed on, and job control is
 * about what happens to a REAL operating-system process — a pid you can SIGSTOP, a child you
 * can SIGTERM. Mocking the spawn away would test the mock. So the tests point
 * `CARICA_CODEX_BIN` at this script and get a genuine child process that behaves the way an
 * agent does: it prints a couple of `--json` event lines, works for a while, then exits.
 *
 * "Works for a while" is observable on purpose: with `CARICA_FAKE_HEARTBEAT` set it appends a
 * byte to that file on every tick, so a test can tell a suspended process from a running one
 * by looking at the file's size instead of by trusting a sleep.
 *
 * Environment (deliberately named CARICA_FAKE_*, which is nothing a credential filter would
 * strip on the way into the child):
 *   CARICA_FAKE_HEARTBEAT    file to append a byte to on every tick
 *   CARICA_FAKE_TICK_MS      heartbeat interval (default 100)
 *   CARICA_FAKE_LIFETIME_MS  how long to run before exiting (default 1000)
 *   CARICA_FAKE_EXIT         exit code (default 0)
 */
import fs from 'node:fs';

const heartbeat = process.env.CARICA_FAKE_HEARTBEAT;
const tickMs = Number(process.env.CARICA_FAKE_TICK_MS ?? 100);
const lifetimeMs = Number(process.env.CARICA_FAKE_LIFETIME_MS ?? 1000);
const exitCode = Number(process.env.CARICA_FAKE_EXIT ?? 0);

process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 't_fake' }) + '\n');
process.stdout.write(
  JSON.stringify({
    type: 'item.completed',
    item: { id: 'i1', type: 'command_execution', command: '/bin/bash -lc "echo working"', exit_code: 0, aggregated_output: 'working' },
  }) + '\n'
);

if (heartbeat) {
  setInterval(() => {
    try {
      fs.appendFileSync(heartbeat, 'x');
    } catch {
      /* the test owns that file; a race with cleanup is not this script's problem */
    }
  }, tickMs);
}

setTimeout(() => process.exit(exitCode), lifetimeMs);
