import fs from 'node:fs';
import path from 'node:path';
import {
  EventBus,
  createRun,
  finalizeRun,
  readJson,
  writeJsonAtomic,
  evidencePath,
  latestRun,
  RUNS_DIR,
  FIXTURES_DIR,
  recentLedgerDigest,
  sha256,
} from '@carica/core';
import { runStage, validateStageOutput, codexReadiness } from '@carica/codex';
import { STAGES, stagesFrom } from './stages.js';
import { loadCharter, renderCharter, readContract, readConfigFile, evidencePreamble } from './charter.js';
import { parallelLimit } from './limit.js';

const DEFAULT_CONCURRENCY = 4;

/**
 * @param {{
 *   from?: string, slug?: string, replay?: string, runsDir?: string,
 *   concurrency?: number, model?: string, autoApprove?: boolean,
 *   resumeRunId?: string, onEvent?: (e:any)=>void,
 *   onStart?: (info: {runId: string, dir: string, resumed: boolean}) => void,
 *   signal?: {aborted: boolean}
 * }} opts
 */
export async function runPipeline(opts = {}) {
  const mode = opts.replay ? 'replay' : 'live';
  const runsDir = opts.runsDir ?? RUNS_DIR;
  const model = opts.model ?? process.env.CARICA_CODEX_MODEL ?? 'gpt-5-codex';
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;

  const fixtureDir =
    mode === 'replay'
      ? path.isAbsolute(opts.replay)
        ? opts.replay
        : path.resolve(process.cwd(), opts.replay)
      : null;

  if (mode === 'replay' && !fs.existsSync(fixtureDir)) {
    throw new Error(`fixture snapshot not found: ${fixtureDir}`);
  }

  // ---- preflight: only a LIVE run has anything to check ----
  //
  // A live run needs exactly two things, and neither of them is a key. This project holds
  // no credentials at all: every stage is a `codex exec` agent and the Codex CLI carries
  // its own sign-in. So the question is only ever "is the agent runtime here, and has
  // somebody signed in to it".
  //
  // A practice run is never gated. It replays a snapshot from disk — no runtime, no
  // sign-in, no network, no bill — and must keep working on a machine where nothing else
  // does, because it is how you check the machinery when a live run has just failed.
  if (mode === 'live') {
    const codex = await codexReadiness();
    if (!codex.installed) {
      throw new Error(
        'The Codex agent runtime is not installed on this computer, so a live run cannot start. ' +
          'Ask whoever set this machine up to install the Codex command-line tool and sign in to it — ' +
          'there is no key to paste anywhere. ' +
          'A practice run works without it and costs nothing.'
      );
    }
    if (codex.auth === 'signed_out') {
      throw new Error(
        'Codex is installed on this computer but nobody has signed in to it, so a live run has ' +
          'nothing to work with. Open a Terminal window and run: codex login. It is a one-off — ' +
          'the sign-in stays on this computer and nothing here ever asks for it again. ' +
          'A practice run works without it and costs nothing.'
      );
    }
    // auth === 'unknown' deliberately proceeds: we could not read the sign-in file, and
    // guessing "signed out" would refuse to start on a machine that is actually fine.
    // The CLI itself will say no, clearly, within seconds of the first stage.
  }

  // ---- charters are pinned into the run manifest so the run is reproducible ----
  const charters = {};
  const charterShas = {};
  for (const s of STAGES) {
    const c = loadCharter(s.charter);
    charters[s.id] = c;
    charterShas[s.id] = c.sha;
  }

  const policyText = readConfigFile('editorial-policy.md');
  const weightsText = readConfigFile('weights.yaml');
  const outletsText = readConfigFile('outlets.he.yaml');

  // ---- run directory ----
  let runId, dir;
  if (opts.resumeRunId) {
    runId = opts.resumeRunId;
    dir = path.join(runsDir, runId);
    if (!fs.existsSync(dir)) throw new Error(`cannot resume, no such run: ${dir}`);
  } else {
    const created = createRun({
      slug: opts.slug ?? (mode === 'replay' ? 'replay' : 'run'),
      runsDir,
      config: {
        mode,
        fixture: fixtureDir ? path.relative(process.cwd(), fixtureDir) : null,
        policy_sha: sha256(policyText),
        weights_sha: sha256(weightsText),
        outlets_sha: sha256(outletsText),
      },
      charterShas,
      // S10 is an agent, not an API call: it draws with whatever free or local tooling it
      // can find on this machine and records honestly when it cannot draw at all. Nothing
      // names a renderer for it, so nothing may claim one here — 10_render.json records
      // what actually produced each draft, and that is the only honest answer.
      models: { reasoning: model, image: 'agent-selected' },
    });
    runId = created.runId;
    dir = created.dir;
  }

  // Announced before the first event so a caller (the review server) can hand the run id
  // to the browser and start streaming while stage 1 is still spinning up.
  opts.onStart?.({ runId, dir, resumed: !!opts.resumeRunId });

  const bus = new EventBus(dir);
  if (opts.onEvent) bus.onEvent(opts.onEvent);

  bus.emit('run.start', { run_id: runId, mode, model, from: opts.from ?? null, concurrency });

  const todo = stagesFrom(opts.from);
  const summary = [];
  let failed = null;
  let awaitingHuman = false;
  let cancelled = false;

  for (const stage of todo) {
    // Cancellation is checked between stages: a stage in flight is allowed to finish
    // writing its artifact rather than leaving a half-written run directory behind.
    if (opts.signal?.aborted) {
      cancelled = true;
      bus.emit('stage.progress', { stage: stage.id, message: 'stopped by the editor before this stage started' });
      break;
    }

    // Resume: a stage whose artifact already validates is not re-run.
    if (opts.from && stageAlreadyGood(dir, stage)) {
      bus.emit('stage.end', { stage: stage.id, label: stage.id, ok: true, skipped: true, reason: 'artifact already valid' });
      summary.push({ stage: stage.id, ok: true, skipped: true });
      continue;
    }

    if (stage.humanCheckpoint && mode === 'live' && !opts.autoApprove) {
      bus.emit('human.required', {
        stage: stage.id,
        message:
          'Editorial approval required. Approve, request a revision, or reject each candidate ' +
          'on the Approval step, then press Export briefs. The pipeline never approves itself.',
      });
      awaitingHuman = true;
      break;
    }

    const ctx = buildCharterContext({ stage, dir, runId, policyText, weightsText, outletsText });

    const result = stage.fanout
      ? await runFannedStage({ stage, dir, bus, model, mode, fixtureDir, charters, ctx, concurrency })
      : await runStage({
          stage,
          runDir: dir,
          bus,
          model,
          mode,
          fixtureDir,
          charter: renderCharter(charters[stage.id].text, ctx),
        });

    summary.push({ stage: stage.id, ok: result.ok, durationMs: result.durationMs, errors: result.errors });

    if (!result.ok) {
      failed = { stage: stage.id, errors: result.errors };
      break;
    }
  }

  const status = cancelled
    ? 'cancelled'
    : failed
      ? 'failed'
      : awaitingHuman
        ? 'awaiting_human'
        : 'complete';
  bus.emit('run.end', { run_id: runId, status, failed_stage: failed?.stage ?? null });
  finalizeRun(dir, status, { stage_summary: summary });
  bus.close();

  return { runId, dir, status, summary, failed };
}

/** A fanned-out stage: independent shards run in PARALLEL, then merge, then validate as one. */
async function runFannedStage({ stage, dir, bus, model, mode, fixtureDir, charters, ctx, concurrency }) {
  // Replay short-circuits: the snapshot holds the already-merged artifact.
  if (mode === 'replay') {
    return runStage({ stage, runDir: dir, bus, model, mode, fixtureDir, charter: '(replay)' });
  }

  const sourcePath = path.join(dir, stage.fanout.from);
  if (!fs.existsSync(sourcePath)) {
    return { ok: false, errors: [`fan-out source missing: ${stage.fanout.from}`] };
  }
  const shards = stage.fanout.select(readJson(sourcePath));
  if (!shards.length) {
    return { ok: false, errors: [`fan-out produced zero shards from ${stage.fanout.from}`] };
  }

  bus.emit('stage.progress', { stage: stage.id, message: `fanning out ${shards.length} shards`, shards: shards.length });

  const tasks = shards.map((shard) => async () => {
    const shardStage = {
      ...stage,
      slug: `${stage.slug}.part-${safeKey(shard.key)}`,
      artifact: `${stage.slug}.part-${safeKey(shard.key)}.json`,
    };
    const shardCharter = renderCharter(charters[stage.id].text, {
      ...ctx,
      shard_key: shard.key,
      shard_label: shard.label,
      shard_context: shard.ctx,
      artifact_name: shardStage.artifact,
      evidence_name: `${shardStage.slug}.evidence.jsonl`,
    });
    return runStage({
      stage: shardStage,
      runDir: dir,
      bus,
      model,
      mode,
      charter: shardCharter,
      label: `${stage.id}:${shard.label}`,
    });
  });

  const results = await parallelLimit(concurrency, tasks);
  const okResults = results.filter((r) => r?.ok);

  if (!okResults.length) {
    return { ok: false, errors: [`all ${shards.length} shards failed`, ...(results[0]?.errors ?? [])] };
  }
  if (okResults.length < shards.length) {
    // A failed shard is a RECORDED GAP, not a silent omission.
    bus.emit('stage.progress', {
      stage: stage.id,
      message: `${shards.length - okResults.length} of ${shards.length} shards failed; continuing with partial coverage`,
      degraded: true,
    });
  }

  // ---- merge ----
  const parts = okResults.map((r) => r.artifact);
  const envelope = {
    schema_version: '1.0',
    stage: parts[0].stage,
    run_id: path.basename(dir),
    generated_at: new Date().toISOString(),
    agent: { model, charter_sha: charters[stage.id].sha, attempt: 1 },
  };
  const merged = stage.fanout.merge(parts, envelope);
  writeJsonAtomic(path.join(dir, stage.artifact), merged);

  // ---- concatenate shard evidence into the stage evidence log ----
  const evOut = evidencePath(dir, stage.slug);
  fs.writeFileSync(evOut, '', 'utf8');
  for (const shard of shards) {
    const partEv = evidencePath(dir, `${stage.slug}.part-${safeKey(shard.key)}`);
    if (fs.existsSync(partEv)) fs.appendFileSync(evOut, fs.readFileSync(partEv, 'utf8'));
  }

  const check = validateStageOutput({
    artifactFile: path.join(dir, stage.artifact),
    evFile: evOut,
    stage,
  });

  if (!check.ok) {
    bus.emit('stage.error', { stage: stage.id, label: stage.id, errors: check.errors.slice(0, 12) });
    return { ok: false, errors: check.errors };
  }

  bus.emit('artifact.write', {
    stage: stage.id,
    label: stage.id,
    artifact: stage.artifact,
    merged_from: okResults.length,
    evidence_records: check.evidence.recordCount,
  });
  bus.emit('stage.end', { stage: stage.id, label: stage.id, ok: true, shards: okResults.length });
  return { ok: true, artifact: check.data };
}

function buildCharterContext({ stage, dir, runId, policyText, weightsText, outletsText }) {
  return {
    run_id: runId,
    stage_id: stage.id,
    stage_title: stage.title,
    artifact_name: stage.artifact,
    evidence_name: `${stage.slug}.evidence.jsonl`,
    contract_json: readContract(stage.contract),
    operating_rules: evidencePreamble(stage),
    input_artifacts: (stage.dependsOn ?? [])
      .map((id) => STAGES.find((s) => s.id === id)?.artifact)
      .filter(Boolean)
      .join(', ') || '(none — you are the first stage)',
    editorial_policy: policyText,
    weights_yaml: weightsText,
    outlets_yaml: outletsText,
    ledger_digest: JSON.stringify(recentLedgerDigest(40), null, 2),
    today: new Date().toISOString().slice(0, 10),
    // Fan-out stages overwrite these per shard.
    shard_key: '(not a fanned-out stage)',
    shard_label: '(not a fanned-out stage)',
    shard_context: '{}',
  };
}

function stageAlreadyGood(dir, stage) {
  const artifactFile = path.join(dir, stage.artifact);
  if (!fs.existsSync(artifactFile)) return false;
  return validateStageOutput({ artifactFile, evFile: evidencePath(dir, stage.slug), stage }).ok;
}

function safeKey(k) {
  return String(k).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 48);
}

/**
 * Re-validate every artifact present in a run directory against its contract.
 * This is the standalone audit — it does not care how the artifacts got there.
 */
export function verifyRun(runDirOrLatest) {
  const target =
    runDirOrLatest === '--latest' || !runDirOrLatest ? latestRun()?.dir : path.resolve(runDirOrLatest);
  if (!target || !fs.existsSync(target)) throw new Error(`no run directory found: ${runDirOrLatest ?? '(latest)'}`);

  const rows = [];
  for (const stage of STAGES) {
    const artifactFile = path.join(target, stage.artifact);
    if (!fs.existsSync(artifactFile)) {
      rows.push({ stage: stage.id, present: false, ok: null, errors: [] });
      continue;
    }
    const r = validateStageOutput({ artifactFile, evFile: evidencePath(target, stage.slug), stage });
    rows.push({
      stage: stage.id,
      present: true,
      ok: r.ok,
      errors: r.errors,
      evidence: r.evidence ? { records: r.evidence.recordCount, refs: r.evidence.refCount } : null,
    });
  }
  return { dir: target, rows, ok: rows.every((r) => r.ok !== false) };
}

export { FIXTURES_DIR };
