import fs from 'node:fs';
import path from 'node:path';
import { RUNS_DIR } from './paths.js';
import { makeRunId } from './ids.js';

/**
 * A run directory is immutable evidence. Artifacts are written once, atomically,
 * and never edited in place — a re-run of a stage overwrites the whole file so the
 * artifact always corresponds to exactly one agent invocation.
 */

/**
 * @param {{slug?: string, now?: Date, runsDir?: string, config?: object, charterShas?: object, models?: object}} opts
 */
export function createRun(opts = {}) {
  const now = opts.now ?? new Date();
  const runsDir = opts.runsDir ?? RUNS_DIR;
  const runId = makeRunId(now, opts.slug);
  const dir = path.join(runsDir, runId);
  fs.mkdirSync(dir, { recursive: true });

  const manifest = {
    run_id: runId,
    created_at: now.toISOString(),
    slug: opts.slug ?? null,
    // Frozen at t0 so the run is reproducible and auditable after the fact.
    config: opts.config ?? {},
    charter_shas: opts.charterShas ?? {},
    models: opts.models ?? {},
    node_version: process.version,
    status: 'running',
  };
  writeJsonAtomic(path.join(dir, 'run.json'), manifest);
  return { runId, dir, manifest };
}

/** Atomic write: temp file then rename, so a crash never leaves a half-written artifact. */
export function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function artifactPath(runDir, filename) {
  return path.join(runDir, filename);
}

export function hasArtifact(runDir, filename) {
  return fs.existsSync(path.join(runDir, filename));
}

/** Append one evidence record (NDJSON). */
export function appendEvidence(runDir, stageSlug, record) {
  const file = path.join(runDir, `${stageSlug}.evidence.jsonl`);
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
  return file;
}

export function evidencePath(runDir, stageSlug) {
  return path.join(runDir, `${stageSlug}.evidence.jsonl`);
}

/** Most recent run directory by name (run ids sort lexicographically by time). */
export function latestRun(runsDir = RUNS_DIR) {
  if (!fs.existsSync(runsDir)) return null;
  const dirs = fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();
  if (!dirs.length) return null;
  const runId = dirs[dirs.length - 1];
  return { runId, dir: path.join(runsDir, runId) };
}

export function listRuns(runsDir = RUNS_DIR) {
  if (!fs.existsSync(runsDir)) return [];
  return fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => {
      const dir = path.join(runsDir, d.name);
      let manifest = null;
      try {
        manifest = readJson(path.join(dir, 'run.json'));
      } catch {
        /* a run dir without a manifest is still listable */
      }
      return { runId: d.name, dir, manifest };
    })
    .sort((a, b) => (a.runId < b.runId ? 1 : -1));
}

export function finalizeRun(runDir, status, extra = {}) {
  const file = path.join(runDir, 'run.json');
  const manifest = readJson(file);
  manifest.status = status;
  manifest.finished_at = new Date().toISOString();
  Object.assign(manifest, extra);
  writeJsonAtomic(file, manifest);
  return manifest;
}
