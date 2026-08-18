/**
 * A pipeline run, executed as a child process of the review server.
 *
 * The server does not run the pipeline in-process, for three reasons:
 *   1. A stage that throws, hangs or leaks must not take the review app down with it —
 *      the app is how the editor sees what went wrong.
 *   2. "Stop this run" has to be a real kill, not a cooperative promise.
 *   3. The run directory is the only channel that matters anyway. The parent learns about
 *      progress the same way the browser does: by tailing events.ndjson.
 *
 * IPC carries four things OUT — the run id (as early as possible, so the browser can start
 * streaming), a note that a stop was heard, the final status, and a startup error that never
 * reached the event log — and exactly one thing IN: `{type: 'control', record}`, an
 * instruction the editor gave about this run.
 *
 * That inbound message is a SHORTCUT, not a channel anything depends on. The server writes
 * every control record to `control.ndjson` BEFORE it sends the IPC copy, and the pipeline
 * tails that file for itself, so a message that is lost, late, or sent a millisecond after
 * this process exited costs latency and nothing else: the instruction is already durable,
 * and the tail — or, if the run has ended, the next run's replay of the log — picks it up.
 * Applying the same record twice is a no-op, keyed on `request_id`, which is what makes it
 * safe for one instruction to arrive by both routes every single time.
 */
import { runPipeline } from './pipeline.js';

const send = (msg) => {
  try {
    process.send?.(msg);
  } catch {
    /* parent went away; the run directory still has everything */
  }
};

const opts = JSON.parse(process.argv[2] ?? '{}');

// Cooperative stop: SIGTERM sets the flag, the pipeline finishes the stage it is in and
// closes the run out as `cancelled`. A second SIGTERM (or the parent's kill timer) is fatal.
const signal = { aborted: false };
let hardExit = false;
process.on('SIGTERM', () => {
  if (hardExit) process.exit(143);
  hardExit = true;
  signal.aborted = true;
  send({ type: 'stopping' });
});
process.on('SIGINT', () => {
  signal.aborted = true;
});

/**
 * Control records that arrived before there was a run to apply them to.
 *
 * The window is small — the server only sends control for a run it has already been told
 * about, and the applier exists moments after that — but it is real, and an instruction
 * dropped on the floor here would only be honoured on the next poll of the control file,
 * seconds later. Queueing costs one array.
 */
let applyControl = null;
const waiting = [];

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object' || msg.type !== 'control' || !msg.record) return;
  if (!applyControl) {
    waiting.push(msg.record);
    return;
  }
  try {
    applyControl(msg.record);
  } catch {
    /* a bad record must not kill the run it was aimed at; the log has already refused it */
  }
});

runPipeline({
  ...opts,
  signal,
  onStart: (info) => send({ type: 'started', ...info }),
  onControlReady: (apply) => {
    applyControl = apply;
    for (const record of waiting.splice(0)) {
      try {
        apply(record);
      } catch {
        /* see above */
      }
    }
  },
})
  .then((res) => {
    send({ type: 'done', runId: res.runId, status: res.status, failed: res.failed ?? null });
    process.exit(res.status === 'failed' ? 1 : 0);
  })
  .catch((err) => {
    // Thrown before or outside the event log — a missing fixture, no Codex CLI, a bad
    // resume target. The parent turns this into a readable message in the browser.
    send({ type: 'error', message: err?.message ?? String(err) });
    // …and the stack goes to stderr, which the parent tails into the run manifest. The IPC
    // message carries one sentence, deliberately, because it is what the browser shows. When
    // the sentence is `Cannot read properties of undefined (reading 'length')` that sentence
    // is not enough to fix anything, and this used to be the moment the only copy of the
    // stack was discarded: nothing printed it, so `stderr_tail` was recorded as null.
    console.error(err?.stack ?? String(err));
    process.exit(1);
  });
