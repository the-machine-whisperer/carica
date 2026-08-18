/**
 * Minimal concurrency limiter. Independent shards fan out in parallel; the cap
 * exists to stay inside API rate limits, not to serialise the work.
 *
 * It has since grown a second job: it is the place a run's editorial control lands on work
 * that has NOT STARTED YET. Three things are worth understanding before changing it.
 *
 * **1. What a pause here does, and what it deliberately does not do.** Holding this loop
 * stops new tasks being *dispatched*. It does not touch a task that is already running —
 * suspending a live agent means SIGSTOP on its pid, and the only thing that knows a job's
 * pid is the job registry (packages/codex/src/jobs.js), which does exactly that. So a pause
 * is honoured in two independent places at once: the registry freezes the agents that are
 * running, this loop declines to start any more. Neither is a substitute for the other, and
 * a future reader who tries to make this loop "properly" pause in-flight work will find
 * themselves reimplementing the registry badly. Keep the division.
 *
 * **2. Why the hold is polled rather than woken.** The authority on "is this paused" is a
 * predicate owned by the caller — `jobs.isPaused(stageId)` — which folds a run-wide hold, a
 * stage-wide hold and an individual job's hold, any of which can be set from an HTTP handler
 * between two of this loop's ticks. An event we subscribe to could be published before we
 * subscribe, or after we stop listening, and the classic failure of that design is a missed
 * wake-up: a run resumed by the editor that never actually resumes. A poll of a boolean
 * cannot go out of sync with the thing it polls and cannot miss an edge, which is worth
 * more here than the handful of timers it costs. It costs nothing at all while running: the
 * timer only exists while the loop is actually held.
 *
 * **3. A hold must not outlive the run.** `signal.aborted` breaks the wait as well as the
 * dispatch. The server stops a run with SIGTERM, the worker turns that into `aborted`, and a
 * loop that only watched `isPaused` would sit there being polite while the process it lives
 * in was being killed.
 *
 * The two-argument call — `parallelLimit(max, tasks)` — behaves exactly as it always has.
 *
 * @typedef {{
 *   isPaused?: () => boolean,
 *   isCancelled?: (i: number) => boolean,
 *   onSkip?: (i: number) => any,
 *   signal?: {aborted: boolean},
 *   pollMs?: number
 * }} LimitOptions
 */

/** How often a held loop asks whether it may go again. See note 2 above. */
export const PAUSE_POLL_MS = 120;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {number} max
 * @param {Array<() => Promise<any>>} tasks
 * @param {LimitOptions} [opts]
 * @returns {Promise<any[]>} results in input order; a rejected task resolves to an error
 *   result, a cancelled one to whatever `onSkip` returned (or null), an undispatched one
 *   to null
 */
export async function parallelLimit(max, tasks, opts = {}) {
  const { isPaused = null, isCancelled = null, onSkip = null, signal = null, pollMs = PAUSE_POLL_MS } = opts;

  const results = new Array(tasks.length).fill(null);
  let next = 0;

  const aborted = () => !!signal?.aborted;

  const held = () => {
    if (!isPaused) return false;
    try {
      return !!isPaused();
    } catch {
      // A predicate that throws must not wedge the run. "Not paused" is the answer that
      // keeps work moving, and a broken predicate is a bug in the caller, not a hold.
      return false;
    }
  };

  async function worker() {
    for (;;) {
      // Held BEFORE the index is claimed, so a paused loop does not consume the queue and
      // the order tasks are picked up in is unchanged by a pause. `next++` is a synchronous
      // read-and-increment on a single-threaded runtime, so two workers can never claim the
      // same index however long either of them waited.
      while (held() && !aborted()) await sleep(pollMs);
      if (aborted()) return;

      const i = next++;
      if (i >= tasks.length) return;

      // Cancelled — killed by the editor, most likely while it sat in this very queue.
      // It is recorded and stepped over. Nothing is invoked, which is the entire point:
      // starting an agent somebody has already stopped burns tokens on work nobody wants.
      if (isCancelled?.(i)) {
        let noted;
        try {
          noted = onSkip?.(i);
        } catch {
          /* recording a skip must never be the thing that takes the loop down */
        }
        results[i] = noted === undefined ? null : noted;
        continue;
      }

      try {
        results[i] = await tasks[i]();
      } catch (err) {
        results[i] = { ok: false, errors: [err?.message ?? String(err)] };
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(max, tasks.length)) }, worker);
  await Promise.all(workers);
  return results;
}
