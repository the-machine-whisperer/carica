import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../src/index.js';
import { createRunManager, listFixtures } from '../src/run-manager.js';
import {
  readEnvFile,
  writeEnvFile,
  settingsView,
  writeWeights,
  readWeightsDoc,
  codexAuthStatus,
  systemStatus,
} from '../src/setup.js';
import { codexReadiness } from '@carica/codex';
import { CONFIG_DIR, RUNS_DIR, listRuns } from '@carica/core';

/**
 * The control plane: starting, stopping and configuring runs from the app rather than a
 * terminal. The tests that matter here are the refusals — a second concurrent run, a
 * resume with nowhere to resume from, a weight that would reward legal risk, a settings
 * write to a key the app has no business touching.
 *
 * One of them is a regression test for a design mistake rather than a bug: this project
 * holds no credentials at all, so the settings screen must never grow a field that looks
 * like one again.
 */

let app;
const WEIGHTS_FILE = path.join(CONFIG_DIR, 'weights.yaml');
let weightsBackup;
const startedRuns = [];

before(async () => {
  weightsBackup = fs.readFileSync(WEIGHTS_FILE, 'utf8');
  app = await buildServer();
});

after(async () => {
  fs.writeFileSync(WEIGHTS_FILE, weightsBackup, 'utf8');
  await app?.close();
  // Runs created here are real directories; keep the archive tidy.
  for (const id of startedRuns) {
    const dir = path.join(RUNS_DIR, id);
    if (fs.existsSync(dir) && id.includes('control-test')) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('stage graph', () => {
  test('is serialisable and complete', async () => {
    const { stages } = (await app.inject({ method: 'GET', url: '/api/stages' })).json();
    assert.equal(stages.length, 11);
    assert.equal(stages[0].id, 'outlets');
    assert.equal(stages.at(-1).humanCheckpoint, true, 'the last stage is the human checkpoint');
    assert.equal(stages.find((s) => s.id === 'harvest').fanout, true);
    assert.equal(stages.find((s) => s.id === 'verify').freshContext, true);
    assert.ok(stages.every((s) => typeof s.title === 'string' && typeof s.artifact === 'string'));
  });
});

describe('readiness', () => {
  test('every failing check tells the user what to do about it', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/system' })).json();
    assert.ok(Array.isArray(body.checks) && body.checks.length >= 3);
    for (const c of body.checks) {
      assert.ok(['ok', 'warn', 'blocked'].includes(c.state), `${c.id}: bad state ${c.state}`);
      if (c.state !== 'ok') {
        assert.ok(c.fix && c.fix.length > 10, `${c.id} fails but offers no remedy`);
      }
    }
    assert.equal(typeof body.ready_for_live, 'boolean');
    assert.equal(body.ready_for_practice, listFixtures().length > 0);
  });

  test('readiness asks whether Codex is signed in, never for an API key', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/system' })).json();
    const ids = body.checks.map((c) => c.id);

    assert.ok(ids.includes('codex'), 'the CLI must still be checked for');
    assert.ok(ids.includes('codex_auth'), 'sign-in is what replaced the key check');
    assert.ok(!ids.some((id) => /key|token|secret/i.test(id)), `no credential checks, got ${ids.join(', ')}`);

    // The remedy is read by an editor, not an engineer: no keys, no billing, no pasting.
    for (const c of body.checks) {
      const words = `${c.label} ${c.detail} ${c.fix ?? ''}`;
      assert.ok(!/api key|paste (your |the )?key|billing/i.test(words), `${c.id} still talks about keys: ${words}`);
    }

    const auth = body.checks.find((c) => c.id === 'codex_auth');
    if (auth.state !== 'ok') assert.match(auth.fix, /codex login/, 'the remedy is one command');
    assert.ok(auth.blocks !== 'practice', 'a practice run must never wait on a sign-in');
    if (auth.state === 'warn') assert.equal(auth.blocks, null, 'not knowing must not block a live run');

    // Tri-state on the wire: absent means "could not tell", which the app must not draw
    // as "signed out".
    if (auth.state === 'warn') assert.equal('logged_in' in body.codex, false);
    else assert.equal(body.codex.logged_in, auth.state === 'ok');
  });

  test('the readiness screen cannot drift from the pipeline it is describing', async () => {
    // The app must never offer a live run the pipeline is about to refuse, nor withhold
    // one it would have accepted, so `ready_for_live` reproduces codexReadiness().ready
    // rather than forming a second opinion. Driven through all three sign-in states.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'carica-codex-home-'));
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    const authFile = path.join(home, 'auth.json');
    try {
      const cases = [
        ['signed_out', null, 'blocked', 'live'],
        ['signed_in', JSON.stringify({ tokens: { access_token: 'a' } }), 'ok', 'live'],
        ['unknown', '{ not json', 'warn', null],
      ];
      for (const [label, contents, expectedState, expectedBlocks] of cases) {
        if (contents === null) fs.rmSync(authFile, { force: true });
        else fs.writeFileSync(authFile, contents);

        const status = await systemStatus();
        const check = status.checks.find((c) => c.id === 'codex_auth');
        assert.equal(check.state, expectedState, label);
        assert.equal(check.blocks, expectedBlocks, `${label}: blocking`);
        assert.equal(status.ready_for_live, (await codexReadiness()).ready, `${label}: ready_for_live drifted`);
        assert.equal(status.ready_for_practice, listFixtures().length > 0, `${label}: practice must not depend on it`);
        if (label === 'unknown') assert.equal('logged_in' in status.codex, false, 'unknown is absent, not false');
        else assert.equal(status.codex.logged_in, label === 'signed_in');
      }
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('the sign-in check reads what codex login leaves on disk, and admits when it cannot tell', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'carica-codex-home-'));
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      assert.equal(codexAuthStatus().state, 'signed_out', 'no auth.json means nobody has run codex login');

      fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { access_token: 'a', id_token: 'b' } }));
      const ok = codexAuthStatus();
      assert.equal(ok.state, 'signed_in');
      assert.equal(ok.method, 'chatgpt');

      fs.writeFileSync(path.join(home, 'auth.json'), '{ not json');
      assert.equal(codexAuthStatus().state, 'unknown', 'an unreadable file is unknown, never a false "yes" or "no"');

      fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: {} }));
      assert.equal(codexAuthStatus().state, 'signed_out');
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('lists practice snapshots', async () => {
    const { fixtures } = (await app.inject({ method: 'GET', url: '/api/fixtures' })).json();
    assert.ok(fixtures.length >= 1);
    assert.ok(fixtures.every((f) => !f.name.includes('/')));
  });
});

describe('starting a run from the app', () => {
  test('a practice run started over HTTP runs to completion and passes its contracts', async () => {
    const started = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { mode: 'replay', slug: 'control-test' },
    });
    assert.equal(started.statusCode, 201, started.payload);
    const runId = started.json().run_id;
    startedRuns.push(runId);

    // The run id comes back as soon as the directory exists, not when the run finishes.
    assert.ok(fs.existsSync(path.join(RUNS_DIR, runId)));

    const deadline = Date.now() + 60_000;
    let state;
    for (;;) {
      const body = (await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).json();
      state = body.state;
      if (['complete', 'failed', 'cancelled'].includes(state.status)) break;
      assert.ok(Date.now() < deadline, 'the run never finished');
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(state.status, 'complete');

    const audit = (await app.inject({ method: 'GET', url: `/api/runs/${runId}/verify` })).json();
    assert.equal(audit.ok, true, JSON.stringify(audit.rows.filter((r) => r.ok === false)));
    assert.equal(audit.rows.filter((r) => r.ok).length, 11);
  });

  test('refuses a second run while one is going', async () => {
    // A stub keeps the test honest without racing a real run that finishes in a second.
    const busy = await buildServer({
      runner: {
        start: () => {
          const err = new Error('A run is already going (x). Stop it before starting another.');
          err.status = 409;
          err.active = { run_id: 'x' };
          throw err;
        },
        stop: () => ({ ok: true }),
        getActive: () => ({ run_id: 'x', mode: 'live', stopping: false }),
        isActive: (id) => id === 'x',
      },
    });
    const r = await busy.inject({ method: 'POST', url: '/api/runs', payload: { mode: 'replay' } });
    assert.equal(r.statusCode, 409);
    assert.match(r.json().error, /already going/);
    assert.equal(r.json().active.run_id, 'x');

    const list = (await busy.inject({ method: 'GET', url: '/api/runs' })).json();
    assert.equal(list.active.run_id, 'x');
    await busy.close();
  });

  test('rejects a step that does not exist', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/runs', payload: { mode: 'replay', from: 'sketch' } });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /Unknown step/);
  });

  test('rejects continuing a run that is not there', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { mode: 'replay', resumeRunId: 'no-such-run', from: 'score' },
    });
    assert.equal(r.statusCode, 404);
  });

  test('rejects a run id that tries to escape the runs directory', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { mode: 'replay', resumeRunId: '../config', from: 'score' },
    });
    assert.equal(r.statusCode, 400);
  });

  test('continuing needs a step to continue from', async () => {
    const existing = fs.readdirSync(RUNS_DIR).filter((d) => !d.startsWith('.'))[0];
    const r = await app.inject({ method: 'POST', url: '/api/runs', payload: { mode: 'replay', resumeRunId: existing } });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /step to continue from/);
  });

  test('stopping when nothing is running says so rather than pretending', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/runs/whatever/stop' });
    assert.equal(r.statusCode, 409);
  });

  test('a manager with no job reports no active run', () => {
    const runner = createRunManager();
    assert.equal(runner.getActive(), null);
    assert.equal(runner.isActive('anything'), false);
  });
});

describe('settings', () => {
  test('there is no secret to hand back: nothing here is a credential', async () => {
    // The old version of this test asserted a key was returned masked. The design
    // changed: the pipeline calls no API, so it holds no credentials, and the way that
    // regresses is somebody re-adding a "paste your key" field. Prove it cannot come back.
    const body = (await app.inject({ method: 'GET', url: '/api/settings' })).json();
    assert.ok(body.settings.length >= 2);

    for (const s of body.settings) {
      assert.notEqual(s.secret, true, `${s.key} is marked secret — this project stores no secrets`);
      assert.equal(s.masked, undefined, `${s.key} carries masking machinery that should be gone`);
      assert.ok(
        !/(^|_)(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)(_|$)/i.test(s.key),
        `${s.key} is named like a credential`
      );
      assert.ok(
        !/api key|token|password|paste your key/i.test(`${s.label} ${s.help ?? ''}`),
        `${s.key} still describes itself as a credential`
      );
      assert.equal(typeof s.value, 'string', 'a non-secret setting is shown in full');
    }

    const payload = JSON.stringify(body);
    assert.ok(!/sk-[A-Za-z0-9-]{8}/.test(payload), 'nothing key-shaped may reach the browser');
    assert.ok(!/OPENAI_API_KEY|SIMILARWEB|BEARER_TOKEN|BOT_TOKEN/i.test(payload));
  });

  test('refuses to write a key it does not manage', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/settings', payload: { settings: { PATH: '/evil' } } });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /not editable/);
  });

  test('refuses a malformed body', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/settings', payload: { settings: 'nope' } });
    assert.equal(r.statusCode, 400);
  });

  test('writing .env keeps comments and keys it does not manage', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'carica-env-')), '.env');
    fs.writeFileSync(file, '# a comment worth keeping\nUNMANAGED=leave-me\nCARICA_CODEX_MODEL=old-value\n');
    const priorModel = process.env.CARICA_CODEX_MODEL;
    const priorBin = process.env.CARICA_CODEX_BIN;

    writeEnvFile({ CARICA_CODEX_MODEL: 'gpt-5-codex', CARICA_CODEX_BIN: '/opt/codex/bin/codex' }, file);
    const text = fs.readFileSync(file, 'utf8');

    assert.match(text, /# a comment worth keeping/);
    assert.match(text, /UNMANAGED=leave-me/);
    const { values } = readEnvFile(file);
    assert.equal(values.CARICA_CODEX_MODEL, 'gpt-5-codex');
    assert.equal(values.CARICA_CODEX_BIN, '/opt/codex/bin/codex');
    assert.equal(values.UNMANAGED, 'leave-me');
    assert.equal((text.match(/^CARICA_CODEX_MODEL=/gm) ?? []).length, 1, 'a rewritten key must not be duplicated');

    // Clearing removes it from this process's environment too.
    writeEnvFile({ CARICA_CODEX_MODEL: '' }, file);
    assert.equal(readEnvFile(file).values.CARICA_CODEX_MODEL, '');
    assert.equal(process.env.CARICA_CODEX_MODEL, undefined);

    if (priorModel === undefined) delete process.env.CARICA_CODEX_MODEL;
    else process.env.CARICA_CODEX_MODEL = priorModel;
    if (priorBin === undefined) delete process.env.CARICA_CODEX_BIN;
    else process.env.CARICA_CODEX_BIN = priorBin;
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  test('reports whether each setting is present, and what a run uses if it is blank', () => {
    const view = settingsView();
    assert.ok(view.settings.length >= 2);
    assert.ok(view.settings.every((s) => typeof s.present === 'boolean'));
    // Blank on purpose: naming a model here overrides the Codex sign-in's own choice, and a
    // model the account is not entitled to fails every step of a live run with a 400.
    assert.equal(view.settings.find((s) => s.key === 'CARICA_CODEX_MODEL').fallback, '');
  });
});

describe('rubric weights', () => {
  test('a positive legal_risk weight is refused', async () => {
    const before = fs.readFileSync(WEIGHTS_FILE, 'utf8');
    const r = await app.inject({
      method: 'PUT',
      url: '/api/weights',
      payload: {
        weights: {
          legibility: 0.2, absurdity: 0.15, comedic_mechanism: 0.15, spice: 0.12, impact: 0.12,
          shelf_life: 0.1, controversy: 0.1, originality: 0.06, legal_risk: 0.2,
        },
      },
    });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().errors.join(' '), /legal_risk/);
    assert.equal(fs.readFileSync(WEIGHTS_FILE, 'utf8'), before, 'a rejected save must not touch the file');
  });

  test('a missing dimension is refused', async () => {
    const r = await app.inject({ method: 'PUT', url: '/api/weights', payload: { weights: { legibility: 0.5 } } });
    assert.equal(r.statusCode, 400);
    assert.ok(r.json().errors.length >= 8);
  });

  test('saving keeps the reasoning comments in the file', () => {
    const res = writeWeights({
      legibility: 0.25, absurdity: 0.15, comedic_mechanism: 0.15, spice: 0.12, impact: 0.12,
      shelf_life: 0.1, controversy: 0.1, originality: 0.06, legal_risk: -0.2,
    });
    assert.equal(res.ok, true);
    const text = fs.readFileSync(WEIGHTS_FILE, 'utf8');
    assert.match(text, /Ridiculousness and spice pick topics/, 'the comments explain the weights; a save must not eat them');
    assert.match(text, /legibility: 0.25/);
    assert.equal(readWeightsDoc().data.weights.legibility, 0.25);
    assert.equal(readWeightsDoc().data.floors.legibility_min, 4, 'floors must survive a weight save');
  });

  test('warns when the positive weights no longer add up to 1', () => {
    const res = writeWeights({
      legibility: 0.5, absurdity: 0.15, comedic_mechanism: 0.15, spice: 0.12, impact: 0.12,
      shelf_life: 0.1, controversy: 0.1, originality: 0.06, legal_risk: -0.2,
    });
    assert.ok(res.warning, 'an off-scale rubric should say so');
    assert.match(res.warning, /1\.30|1\.3/);
  });
});

describe('starting partway through, on another run’s results', () => {
  test('lists what could be carried over, and how far each source reaches', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/seed-sources' });
    assert.equal(r.statusCode, 200);
    const { sources } = r.json();
    assert.ok(sources.length, 'the fixtures alone should provide at least one');
    for (const s of sources) {
      assert.ok(['run', 'fixture'].includes(s.kind));
      assert.ok(s.stages.length > 0, 'a source with nothing to offer must not be listed');
      assert.equal(s.through, s.stages[s.stages.length - 1]);
    }
    assert.ok(sources.some((s) => s.kind === 'fixture'), 'a practice snapshot is a legitimate source');
  });

  test('the offered stages are contiguous from step 1 — a gap makes later steps unreachable', async () => {
    const { sources } = (await app.inject({ method: 'GET', url: '/api/seed-sources' })).json();
    const { STAGES } = await import('@carica/pipeline');
    const order = STAGES.map((s) => s.id);
    for (const s of sources) {
      assert.deepEqual(s.stages, order.slice(0, s.stages.length), `${s.id} advertised a gap`);
    }
  });

  test('carrying over needs a step to start at', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { mode: 'replay', seedFrom: '2026-08-11_sample' },
    });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /needs a step to start at/i);
  });

  test('starting at the first step has nothing to carry over', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { mode: 'replay', from: 'outlets', seedFrom: '2026-08-11_sample' },
    });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /nothing to carry over/i);
  });

  test('continuing a run and carrying results in are refused together', async () => {
    const runs = listRuns();
    const r = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { mode: 'replay', from: 'cluster', resumeRunId: runs[0].runId, seedFrom: '2026-08-11_sample' },
    });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /already has its earlier results/i);
  });

  test('a path that tries to escape the runs directory is refused', async () => {
    for (const bad of ['../../etc', '/etc/passwd', 'a/../../b']) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: { mode: 'replay', from: 'cluster', seedFrom: bad },
      });
      assert.equal(r.statusCode, 400, `${bad} must be refused`);
    }
  });
});
