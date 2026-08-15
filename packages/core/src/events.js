import fs from 'node:fs';
import path from 'node:path';

/**
 * Append-only NDJSON event log. This file is the backbone of the whole system:
 * the CLI writes it, the server tails it over SSE, and the React app is a pure
 * projection of it. Nothing else is a source of truth for run progress.
 *
 * Every line: {seq, ts, type, ...payload}
 * `seq` is monotonic so an SSE client can resume with Last-Event-ID and miss nothing.
 */
export const EVENT_TYPES = /** @type {const} */ ([
  'run.start',
  'run.end',
  'stage.start',
  'stage.progress',
  'stage.end',
  'stage.error',
  'agent.spawn',
  'agent.output',
  'agent.retry',
  'artifact.write',
  'evidence.write',
  'gate.verdict',
  'human.required',
  'human.decision',
]);

export class EventBus {
  /** @param {string} runDir */
  constructor(runDir) {
    this.file = path.join(runDir, 'events.ndjson');
    fs.mkdirSync(runDir, { recursive: true });
    // Resume seq if the file already exists (crash recovery / --from resume).
    this.seq = 0;
    if (fs.existsSync(this.file)) {
      const lines = fs.readFileSync(this.file, 'utf8').trim().split('\n').filter(Boolean);
      for (const l of lines) {
        try {
          const n = JSON.parse(l).seq;
          if (Number.isInteger(n) && n > this.seq) this.seq = n;
        } catch {
          /* a torn last line is tolerable; seq just restarts from the last good one */
        }
      }
    }
    this.fd = fs.openSync(this.file, 'a');
    /** @type {Array<(e: any) => void>} */
    this.listeners = [];
  }

  /**
   * @param {string} type one of EVENT_TYPES
   * @param {Record<string, any>} [payload]
   */
  emit(type, payload = {}) {
    const event = { seq: ++this.seq, ts: new Date().toISOString(), type, ...payload };
    fs.writeSync(this.fd, JSON.stringify(event) + '\n');
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        /* a bad listener must not take down the run */
      }
    }
    return event;
  }

  /** @param {(e: any) => void} fn */
  onEvent(fn) {
    this.listeners.push(fn);
  }

  close() {
    try {
      fs.closeSync(this.fd);
    } catch {
      /* already closed */
    }
  }
}

/**
 * Append a single event to a run's log without holding an EventBus open.
 * Used by the review server when the editor records a decision, so the live SSE stream
 * reflects human actions the same way it reflects agent actions.
 *
 * Recomputes seq from the file so it cannot collide with a CLI process that is also
 * appending — which in practice only happens while a run is paused at the checkpoint.
 *
 * @param {string} runDir
 * @param {string} type
 * @param {Record<string, any>} [payload]
 */
export function appendEventToRun(runDir, type, payload = {}) {
  const file = path.join(runDir, 'events.ndjson');
  let seq = 0;
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const n = JSON.parse(line).seq;
        if (Number.isInteger(n) && n > seq) seq = n;
      } catch {
        /* torn line */
      }
    }
  }
  const event = { seq: seq + 1, ts: new Date().toISOString(), type, ...payload };
  fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');
  return event;
}

/**
 * Follow an event log: replay everything after `fromSeq`, then stream new lines as they
 * land. Byte-offset based, so it never re-parses the whole file on each poll.
 *
 * @param {string} file
 * @param {number} fromSeq
 * @param {(e:any)=>void} onEvent
 * @param {number} [intervalMs]
 * @returns {() => void} stop
 */
export function tailEvents(file, fromSeq, onEvent, intervalMs = 400) {
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
        const e = JSON.parse(line);
        if (typeof e.seq !== 'number' || e.seq > fromSeq) onEvent(e);
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

/**
 * Read an event log from disk, optionally from a sequence number.
 * Used by the server for Last-Event-ID replay so a graphics-team member joining
 * mid-run sees the whole run from t0.
 *
 * @param {string} file
 * @param {number} [afterSeq]
 */
export function readEvents(file, afterSeq = 0) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.seq > afterSeq) out.push(e);
    } catch {
      /* skip torn line */
    }
  }
  return out;
}
