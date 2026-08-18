import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateControlRecord } from './control-state.js';

/**
 * control.ndjson — the channel that runs the other way.
 *
 * events.ndjson is what the run says about itself. This file is what the editor says to the
 * run: pause, resume, kill, skip. It is a separate log for one reason — the event log is
 * evidence and has to stay a faithful record of what HAPPENED, while a control record is an
 * INTENTION that may never be honoured, because the job it names may have finished a second
 * before it was written. Mixing the two would make the run's own history unreadable, and the
 * history is the product.
 *
 * Same discipline as events.ndjson, and deliberately so: append-only NDJSON, monotonic `seq`,
 * torn last lines tolerated rather than fatal, byte-offset tailing so a worker polling three
 * times a second never re-parses the whole file.
 *
 * Every line: {seq, ts, request_id, action, target, by}
 *
 * `request_id` is what makes this safe to consume. A worker sees a control record over IPC,
 * again when it tails the file it was written to, and a third time when it replays the file
 * on resume — three deliveries of one intention. Applying "kill harvest:ynet" three times
 * must be indistinguishable from applying it once, so every consumer keys off request_id
 * rather than off arrival. See controlState() in control-state.js, which does exactly that.
 */

export * from './control-state.js';

function controlFile(runDir) {
  return path.join(runDir, 'control.ndjson');
}

/**
 * Append one control record.
 *
 * `seq` is recomputed by re-reading the file, exactly as appendEventToRun does and for the
 * same reason: the server and the worker are different processes and neither owns the file.
 * Control traffic is a handful of records per run — a click, not a stream — so the re-read
 * costs nothing, and the alternative (a cached counter) is wrong the first time two
 * processes write.
 *
 * Throws on a malformed record rather than writing it. The file is append-only, so a bad
 * line cannot be taken back once it is in.
 *
 * @param {string} runDir
 * @param {{action: string, target: import('./control-state.js').ControlTarget, by?: string|null, request_id?: string}} input
 * @returns {import('./control-state.js').ControlRecord}
 */
export function appendControl(runDir, input) {
  const check = validateControlRecord(input);
  if (!check.ok) throw new Error(`invalid control record: ${check.errors.join('; ')}`);

  const file = controlFile(runDir);
  fs.mkdirSync(runDir, { recursive: true });

  let seq = 0;
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const n = JSON.parse(line).seq;
        if (Number.isInteger(n) && n > seq) seq = n;
      } catch {
        /* torn line; seq just continues from the last good one */
      }
    }
  }

  const record = {
    seq: seq + 1,
    ts: new Date().toISOString(),
    // Generated here when the caller has none, so no record is ever without one. A record
    // with no request_id cannot be deduplicated, and a kill that applies twice is a kill
    // that can land on whichever job took the dead one's place.
    request_id:
      typeof input.request_id === 'string' && input.request_id.trim() ? input.request_id : randomUUID(),
    action: input.action,
    target: input.target,
    by: input.by ?? null,
  };
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
  return record;
}

/**
 * Read a run's control log, optionally from a sequence number.
 *
 * @param {string} runDir
 * @param {number} [afterSeq]
 * @returns {import('./control-state.js').ControlRecord[]}
 */
export function readControl(runDir, afterSeq = 0) {
  const file = controlFile(runDir);
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (typeof r.seq !== 'number' || r.seq > afterSeq) out.push(r);
    } catch {
      /* skip torn line */
    }
  }
  return out;
}

/**
 * Follow a run's control log: replay everything after `fromSeq`, then stream new records as
 * they land.
 *
 * Byte-offset based like tailEvents, and polled faster (300ms against 400ms) because this is
 * the latency an editor feels directly — the gap between pressing Pause and the agent
 * actually stopping. Event lag only delays a screen redraw; control lag lets work happen
 * that somebody has already said they do not want.
 *
 * @param {string} runDir
 * @param {number} fromSeq
 * @param {(r: import('./control-state.js').ControlRecord) => void} onRecord
 * @param {number} [intervalMs]
 * @returns {() => void} stop
 */
export function tailControl(runDir, fromSeq, onRecord, intervalMs = 300) {
  const file = controlFile(runDir);
  let offset = 0;
  let carry = '';
  let stopped = false;

  const drain = () => {
    if (stopped || !fs.existsSync(file)) return;
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (size < offset) {
      // File was replaced (a fresh run reused the path) — start over.
      offset = 0;
      carry = '';
    }
    if (size === offset) return;

    const fd = fs.openSync(file, 'r');
    try {
      const len = size - offset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      offset = size;
      carry += buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }

    const lines = carry.split('\n');
    carry = lines.pop() ?? ''; // keep the partial trailing line for the next drain
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (typeof r.seq !== 'number' || r.seq > fromSeq) onRecord(r);
      } catch {
        /* skip torn line */
      }
    }
  };

  drain();
  const timer = setInterval(drain, intervalMs);
  if (timer.unref) timer.unref();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** The path this run's control log lives at, for a caller that needs to watch it directly. */
export function controlPath(runDir) {
  return controlFile(runDir);
}
