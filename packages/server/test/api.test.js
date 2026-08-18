import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildServer } from '../src/index.js';
import { RUNS_DIR, appendEventToRun, listRuns } from '@carica/core';

let app;
let base;
let runId;
let runDir;

before(async () => {
  // The NEWEST run is the wrong fixture: the moment a live run fails, it becomes the newest
  // one and every assertion below (which expects a complete run with all eleven artifacts)
  // fails for reasons that have nothing to do with the server. That turns `npm run gate`
  // red exactly when a failed run is what you are trying to investigate. Take the newest
  // COMPLETE run instead.
  const runs = listRuns();
  assert.ok(runs.length, 'these tests need at least one run — run `npm run gate:phase0` first');
  const complete = runs.find((r) => r.manifest?.status === 'complete');
  assert.ok(complete, 'these tests need at least one complete run — run `npm run gate:phase0` first');
  runId = complete.runId;
  runDir = path.join(RUNS_DIR, runId);

  app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  const pending = path.join(runDir, 'decisions.pending.json');
  if (fs.existsSync(pending)) fs.unlinkSync(pending);
  await app?.close();
});

describe('run endpoints', () => {
  test('lists runs', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/runs' });
    assert.equal(r.statusCode, 200);
    assert.ok(r.json().runs.length > 0);
  });

  test('projects run state server-side, all stages ok', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.state.status, 'complete');
    assert.equal(body.state.stages.score.status, 'ok');
    assert.ok(body.artifacts.includes('05_scored.json'));
    assert.ok(!body.artifacts.some((a) => a.includes('.part-')), 'shard part files must not be listed as artifacts');
  });

  test('serves an artifact', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/runs/${runId}/artifact/05_scored.json` });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().stage, 'score');
  });

  test('serves an evidence log as parsed records', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/runs/${runId}/artifact/01_outlets.evidence.jsonl` });
    assert.equal(r.statusCode, 200);
    const { records } = r.json();
    assert.ok(records.length >= 6);
    assert.ok(records[0].evidence_id.startsWith('ev_'));
  });

  test('404s an unknown run', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/runs/does-not-exist' });
    assert.equal(r.statusCode, 404);
  });

  test('exposes the rubric weights for client-side re-ranking', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/config' });
    assert.equal(r.statusCode, 200);
    assert.equal(typeof r.json().weights.weights.legibility, 'number');
  });
});

describe('path traversal is refused', () => {
  for (const evil of ['../../../etc/passwd', '..%2f..%2fpackage.json', '/etc/passwd', '..\\..\\x']) {
    test(`artifact ${evil}`, async () => {
      const r = await app.inject({ method: 'GET', url: `/api/runs/${runId}/artifact/${encodeURIComponent(evil)}` });
      assert.equal(r.statusCode, 404, `must not serve ${evil}`);
    });
  }

  test('run id cannot escape the runs directory', async () => {
    const r = await app.inject({ method: 'GET', url: `/api/runs/${encodeURIComponent('../config')}` });
    assert.equal(r.statusCode, 404);
  });
});

describe('human checkpoint', () => {
  test('rejects a decision with no attribution', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/decisions`,
      payload: { decisions: [{ story_id: 's', concept_id: 'c', decision: 'approved' }] },
    });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().errors.join(' '), /decided_by/);
  });

  test('rejects an unknown decision value', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/decisions`,
      payload: { decisions: [{ story_id: 's', concept_id: 'c', decision: 'looks_fine', decided_by: 'ed' }] },
    });
    assert.equal(r.statusCode, 400);
  });

  test('rejects a malformed body', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/runs/${runId}/decisions`, payload: { nope: true } });
    assert.equal(r.statusCode, 400);
  });

  test('writes decisions.pending.json and logs a human.decision event', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/decisions`,
      payload: {
        decisions: [
          {
            story_id: 'st_recycled_renders',
            concept_id: 'cp_rr_copier',
            decision: 'approved',
            decided_by: 'test editor',
            editor_note: 'running it',
          },
        ],
      },
    });
    assert.equal(r.statusCode, 200);

    const file = path.join(runDir, 'decisions.pending.json');
    assert.ok(fs.existsSync(file), 'S11 reads this file; the server is the only thing that writes it');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).decisions[0].decided_by, 'test editor');

    const events = fs.readFileSync(path.join(runDir, 'events.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(events.at(-1).type, 'human.decision');

    const back = await app.inject({ method: 'GET', url: `/api/runs/${runId}/decisions` });
    assert.equal(back.json().decisions.length, 1);
  });
});

describe('SSE stream', () => {
  /** Read SSE frames off a live socket until `predicate` is satisfied or we time out. */
  async function collect(url, predicate, timeoutMs = 6000, onOpen) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { headers: { Accept: 'text/event-stream' }, signal: ctrl.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const events = [];
    let buf = '';
    let opened = false;

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          events.push(JSON.parse(dataLine.slice(6)));
        }

        if (!opened && onOpen) {
          opened = true;
          await onOpen();
        }
        if (predicate(events)) break;
      }
    } finally {
      clearTimeout(timer);
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
    }
    return events;
  }

  test('replays the whole run from t0 for a client joining late', async () => {
    const events = await collect(`${base}/api/runs/${runId}/events`, (es) => es.some((e) => e.type === 'run.end'));
    assert.equal(events[0].type, 'run.start');
    assert.ok(events.some((e) => e.type === 'run.end'));
    assert.equal(
      events.filter((e) => e.type === 'stage.end' && !String(e.label ?? '').includes(':')).length,
      11,
      'all eleven stages should replay'
    );
  });

  test('Last-Event-ID resumes rather than replaying', async () => {
    const all = await collect(`${base}/api/runs/${runId}/events`, (es) => es.some((e) => e.type === 'run.end'));
    const midSeq = all[Math.floor(all.length / 2)].seq;

    const resumed = await collect(
      `${base}/api/runs/${runId}/events?lastEventId=${midSeq}`,
      (es) => es.some((e) => e.type === 'run.end')
    );
    assert.ok(resumed.every((e) => e.seq > midSeq), 'resumed stream must not re-send seen events');
    assert.ok(resumed.length < all.length);
  });

  test('streams an event appended AFTER the client connected', async () => {
    const marker = `probe-${Date.now()}`;
    const events = await collect(
      `${base}/api/runs/${runId}/events`,
      (es) => es.some((e) => e.type === 'stage.progress' && e.message === marker),
      6000,
      // fires once the stream is open, so this genuinely tests the tailer, not the replay
      async () => {
        await new Promise((r) => setTimeout(r, 150));
        appendEventToRun(runDir, 'stage.progress', { stage: 'score', message: marker });
      }
    );
    assert.ok(
      events.some((e) => e.message === marker),
      'the tailer must deliver events written after the connection opened'
    );
  });
});
