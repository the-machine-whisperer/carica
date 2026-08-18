#!/usr/bin/env node
/**
 * A stand-in for `codex exec` for ANY fanned-out stage, not just the harvest.
 *
 * `fake-harvest-agent.mjs` next door slices `02_items.json` and knows harvest's shape by
 * name. That was enough while the harvest was the only fan-out anybody drove in a test —
 * and that is exactly how ideate, prompt and render came to ship a fan-out that crashed the
 * moment it was reached. The offline replay cannot catch it either: `runFannedStage`
 * short-circuits in replay mode and never calls `select` at all, so the gate run exercises
 * the merged snapshot and none of the machinery that produces it.
 *
 * So this one is generic. It works out which stage and which shard it is from the artifact
 * name in its charter, slices the matching rows out of that stage's frozen artifact, and
 * writes them back as a part file — the same trick, applied by shape rather than by name.
 *
 * Environment:
 *   CARICA_FAKE_FIXTURE   the snapshot directory to slice (required)
 */
import fs from 'node:fs';
import path from 'node:path';

const prompt = process.argv[process.argv.length - 1] ?? '';
const fixture = process.env.CARICA_FAKE_FIXTURE;

process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 't_fake' }) + '\n');

const m = prompt.match(/((\d\d_[a-z]+)\.part-([A-Za-z0-9_-]+))\.json/);
if (!m || !fixture) {
  process.stderr.write('fake-stage-agent: no shard artifact named in the charter\n');
  process.exit(2);
}
const [, slug, stageSlug, key] = m;

const merged = JSON.parse(fs.readFileSync(path.join(fixture, `${stageSlug}.json`), 'utf8'));

/** The one array this stage's artifact carries — items, candidates, packages, renders. */
const [partKey, rows] =
  Object.entries(merged).find(([, v]) => Array.isArray(v) && v.length && typeof v[0] === 'object') ?? [];
if (!partKey) {
  process.stderr.write(`fake-stage-agent: no shard array in ${stageSlug}.json\n`);
  process.exit(2);
}

/**
 * Does this row belong to this shard? Every fanned stage keys its shards off one of these,
 * and the composite comes first because `st_a_cp_a` would otherwise match on `story_id`
 * alone and hand a render shard both of its concepts.
 */
const belongs = (r) =>
  `${r.story_id}_${r.concept_id}` === key || r.story_id === key || r.outlet_id === key || r.id === key;

const part = {
  schema_version: '1.0',
  stage: merged.stage,
  run_id: path.basename(process.cwd()),
  generated_at: new Date().toISOString(),
  agent: { model: 'fake-agent', charter_sha: 'fake', attempt: 1 },
  [partKey]: rows.filter(belongs),
};

// Anything else the contract requires of the whole artifact (09_gate's policy_sha, a
// harvest's outlet_status) is carried through untouched — a shard satisfies the parent's
// contract, so it needs the parent's fields.
for (const [k, v] of Object.entries(merged)) {
  if (!(k in part) && !Array.isArray(v)) part[k] = v;
}
if (Array.isArray(merged.outlet_status)) {
  part.outlet_status = merged.outlet_status.filter((s) => s.outlet_id === key);
}

fs.writeFileSync(path.join(process.cwd(), `${slug}.json`), JSON.stringify(part, null, 2) + '\n', 'utf8');
const srcEvidence = path.join(fixture, `${stageSlug}.evidence.jsonl`);
if (fs.existsSync(srcEvidence)) {
  fs.copyFileSync(srcEvidence, path.join(process.cwd(), `${slug}.evidence.jsonl`));
}

process.stdout.write(
  JSON.stringify({
    type: 'item.completed',
    item: { id: 'i1', type: 'file_change', changes: [{ path: `${slug}.json` }] },
  }) + '\n'
);
process.exit(0);
