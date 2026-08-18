import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './run-store.js';
import { CHECKPOINT_FILE } from './checkpoint-derive.js';

/**
 * state.json — a cheap answer to a question events.ndjson already answers expensively.
 *
 * events.ndjson holds everything. Every status in this file can be recomputed from it, and
 * when the two disagree THE EVENTS WIN — without exception. So why does this exist?
 *
 * Because of what it costs to ask. The runs list draws thirty runs; the resume picker needs
 * to know which steps of one run are safely redoable. Answering either from events means
 * reading and folding a log that is tens of thousands of lines long, thirty times over, to
 * produce two dozen words. This file is that answer, precomputed: one small read, no fold.
 *
 * That makes it a CACHE, and it is treated like one everywhere. It is written atomically so
 * it is never half a file; it is read defensively so a torn or absent one degrades to
 * "reproject from events" rather than to a crash; and nothing in the recovery path depends
 * on it. Delete every state.json under runs/ and the system loses some speed and no
 * information at all. That property is the point, and anything that would break it — putting
 * state here that no event records — does not belong in this file.
 *
 * `deriveCheckpoint` and `resumePoints` are re-exported from checkpoint-derive.js, which is
 * fs-free so the review app can derive a checkpoint in the browser from the stream it is
 * already holding. Import them from here; that file only exists to keep node:fs out of the
 * bundle.
 */

export * from './checkpoint-derive.js';

/**
 * Write the checkpoint. Atomic, because the runs list reads this file while a run is still
 * writing it, and a half-written state.json read by the list is a crash on the home screen.
 *
 * @param {string} runDir
 * @param {any} checkpoint
 * @returns {string} the file written
 */
export function writeCheckpoint(runDir, checkpoint) {
  return writeJsonAtomic(path.join(runDir, CHECKPOINT_FILE), checkpoint);
}

/**
 * Read the checkpoint, or null.
 *
 * Never throws. A run directory is evidence, not a transaction log: a missing, truncated or
 * hand-edited state.json means the cache is unusable, and the only correct response to an
 * unusable cache is to go and recompute from the events — never to take down the caller.
 *
 * @param {string} runDir
 * @returns {any|null}
 */
export function readCheckpoint(runDir) {
  try {
    const file = path.join(runDir, CHECKPOINT_FILE);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
