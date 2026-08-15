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
 * IPC carries exactly three things: the run id (as early as possible, so the browser can
 * start streaming), the final status, and a startup error that never reached the event log.
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

runPipeline({
  ...opts,
  signal,
  onStart: (info) => send({ type: 'started', ...info }),
})
  .then((res) => {
    send({ type: 'done', runId: res.runId, status: res.status, failed: res.failed ?? null });
    process.exit(res.status === 'failed' ? 1 : 0);
  })
  .catch((err) => {
    // Thrown before or outside the event log — a missing fixture, no Codex CLI, a bad
    // resume target. The parent turns this into a readable message in the browser.
    send({ type: 'error', message: err?.message ?? String(err) });
    process.exit(1);
  });
