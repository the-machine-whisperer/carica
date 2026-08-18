#!/usr/bin/env node
/**
 * A stand-in for `codex exec`, for the ONE fanned-out stage the control tests need to watch.
 *
 * There is no `codex` binary on the machine this project is developed on, and there must
 * never be a network fetch inside `npm run gate`. But the questions these tests ask — was
 * this shard's agent actually spawned, did the stage merge what survived — are questions
 * about a real child process being started or not started. Mocking the spawn away would test
 * the mock, so `CARICA_CODEX_BIN` points here instead and the pipeline gets a genuine child
 * that does what a harvest agent does: writes one part artifact and one part evidence log,
 * then exits.
 *
 * What it writes is sliced out of the frozen fixture snapshot, so the shards merge into
 * exactly the artifact the offline replay produces and the merged result is checked against
 * the same contract a live run's would be.
 *
 * It works out which shard it is the same way a real agent would: by reading its charter.
 * The rendered charter names one pair of files and one only (see fanout-charter.test.js),
 * and the part filename carries the shard key — which is precisely the property that test
 * exists to defend.
 *
 * Environment:
 *   CARICA_FAKE_FIXTURE   the snapshot directory to slice (required)
 *   CARICA_FAKE_DELAY_MS  how long to take about it, for tests that need to catch it running
 *   CARICA_FAKE_BROKEN    write a part artifact that does NOT satisfy the contract
 */
import fs from 'node:fs';
import path from 'node:path';

const prompt = process.argv[process.argv.length - 1] ?? '';
const fixture = process.env.CARICA_FAKE_FIXTURE;
const delayMs = Number(process.env.CARICA_FAKE_DELAY_MS ?? 0);
const broken = !!process.env.CARICA_FAKE_BROKEN;

// One `--json` line so the pipeline's activity plumbing has something real to summarise.
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 't_fake' }) + '\n');

const m = prompt.match(/(\d\d_[a-z]+\.part-([A-Za-z0-9_-]+))\.json/);
if (!m || !fixture) {
  process.stderr.write('fake-harvest-agent: no shard artifact named in the charter\n');
  process.exit(2);
}
const [, slug, key] = m;

const merged = JSON.parse(fs.readFileSync(path.join(fixture, '02_items.json'), 'utf8'));
const items = (merged.items ?? []).filter((i) => i.outlet_id === key);
const status =
  (merged.outlet_status ?? []).find((s) => s.outlet_id === key) ??
  { outlet_id: key, ok: true, item_count: items.length, robots_allowed: true };

const part = broken
  ? { schema_version: '1.0', stage: 'harvest', run_id: path.basename(process.cwd()) }
  : {
      schema_version: '1.0',
      stage: 'harvest',
      run_id: path.basename(process.cwd()),
      generated_at: new Date().toISOString(),
      agent: { model: 'fake-agent', charter_sha: 'fake', attempt: 1 },
      items,
      outlet_status: [status],
    };

const finish = () => {
  // The evidence log first, exactly as the operating rules tell a real agent to: whatever
  // was gathered must be on disk even if the agent is interrupted before it writes its
  // artifact. That ordering is what makes a half-finished shard detectable as half-finished.
  fs.copyFileSync(path.join(fixture, '02_items.evidence.jsonl'), path.join(process.cwd(), `${slug}.evidence.jsonl`));
  fs.writeFileSync(path.join(process.cwd(), `${slug}.json`), JSON.stringify(part, null, 2) + '\n', 'utf8');
  process.stdout.write(
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'i1', type: 'file_change', changes: [{ path: `${slug}.json` }] },
    }) + '\n'
  );
  process.exit(0);
};

if (delayMs > 0) setTimeout(finish, delayMs);
else finish();
