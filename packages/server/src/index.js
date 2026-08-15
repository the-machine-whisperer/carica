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
} from '@carica/core';
import { stageGraph, verifyRun } from '@carica/pipeline';
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

  app.get('/api/active', async () => ({ active: runner.getActive() }));

  app.post('/api/runs/:runId/stop', async (req, reply) => {
    try {
      return runner.stop(req.params.runId);
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

    return {
      run_id: req.params.runId,
      manifest,
      state,
      artifacts,
      active: runner.isActive(req.params.runId),
      interrupted: manifest?.status === 'running' && !runner.isActive(req.params.runId),
      policy: policyStatus(),
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

export async function startServer({ port = 4317, host = '127.0.0.1', logger = false } = {}) {
  const app = await buildServer({ logger });
  await app.listen({ port, host });
  return app;
}
