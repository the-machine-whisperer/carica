/**
 * Minimal concurrency limiter. Independent shards fan out in parallel; the cap
 * exists to stay inside API rate limits, not to serialise the work.
 *
 * @param {number} max
 * @param {Array<() => Promise<any>>} tasks
 * @returns {Promise<any[]>} results in input order; a rejected task resolves to null
 */
export async function parallelLimit(max, tasks) {
  const results = new Array(tasks.length).fill(null);
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
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
