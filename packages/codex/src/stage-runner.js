import fs from 'node:fs';
import path from 'node:path';
import {
  validateArtifact,
  checkEvidenceContract,
  readJson,
  evidencePath,
  sha256,
} from '@carica/core';
import { runCodex } from './exec.js';

/**
 * Runs ONE pipeline stage as an autonomous Codex agent, bounded by three things
 * the agent cannot negotiate:
 *
 *   1. INPUT contract   — it reads only what the charter grants it.
 *   2. OUTPUT contract  — the file it writes must validate against its JSON Schema.
 *   3. EVIDENCE contract— every evidence_id it cites must resolve to a real fetch
 *                         or command in <stage>.evidence.jsonl.
 *
 * Inside those bounds it picks its own approach and tools. On failure it is
 * re-invoked WITH THE VALIDATION ERRORS, which is far more effective than
 * re-prompting blind.
 */

const MAX_ATTEMPTS = 3; // 1 initial + 2 retries

/**
 * @param {{
 *   stage: {id: string, slug: string, artifact: string, contract: string, network?: boolean,
 *           writableRoots?: string[], timeoutMs?: number},
 *   runDir: string,
 *   charter: string,
 *   model: string,
 *   bus: {emit: (t: string, p?: any) => any},
 *   mode?: 'live'|'replay',
 *   fixtureDir?: string,
 *   label?: string
 * }} o
 */
export async function runStage(o) {
  const { stage, runDir, bus, model } = o;
  const label = o.label ?? stage.id;
  const artifactFile = path.join(runDir, stage.artifact);
  const evFile = evidencePath(runDir, stage.slug);
  const started = Date.now();

  bus.emit('stage.start', { stage: stage.id, label, mode: o.mode ?? 'live', artifact: stage.artifact });

  if (o.mode === 'replay') {
    return replayStage({ ...o, artifactFile, evFile, label, started });
  }

  let lastErrors = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const prompt = attempt === 1 ? o.charter : withValidationFeedback(o.charter, lastErrors, stage);

    bus.emit('agent.spawn', { stage: stage.id, label, attempt, model, network: !!stage.network });

    const res = await runCodex({
      prompt,
      cwd: runDir,
      model,
      // A net-marked stage does its own fetching and scraping; the sandbox mode that
      // grants it is chosen in one place, buildCodexArgs(). Nothing here needs a key:
      // the CLI carries its own sign-in and no credential crosses into the child.
      network: stage.network,
      writableRoots: stage.writableRoots,
      timeoutMs: stage.timeoutMs ?? 15 * 60_000,
      onLine: (line, parsed) => {
        // Surface agent progress to the React app without dumping the whole transcript.
        if (parsed?.type) {
          bus.emit('agent.output', { stage: stage.id, label, attempt, kind: parsed.type });
        }
        appendTranscript(runDir, stage.slug, line);
      },
    });

    if (res.timedOut) {
      lastErrors = [`stage timed out after ${(stage.timeoutMs ?? 900000) / 1000}s`];
      bus.emit('agent.retry', { stage: stage.id, label, attempt, reason: 'timeout' });
      continue;
    }
    if (res.code !== 0) {
      lastErrors = [`codex exited ${res.code}`, res.stderr.slice(-1500)];
      bus.emit('agent.retry', { stage: stage.id, label, attempt, reason: 'nonzero_exit' });
      continue;
    }

    const check = validateStageOutput({ artifactFile, evFile, stage });
    if (check.ok) {
      const durationMs = Date.now() - started;
      bus.emit('artifact.write', {
        stage: stage.id,
        label,
        artifact: stage.artifact,
        bytes: fs.statSync(artifactFile).size,
        evidence_records: check.evidence.recordCount,
        evidence_refs: check.evidence.refCount,
      });
      bus.emit('stage.end', { stage: stage.id, label, ok: true, attempt, durationMs });
      return { ok: true, artifact: check.data, attempt, durationMs };
    }

    lastErrors = check.errors;
    bus.emit('agent.retry', {
      stage: stage.id,
      label,
      attempt,
      reason: 'contract_violation',
      errors: check.errors.slice(0, 8),
    });
  }

  const durationMs = Date.now() - started;
  bus.emit('stage.error', { stage: stage.id, label, errors: lastErrors.slice(0, 12), durationMs });
  return { ok: false, errors: lastErrors, durationMs };
}

/**
 * Offline path: copy a frozen snapshot into the run directory and validate it
 * exactly as a live agent's output would be validated. This is what the Phase 0
 * gate exercises — no network, no cost, but the full contract machinery.
 */
function replayStage(o) {
  const { stage, bus, fixtureDir, artifactFile, evFile, label, started } = o;
  const srcArtifact = path.join(fixtureDir, stage.artifact);
  const srcEvidence = path.join(fixtureDir, `${stage.slug}.evidence.jsonl`);

  if (!fs.existsSync(srcArtifact)) {
    const durationMs = Date.now() - started;
    bus.emit('stage.error', {
      stage: stage.id,
      label,
      errors: [`fixture missing: ${path.relative(process.cwd(), srcArtifact)}`],
      durationMs,
    });
    return { ok: false, errors: [`fixture missing: ${srcArtifact}`], durationMs };
  }

  // Rewrite run_id so the replayed artifact belongs to THIS run, not the snapshot's.
  const data = readJson(srcArtifact);
  data.run_id = path.basename(o.runDir);
  fs.writeFileSync(artifactFile, JSON.stringify(data, null, 2) + '\n', 'utf8');
  if (fs.existsSync(srcEvidence)) fs.copyFileSync(srcEvidence, evFile);

  const check = validateStageOutput({ artifactFile, evFile, stage });
  const durationMs = Date.now() - started;

  if (!check.ok) {
    bus.emit('stage.error', { stage: stage.id, label, errors: check.errors.slice(0, 12), durationMs });
    return { ok: false, errors: check.errors, durationMs };
  }

  bus.emit('artifact.write', {
    stage: stage.id,
    label,
    artifact: stage.artifact,
    bytes: fs.statSync(artifactFile).size,
    evidence_records: check.evidence.recordCount,
    evidence_refs: check.evidence.refCount,
  });
  bus.emit('stage.end', { stage: stage.id, label, ok: true, attempt: 1, durationMs, replay: true });
  return { ok: true, artifact: check.data, attempt: 1, durationMs };
}

/** Schema + evidence, in that order. Both must pass. */
export function validateStageOutput({ artifactFile, evFile, stage }) {
  if (!fs.existsSync(artifactFile)) {
    return { ok: false, errors: [`agent did not write ${stage.artifact}`], evidence: { recordCount: 0, refCount: 0 } };
  }

  let data;
  try {
    data = readJson(artifactFile);
  } catch (err) {
    return { ok: false, errors: [`${stage.artifact} is not valid JSON: ${err.message}`], evidence: { recordCount: 0, refCount: 0 } };
  }

  const schema = validateArtifact(stage.contract, data);
  const evidence = checkEvidenceContract(data, evFile);

  const errors = [
    ...schema.errors.map((e) => `schema: ${e}`),
    ...evidence.errors.map((e) => `evidence: ${e}`),
  ];

  // A stage whose whole job is to gather external facts, that gathered none, has not
  // failed loudly — it has failed silently, which is worse. An empty evidence log here
  // means every number in the artifact came from the model's head.
  if (stage.requiresEvidence && evidence.recordCount === 0) {
    errors.push(
      `evidence: ${stage.id} sources external facts but wrote no evidence records. ` +
        `Every figure in ${stage.artifact} would be unsourced.`
    );
  }

  return { ok: errors.length === 0, errors, data, evidence };
}

/** Re-prompt carrying the exact failures. Blind retries mostly reproduce the same mistake. */
function withValidationFeedback(charter, errors, stage) {
  return [
    charter,
    '',
    '---',
    '',
    '## RETRY — your previous attempt was REJECTED',
    '',
    `Your previous \`${stage.artifact}\` did not satisfy its contract. The failures were:`,
    '',
    ...errors.slice(0, 25).map((e) => `- ${e}`),
    '',
    'Fix every one of these. Do not change anything else about your approach.',
    'If a failure is an unsourced claim, you must either fetch real evidence for it and',
    'record it in the evidence log, or remove the claim. Do not invent an evidence record.',
  ].join('\n');
}

function appendTranscript(runDir, slug, line) {
  try {
    fs.appendFileSync(path.join(runDir, `${slug}.transcript.jsonl`), line + '\n', 'utf8');
  } catch {
    /* transcript is diagnostic only; never fail a stage over it */
  }
}

export { sha256 };
