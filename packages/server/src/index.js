import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import YAML from 'yaml';
import {
  RUNS_DIR,
  CONFIG_DIR,
  REPO_ROOT,
  listRuns,
  readJson,
  readEvents,
  tailEvents,
  appendEventToRun,
  projectRun,
  readLedger,
  LEDGER_PATH,
  readControl,
  controlState,
  readCheckpoint,
  deriveCheckpoint,
} from '@carica/core';
import { stageGraph, verifyRun, STAGES } from '@carica/pipeline';
import { createRunManager, listFixtures, RunError } from './run-manager.js';
import { systemStatus, settingsView, writeEnvFile, readWeightsDoc, writeWeights, policyStatus } from './setup.js';

const WEB_DIST = path.join(REPO_ROOT, 'packages', 'web', 'dist');

/** Reject anything that could escape the run directory. */
function safeName(name) {
  if (typeof name !== 'string' || !name.length) return null;
  if (name.includes('..') || name.includes('/') || name.includes('\\') || path.isAbsolute(name)) return null;
  return name;
}

function runDirFor(runId) {
  const id = safeName(runId);
  if (!id) return null;
  const dir = path.join(RUNS_DIR, id);
  return fs.existsSync(dir) ? dir : null;
}

/**
 * Stage numbers and titles, for the checkpoint deriver.
 *
 * core cannot import them — pipeline imports core, and reversing that is a cycle — so the
 * one source of truth is handed down rather than duplicated. Computed once: the graph is
 * a constant, and a resume picker should not rebuild it on every poll.
 */
const STAGE_META = Object.fromEntries(stageGraph().map((s) => [s.id, { n: s.n, title: s.title }]));
const STAGE_IDS = new Set(STAGES.map((s) => s.id));

/**
 * Where a run would pick up if it were continued.
 *
 * `state.json` is a cache the pipeline writes as it goes, so it is preferred — it is one
 * small read instead of a fold over a log that can run to tens of thousands of lines. But
 * it is only a cache: every run made before it existed has none, and a run interrupted
 * mid-write can have half of one. Both fall back to deriving the same answer from the
 * events, which is the actual evidence. An old run is exactly as resumable as a new one;
 * its artifacts are on disk either way, and this must never be the reason it is not.
 *
 * Returns null only when there is genuinely nothing to say — a run directory with no
 * events at all — never because something was unreadable.
 */
function checkpointFor(dir) {
  const cached = readCheckpoint(dir);
  // A checkpoint with no stages is a torn or hand-edited one, whatever it parsed as.
  if (cached && cached.stages && typeof cached.stages === 'object') return cached;

  try {
    const events = readEvents(path.join(dir, 'events.ndjson'));
    if (!events.length) return null;
    let manifest = null;
    try {
      manifest = readJson(path.join(dir, 'run.json'));
    } catch {
      /* a run without a readable manifest still has its events */
    }
    return deriveCheckpoint(events, { stageMeta: STAGE_META, manifest });
  } catch {
    // Degrade, never 500. "I cannot tell you where this run stands" is a usable answer;
    // a crash on the run screen is not.
    return null;
  }
}

/** What has been asked of a run, and what those requests add up to once folded. */
function controlFor(dir) {
  const records = readControl(dir);
  return { records, state: controlState(records) };
}

export async function buildServer(opts = {}) {
  const app = Fastify({ logger: opts.logger ?? false });
  const runner = opts.runner ?? createRunManager();

  /** Turn a thrown RunError (or anything else) into a reply the app can show verbatim. */
  const fail = (reply, err) => {
    const status = err?.status ?? 500;
    return reply.code(status).send({
      error: err?.message ?? 'Something went wrong.',
      errors: err?.errors ?? undefined,
      active: err?.active ?? undefined,
    });
  };

  // ---------------------------------------------------------------- meta

  app.get('/api/health', async () => ({ ok: true, repo: REPO_ROOT }));

  /** The stage graph — one source of truth for the rail, the CLI and the resume picker. */
  app.get('/api/stages', async () => ({ stages: stageGraph() }));

  /** Preflight: can this machine do a live run, and if not, what does the user do about it? */
  app.get('/api/system', async () => {
    const status = await systemStatus();
    return { ...status, active_run: runner.getActive() };
  });

  app.get('/api/fixtures', async () => ({
    fixtures: listFixtures().map((f) => ({ name: f.name, stages: f.stages })),
  }));

  // ------------------------------------------------------------ settings

  app.get('/api/settings', async () => settingsView());

  app.post('/api/settings', async (req, reply) => {
    const updates = req.body?.settings;
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return reply.code(400).send({ error: 'body must be {settings: {KEY: value}}' });
    }
    try {
      writeEnvFile(updates);
    } catch (err) {
      return fail(reply, err);
    }
    // Echo the new state. These are model names and paths — there are no credentials in
    // this app to withhold, and there is no key anywhere in this project.
    return { ok: true, ...settingsView() };
  });

  // ------------------------------------------------------------- weights

  app.get('/api/weights', async () => {
    const { data } = readWeightsDoc();
    return { weights: data?.weights ?? {}, floors: data?.floors ?? {}, funnel: data?.funnel ?? {}, edited_at: data?.edited_at ?? null };
  });

  app.put('/api/weights', async (req, reply) => {
    const weights = req.body?.weights;
    if (!weights || typeof weights !== 'object') {
      return reply.code(400).send({ error: 'body must be {weights: {dimension: number}}' });
    }
    try {
      return writeWeights(weights);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get('/api/config', async () => {
    const readYaml = (f) => {
      const p = path.join(CONFIG_DIR, f);
      return fs.existsSync(p) ? YAML.parse(fs.readFileSync(p, 'utf8')) : null;
    };
    const policyPath = path.join(CONFIG_DIR, 'editorial-policy.md');
    return {
      weights: readYaml('weights.yaml'),
      outlets: readYaml('outlets.he.yaml'),
      policy_present: fs.existsSync(policyPath),
    };
  });

  app.get('/api/policy', async (req, reply) => {
    const p = path.join(CONFIG_DIR, 'editorial-policy.md');
    if (!fs.existsSync(p)) return reply.code(404).send({ error: 'no editorial policy on disk' });
    return reply.type('text/markdown; charset=utf-8').send(fs.readFileSync(p, 'utf8'));
  });

  app.get('/api/ledger', async () => ({ entries: readLedger(LEDGER_PATH) }));

  // ---------------------------------------------------------------- runs

  app.get('/api/runs', async () => ({
    active: runner.getActive(),
    runs: listRuns().map((r) => {
      const status = r.manifest?.status ?? 'unknown';
      const active = runner.isActive(r.runId);
      return {
        run_id: r.runId,
        status,
        // A manifest still saying "running" with no process behind it is a run that died
        // with the server, not a run in flight. Say so rather than spinning for ever.
        interrupted: status === 'running' && !active,
        active,
        created_at: r.manifest?.created_at ?? null,
        finished_at: r.manifest?.finished_at ?? null,
        slug: r.manifest?.slug ?? null,
        mode: r.manifest?.config?.mode ?? null,
        stage_summary: r.manifest?.stage_summary ?? null,
      };
    }),
  }));

  /** Start a run. This is `carica run`, addressable from a button. */
  app.post('/api/runs', async (req, reply) => {
    try {
      const started = await runner.start(req.body ?? {}, { requestedBy: req.body?.requested_by ?? null });
      return reply.code(201).send({ ok: true, run_id: started.runId, mode: started.mode, resumed: started.resumed });
    } catch (err) {
      return fail(reply, err);
    }
  });

  /**
   * Where a new run could take its earlier results from, and how far each source gets you.
   *
   * `through` is the last step whose artifact is present, so the browser can offer exactly
   * the steps a source can actually start you at and no others. Presence only — validating
   * every artifact of every run on every dialog open would be slow, and the pipeline
   * re-checks each one against its contract before it uses it anyway.
   */
  app.get('/api/seed-sources', async () => {
    const artifactOf = Object.fromEntries(STAGES.map((s) => [s.id, s.artifact]));
    const describe = (name, dir, kind, extra = {}) => {
      const present = STAGES.filter((s) => fs.existsSync(path.join(dir, s.artifact))).map((s) => s.id);
      // Contiguous from the first step: a gap means you cannot start after it.
      const contiguous = [];
      for (const s of STAGES) {
        if (!present.includes(s.id)) break;
        contiguous.push(s.id);
      }
      return {
        id: name,
        kind,
        stages: contiguous,
        through: contiguous.length ? contiguous[contiguous.length - 1] : null,
        artifacts: contiguous.map((id) => artifactOf[id]),
        ...extra,
      };
    };

    const runs = listRuns()
      .map((r) => describe(r.runId, r.dir, 'run', { slug: r.manifest?.slug ?? null, created_at: r.manifest?.created_at ?? null, status: r.manifest?.status ?? null }))
      .filter((r) => r.stages.length);
    const fixtures = listFixtures().map((f) => describe(f.name, f.path, 'fixture')).filter((f) => f.stages.length);

    return { sources: [...runs, ...fixtures] };
  });

  app.get('/api/active', async () => ({ active: runner.getActive() }));

  app.post('/api/runs/:runId/stop', async (req, reply) => {
    try {
      return runner.stop(req.params.runId);
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ------------------------------------------------- steering a run in flight
  //
  // Stopping a run is the blunt instrument: everything ends. These are the rest of the
  // verbs — pause the whole thing, hold one step, kill or skip a single job — and they
  // exist because a run is eighteen agents wide and one of them going wrong is not a
  // reason to throw away the other seventeen.
  //
  // Every one of them is written to control.ndjson before anything else happens, so what
  // an editor asked for is on disk whether or not a process was there to hear it.

  /**
   * Ask a run to pause, resume, kill or skip.
   *
   * The reply is a receipt, not a result: `request_id` identifies the instruction, and
   * `delivered` says only whether the live process was told about it directly. What
   * actually happened to the work arrives on the event stream, from the process that did
   * it. A 200 here never means "it has stopped".
   */
  app.post('/api/runs/:runId/control', async (req, reply) => {
    const dir = runDirFor(req.params.runId);
    if (!dir) return reply.code(404).send({ error: 'no such run' });
    const body = req.body ?? {};
    try {
      return runner.control(req.params.runId, {
        action: body.action,
        target: body.target,
        by: body.by ?? null,
      });
    } catch (err) {
      return fail(reply, err);
    }
  });

  /**
   * Everything that has been asked of this run, and who asked for it.
   *
   * Cheap, and worth having on its own: the control log is the only place that records an
   * intention which was never carried out — the shard an editor killed a second after it
   * finished anyway. The event log cannot show that, because it did not happen. This is
   * what makes a decision auditable rather than merely effective.
   */
  app.get('/api/runs/:runId/control', async (req, reply) => {
    const dir = runDirFor(req.params.runId);
    if (!dir) return reply.code(404).send({ error: 'no such run' });
    return controlFor(dir);
  });

  /** Where this run would pick up if it were continued. */
  app.get('/api/runs/:runId/checkpoint', async (req, reply) => {
    const dir = runDirFor(req.params.runId);
    if (!dir) return reply.code(404).send({ error: 'no such run' });
    return { run_id: req.params.runId, checkpoint: checkpointFor(dir) };
  });

  /**
   * Carry this run on from `from`, in its own directory, under its own id.
   *
   * Different from starting a new run that borrows an old one's artifacts (`seedFrom`):
   * this one keeps the run id, so the record stays a single continuous story rather than
   * two runs somebody has to correlate later.
   */
  app.post('/api/runs/:runId/resume', async (req, reply) => {
    const dir = runDirFor(req.params.runId);
    if (!dir) return reply.code(404).send({ error: 'no such run' });

    const from = req.body?.from;
    if (typeof from !== 'string' || !from.trim()) {
      return reply.code(400).send({ error: 'Continuing a run needs a step to continue from.' });
    }
    if (!STAGE_IDS.has(from)) {
      // Named in full, because the person reading this is choosing a step, not debugging.
      return reply.code(400).send({
        error: `There is no step called “${from}”. Continue from one of: ${STAGES.map((s) => s.id).join(', ')}.`,
      });
    }

    try {
      const started = await runner.resume(
        req.params.runId,
        { from, retryKilled: req.body?.retryKilled },
        { requestedBy: req.body?.requested_by ?? null }
      );
      return { ok: true, run_id: started.runId, resumed: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** The contract audit — `carica verify`, on demand, per run. */
  app.get('/api/runs/:runId/verify', async (req, reply) => {
    const dir = runDirFor(req.params.runId);
    if (!dir) return reply.code(404).send({ error: 'no such run' });
    try {
      const { rows, ok } = verifyRun(dir);
      return { run_id: req.params.runId, ok, rows };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get('/api/runs/:runId', async (req, reply) => {
    const dir = runDirFor(req.params.runId);
    if (!dir) return reply.code(404).send({ error: 'no such run' });

    const eventsFile = path.join(dir, 'events.ndjson');
    const state = projectRun(readEvents(eventsFile));

    // Which artifacts are actually on disk — the app links straight to them.
    const artifacts = fs
      .readdirSync(dir)
      .filter((f) => /^\d\d_.*\.json$/.test(f) && !f.includes('.part-'))
      .sort();

    let manifest = null;
    try {
      manifest = readJson(path.join(dir, 'run.json'));
    } catch {
      /* a run without a manifest is still viewable */
    }

    // The resume point and the standing instructions ride along with the poll the run
    // screen already makes. Both are small — a couple of dozen lines of JSON — and the
    // alternative is three requests for one screen, each arriving at a slightly different
    // moment, which is how a UI ends up drawing a paused run with a running spinner.
    return {
      run_id: req.params.runId,
      manifest,
      state,
      artifacts,
      active: runner.isActive(req.params.runId),
      interrupted: manifest?.status === 'running' && !runner.isActive(req.params.runId),
      policy: policyStatus(),
      checkpoint: checkpointFor(dir),
      control: controlFor(dir),
    };
  });

  app.get('/api/runs/:runId/artifact/:name', async (req, reply) => {
    const dir = runDirFor(req.params.runId);
    const name = safeName(req.params.name);
    if (!dir || !name) return reply.code(404).send({ error: 'not found' });
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) return reply.code(404).send({ error: `no artifact ${name}` });
    if (name.endsWith('.jsonl')) {
      const lines = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return { __malformed: l.slice(0, 200) };
          }
        });
      return { records: lines };
    }
    return reply.type('application/json; charset=utf-8').send(fs.readFileSync(file, 'utf8'));
  });

  // Rendered drafts. Served from inside the run dir only.
  app.get('/api/runs/:runId/drafts/:file', async (req, reply) => {
    const dir = runDirFor(req.params.runId);
    const file = safeName(req.params.file);
    if (!dir || !file) return reply.code(404).send({ error: 'not found' });
    const p = path.join(dir, '10_drafts', file);
    if (!fs.existsSync(p)) return reply.code(404).send({ error: 'no such draft' });
    const type = p.endsWith('.webp') ? 'image/webp' : p.endsWith('.jpg') ? 'image/jpeg' : 'image/png';
    return reply.type(type).send(fs.createReadStream(p));
  });

  // Exported briefs
  app.get('/api/runs/:runId/brief/:file', async (req, reply) => {
    const dir = runDirFor(req.params.runId);
    const file = safeName(req.params.file);
    if (!dir || !file) return reply.code(404).send({ error: 'not found' });
    const p = path.join(dir, 'out', file);
    if (!fs.existsSync(p)) return reply.code(404).send({ error: 'no such brief' });
    return reply.type('text/markdown; charset=utf-8').send(fs.readFileSync(p, 'utf8'));
  });

  // ---------------------------------------------------------------- SSE
  //
  // One-directional firehose, so SSE rather than a WebSocket: it reconnects by itself and
  // Last-Event-ID replay means a graphics-team member joining mid-run sees the whole run
  // from t0 rather than from the moment they opened the tab.

  app.get('/api/runs/:runId/events', (req, reply) => {
    const dir = runDirFor(req.params.runId);
    if (!dir) {
      reply.code(404).send({ error: 'no such run' });
      return;
    }

    const headerId = Number(req.headers['last-event-id']);
    const queryId = Number(req.query?.lastEventId);
    const fromSeq = Number.isFinite(headerId) ? headerId : Number.isFinite(queryId) ? queryId : 0;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(`retry: 2000\n\n`);

    const send = (e) => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    };

    const stop = tailEvents(path.join(dir, 'events.ndjson'), fromSeq, send);

    // Comment frames keep proxies from closing an idle stream between slow stages.
    const keepAlive = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(': keep-alive\n\n');
    }, 15000);
    if (keepAlive.unref) keepAlive.unref();

    const cleanup = () => {
      stop();
      clearInterval(keepAlive);
    };
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
  });

  // ---------------------------------------------------------- human checkpoint

  app.post('/api/runs/:runId/decisions', async (req, reply) => {
    const dir = runDirFor(req.params.runId);
    if (!dir) return reply.code(404).send({ error: 'no such run' });

    const body = req.body ?? {};
    const incoming = Array.isArray(body.decisions) ? body.decisions : null;
    if (!incoming) return reply.code(400).send({ error: 'body must be {decisions: [...]}' });

    const ALLOWED = new Set(['approved', 'revision_requested', 'rejected']);
    const errors = [];
    const cleaned = incoming.map((d, i) => {
      if (!d?.story_id) errors.push(`decision ${i}: story_id required`);
      if (!d?.concept_id) errors.push(`decision ${i}: concept_id required`);
      if (!ALLOWED.has(d?.decision)) errors.push(`decision ${i}: decision must be one of ${[...ALLOWED].join(', ')}`);
      if (!d?.decided_by) errors.push(`decision ${i}: decided_by required — decisions are attributable`);
      return {
        story_id: d.story_id,
        concept_id: d.concept_id,
        decision: d.decision,
        decided_at: d.decided_at ?? new Date().toISOString(),
        decided_by: d.decided_by,
        editor_note: d.editor_note ?? '',
      };
    });
    if (errors.length) return reply.code(400).send({ error: 'invalid decisions', errors });

    // The editor's decisions land in decisions.pending.json. S11 READS this file; it never
    // writes one. That separation is the checkpoint — the pipeline cannot approve itself.
    const file = path.join(dir, 'decisions.pending.json');
    const payload = { recorded_at: new Date().toISOString(), decisions: cleaned };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');

    for (const d of cleaned) {
      appendEventToRun(dir, 'human.decision', {
        stage: 'publish',
        story_id: d.story_id,
        concept_id: d.concept_id,
        decision: d.decision,
        decided_by: d.decided_by,
      });
    }

    return { ok: true, written: path.basename(file), count: cleaned.length };
  });

  app.get('/api/runs/:runId/decisions', async (req, reply) => {
    const dir = runDirFor(req.params.runId);
    if (!dir) return reply.code(404).send({ error: 'no such run' });
    const file = path.join(dir, 'decisions.pending.json');
    if (!fs.existsSync(file)) return { decisions: [] };
    return readJson(file);
  });

  // ---------------------------------------------------------------- static

  if (fs.existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, { root: WEB_DIST });
    // SPA fallback — any non-API route serves the app shell.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}

export async function startServer({ port = 4417, host = '127.0.0.1', logger = false } = {}) {
  const app = await buildServer({ logger });
  await app.listen({ port, host });
  return app;
}
