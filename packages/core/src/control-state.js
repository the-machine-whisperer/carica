/**
 * The half of the control channel that is pure arithmetic over records.
 *
 * Split out from control.js for the same reason checkpoint-derive.js is split out from
 * checkpoint.js, and browser.js from index.js: validating a record and folding a log are
 * things the review app does — it draws the pause button and has to know whether the run is
 * already held — while reading and appending control.ndjson is something only a machine with
 * the run directory can do. One file for both would drag node:fs into the browser bundle.
 *
 * Import control.js, not this. This file exists to be importable WITHOUT the disk half.
 */

/** The verbs an editor has. Anything else is a bug in the caller, not a new feature. */
export const CONTROL_ACTIONS = /** @type {const} */ (['pause', 'resume', 'kill', 'skip']);

/** What a verb can be aimed at: the whole run, one stage, or one job inside a stage. */
export const CONTROL_TARGET_KINDS = /** @type {const} */ (['run', 'stage', 'job']);

/** @typedef {{kind: 'run'} | {kind: 'stage', stage: string} | {kind: 'job', stage: string, job_id: string}} ControlTarget */
/** @typedef {{seq: number, ts: string, request_id: string, action: string, target: ControlTarget, by: string|null}} ControlRecord */

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * Is this record well formed enough to be worth writing down?
 *
 * The server calls this BEFORE appending, and that ordering is the whole point: a malformed
 * control record that reaches the file reaches every worker that tails it and every resume
 * that replays it, for as long as the run directory exists. Rejecting it at the door costs
 * one function call; rejecting it afterwards is impossible, because the file is append-only.
 *
 * @param {any} rec
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateControlRecord(rec) {
  const errors = [];
  if (!rec || typeof rec !== 'object') {
    return { ok: false, errors: ['control record must be an object'] };
  }

  if (!CONTROL_ACTIONS.includes(rec.action)) {
    errors.push(
      `unknown action: ${JSON.stringify(rec.action)} (expected one of ${CONTROL_ACTIONS.join(', ')})`
    );
  }

  const target = rec.target;
  if (!target || typeof target !== 'object') {
    errors.push('target is required, e.g. {kind: "run"}');
  } else if (!CONTROL_TARGET_KINDS.includes(target.kind)) {
    errors.push(
      `unknown target kind: ${JSON.stringify(target.kind)} (expected one of ${CONTROL_TARGET_KINDS.join(', ')})`
    );
  } else {
    if ((target.kind === 'stage' || target.kind === 'job') && !nonEmpty(target.stage)) {
      errors.push(`a ${target.kind} target needs a stage id`);
    }
    // A job target with no job_id is the dangerous one. It reads as a valid instruction and
    // silently means "some job, somewhere in this stage" — and there is no such job, so it
    // would either do nothing or, worse, be resolved by guesswork to the wrong shard.
    if (target.kind === 'job' && !nonEmpty(target.job_id)) {
      errors.push('a job target needs a job_id (e.g. "harvest:ynet")');
    }
  }

  if (rec.by != null && typeof rec.by !== 'string') errors.push('by must be a string or null');
  if (rec.request_id != null && !nonEmpty(rec.request_id)) {
    errors.push('request_id must be a non-empty string');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * @typedef {{
 *   paused: boolean,
 *   pausedStages: string[],
 *   killedJobs: string[],
 *   skippedJobs: string[],
 *   killedStages: string[],
 *   skippedStages: string[],
 *   runKilled: boolean,
 *   applied: string[]
 * }} ControlState
 */

/**
 * Fold a control log into the standing intentions it expresses. PURE.
 *
 * This is what a resuming run replays before it does anything else. Without it, resume would
 * cheerfully re-run the shard the editor killed twenty minutes ago: that job wrote no
 * artifact, so every other signal on disk says "this one still needs doing". Only the control
 * log knows a person decided otherwise, and a decision that does not survive a restart is not
 * a decision.
 *
 * Later records win, and `resume` clears the matching `pause` rather than stacking against
 * it — an editor who pauses twice and resumes once expects to be running. Kills and skips do
 * not un-apply, because there is nothing to un-apply to: the work is already gone.
 *
 * Beyond the job-level lists, stage- and run-level kills are folded too. They are in the
 * target vocabulary, so they can be written; dropping them here would mean a stage killed
 * before its shards were ever enumerated came back to life on the next resume.
 *
 * @param {ControlRecord[]} records
 * @returns {ControlState}
 */
export function controlState(records = []) {
  const pausedStages = new Set();
  const killedJobs = new Set();
  const skippedJobs = new Set();
  const killedStages = new Set();
  const skippedStages = new Set();
  const seen = new Set();
  const applied = [];
  let paused = false;
  let runKilled = false;

  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;
    if (!validateControlRecord(rec).ok) continue;
    // Idempotency lives here rather than in each caller: the same record arriving over IPC
    // and again from the file it was written to is the normal case, not an edge case.
    const id = rec.request_id;
    if (id != null && seen.has(id)) continue;
    if (id != null) seen.add(id);
    applied.push(id ?? null);

    const t = rec.target;

    switch (rec.action) {
      case 'pause':
        if (t.kind === 'run') paused = true;
        else if (t.kind === 'stage') pausedStages.add(t.stage);
        // A paused JOB is a transient state of a live agent, not a standing intention that
        // outlives the process: after a restart there is no paused agent to un-pause, only a
        // job that did or did not finish. So job pauses are events, not fold state.
        break;

      case 'resume':
        if (t.kind === 'run') paused = false;
        else if (t.kind === 'stage') pausedStages.delete(t.stage);
        break;

      case 'kill':
        if (t.kind === 'job') killedJobs.add(t.job_id);
        else if (t.kind === 'stage') killedStages.add(t.stage);
        else runKilled = true;
        break;

      case 'skip':
        if (t.kind === 'job') skippedJobs.add(t.job_id);
        else if (t.kind === 'stage') skippedStages.add(t.stage);
        break;

      default:
        break;
    }
  }

  return {
    paused,
    pausedStages: [...pausedStages],
    killedJobs: [...killedJobs],
    skippedJobs: [...skippedJobs],
    killedStages: [...killedStages],
    skippedStages: [...skippedStages],
    runKilled,
    applied,
  };
}
