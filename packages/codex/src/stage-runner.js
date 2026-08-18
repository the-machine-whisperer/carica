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
 * Everything that identifies this unit of work, on every event it emits.
 *
 * `label` is what a human reads (`harvest:Ynet`) and is emitted exactly as it always has
 * been — old run directories and the shipped UI both key off it, and rewriting history is
 * not on the table. `job_id` is what a *machine* addresses (`harvest:ynet`, the shard KEY),
 * which is what "pause that one" needs and what a display label cannot safely be, because a
 * label is chosen for readability and can collide or change.
 */
function jobTag(o, stage, label, jobId) {
  const tag = { stage: stage.id, label, job_id: jobId };
  if (o.shardKey) {
    tag.shard_key = o.shardKey;
    tag.shard_label = o.shardLabel ?? o.shardKey;
  }
  return tag;
}

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
 *   label?: string,
 *   jobId?: string,
 *   shardKey?: string,
 *   shardLabel?: string,
 *   jobs?: ReturnType<import('./jobs.js').createJobRegistry>
 * }} o
 */
export async function runStage(o) {
  const { stage, runDir, bus, model } = o;
  const label = o.label ?? stage.id;
  const jobId = o.jobId ?? stage.id;
  const jobs = o.jobs ?? null;
  const tag = jobTag(o, stage, label, jobId);
  const artifactFile = path.join(runDir, stage.artifact);
  const evFile = evidencePath(runDir, stage.slug);
  const started = Date.now();

  // Killed while it was queued. Nothing ran, so nothing is being interrupted: this stage
  // does not start, does not emit stage.start, and is recorded as declined rather than as
  // an error or a kill. `job.skipped` is the true account of what happened.
  if (jobs?.isKilled(jobId)) {
    jobs.markSkipped(jobId, { stage: stage.id, reason: 'stopped before it started' });
    return { ok: false, skipped: true, killed: true, errors: ['stopped by the editor'], durationMs: 0 };
  }

  bus.emit('stage.start', { ...tag, mode: o.mode ?? 'live', artifact: stage.artifact });

  if (o.mode === 'replay') {
    return replayStage({ ...o, artifactFile, evFile, label, tag, started });
  }

  let lastErrors = [];
  // WHY the failure happened, not just that it did. A contract violation means the agent
  // ran and produced something wrong — there is a previous attempt to critique. A process
  // failure means the agent never ran at all, and re-prompting it with "your artifact did
  // not satisfy its contract" is a fabricated premise that sends it looking for a mistake
  // it did not make.
  let lastFailure = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Checked before EVERY attempt, not just the first: a kill that lands during attempt 1
    // must not be answered by attempt 2. The retry loop exists to fix a bad artifact; a
    // kill is the editor saying "stop doing this", and retrying it twice is the opposite of
    // what they asked for.
    if (jobs?.isKilled(jobId)) return endKilled(attempt - 1);

    const prompt =
      lastFailure === 'contract' ? withValidationFeedback(o.charter, lastErrors, stage) : o.charter;

    bus.emit('agent.spawn', { ...tag, attempt, model, network: !!stage.network });

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
      // The registry is told about the pid synchronously, before the first byte of output,
      // so a pause or a kill issued a millisecond after the spawn still has something to
      // signal. Without the registry (a plain run, every existing caller) this is a no-op.
      onSpawn: (child, controls) => {
        jobs?.register(jobId, { stage: stage.id, label, key: o.shardKey ?? null, child, controls });
      },
      // Killed between attempts: do not spawn at all.
      abort: jobs ? { get aborted() { return jobs.isKilled(jobId); }, reason: 'stopped by the editor' } : undefined,
      onLine: (line, parsed) => {
        // Surface agent progress to the React app without dumping the whole transcript.
        // A bare event type ("item.completed") tells a watcher nothing about whether the
        // agent is fetching Ynet's feed or stuck re-reading its own schema, so carry the
        // detail: the command, the search, the file, the sentence.
        const activity = parsed ? summariseAgentEvent(parsed) : null;
        if (activity) {
          bus.emit('agent.activity', { ...tag, attempt, ...activity });
        } else if (parsed?.type) {
          bus.emit('agent.output', { ...tag, attempt, kind: parsed.type });
        }
        appendTranscript(runDir, stage.slug, line);
      },
      // Codex writes its own diagnostics here. They are not part of the JSON event stream,
      // so without this they never reach the run directory at all.
      onStderr: (chunk) => appendTranscript(runDir, stage.slug, `[stderr] ${chunk.trimEnd()}`),
    });

    // The pid is gone; the intent record (killed / not killed) stays behind in the registry.
    jobs?.unregister(jobId);

    // A killed agent exits non-zero, exactly like a broken one, so this test comes FIRST.
    // Read the other way round, "the editor stopped this" would be reported to the operator
    // as "the agent runtime exited 143 without writing 02_harvest.json" and then retried.
    if (res.killed || jobs?.isKilled(jobId)) return endKilled(attempt);

    if (res.timedOut || res.code !== 0) {
      lastErrors = describeProcessFailure(res, stage);
      lastFailure = 'process';
      bus.emit('agent.retry', {
        ...tag,
        attempt,
        reason: res.timedOut ? 'timeout' : 'nonzero_exit',
        errors: lastErrors.slice(0, 8),
      });
      continue;
    }

    const check = validateStageOutput({ artifactFile, evFile, stage });
    if (check.ok) {
      const durationMs = Date.now() - started;
      bus.emit('artifact.write', {
        ...tag,
        artifact: stage.artifact,
        bytes: fs.statSync(artifactFile).size,
        evidence_records: check.evidence.recordCount,
        evidence_refs: check.evidence.refCount,
      });
      bus.emit('stage.end', { ...tag, ok: true, attempt, durationMs });
      return { ok: true, artifact: check.data, attempt, durationMs };
    }

    lastErrors = check.errors;
    lastFailure = 'contract';
    bus.emit('agent.retry', {
      ...tag,
      attempt,
      reason: 'contract_violation',
      errors: check.errors.slice(0, 8),
    });
  }

  const durationMs = Date.now() - started;
  bus.emit('stage.error', { ...tag, errors: lastErrors.slice(0, 12), durationMs });
  return { ok: false, errors: lastErrors, durationMs };

  /**
   * Close the stage out as stopped-on-purpose.
   *
   * No `stage.error`: a kill is not a failure of the agent, it is an instruction that was
   * carried out, and putting it in the error channel would light up a red banner over a
   * button the editor themself pressed. The registry has already emitted `job.killed` with
   * the reason; `stage.end` carries `ok:false, killed:true` so a projection can render the
   * stage as stopped rather than as broken.
   */
  function endKilled(attempt) {
    const durationMs = Date.now() - started;
    jobs?.unregister(jobId);
    bus.emit('stage.end', { ...tag, ok: false, killed: true, attempt, durationMs });
    return { ok: false, killed: true, errors: ['stopped by the editor'], attempt, durationMs };
  }
}

/**
 * Offline path: copy a frozen snapshot into the run directory and validate it
 * exactly as a live agent's output would be validated. This is what the Phase 0
 * gate exercises — no network, no cost, but the full contract machinery.
 */
function replayStage(o) {
  const { stage, bus, fixtureDir, artifactFile, evFile, started } = o;
  // Replay is unchanged in behaviour — same copy, same validation, same order. It only
  // gains the identity fields, so an offline run's event log reads exactly like a live
  // one's to anything downstream.
  const tag = o.tag ?? { stage: stage.id, label: o.label ?? stage.id, job_id: o.jobId ?? stage.id };
  const srcArtifact = path.join(fixtureDir, stage.artifact);
  const srcEvidence = path.join(fixtureDir, `${stage.slug}.evidence.jsonl`);

  if (!fs.existsSync(srcArtifact)) {
    const durationMs = Date.now() - started;
    bus.emit('stage.error', {
      ...tag,
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
    bus.emit('stage.error', { ...tag, errors: check.errors.slice(0, 12), durationMs });
    return { ok: false, errors: check.errors, durationMs };
  }

  bus.emit('artifact.write', {
    ...tag,
    artifact: stage.artifact,
    bytes: fs.statSync(artifactFile).size,
    evidence_records: check.evidence.recordCount,
    evidence_refs: check.evidence.refCount,
  });
  bus.emit('stage.end', { ...tag, ok: true, attempt: 1, durationMs, replay: true });
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

// ---------------------------------------------------------------- live activity

const MAX_TEXT = 300;
const MAX_OUTPUT = 400;

function clip(s, n = MAX_TEXT) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Codex runs everything through `/bin/bash -lc "…"`. The wrapper is noise; the command is not. */
export function tidyCommand(cmd) {
  const raw = String(cmd ?? '').trim();
  const m = raw.match(/^\S*(?:bash|sh|zsh)\s+-[a-z]*c\s+([\s\S]*)$/);
  let inner = m ? m[1].trim() : raw;
  const q = inner[0];
  if ((q === '"' || q === "'") && inner.endsWith(q)) inner = inner.slice(1, -1);
  return clip(inner, 200);
}

const fileName = (p) => String(p ?? '').split(/[\\/]/).pop() || String(p ?? '');

/**
 * One line of the `codex exec --json` stream → one thing a human can watch happen.
 *
 * Returns null for events with nothing to show (lifecycle chatter, an `item.started` whose
 * payload is not populated yet). Everything it does return is already truncated: this ends
 * up in events.ndjson, which is the run's permanent record, not a debug firehose.
 */
export function summariseAgentEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;

  if (ev.type === 'turn.completed') {
    const u = ev.usage ?? {};
    const total = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
    if (!total) return null;
    return {
      kind: 'usage',
      status: 'completed',
      text: `${total.toLocaleString('en-US')} tokens`,
      usage: {
        input: u.input_tokens ?? 0,
        cached: u.cached_input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        reasoning: u.reasoning_output_tokens ?? 0,
      },
    };
  }

  if (ev.type !== 'item.started' && ev.type !== 'item.completed') return null;

  const item = ev.item ?? {};
  const status = ev.type === 'item.started' ? 'started' : 'completed';
  const item_id = item.id ?? null;

  switch (item.type) {
    case 'command_execution': {
      const failed = status === 'completed' && item.exit_code != null && item.exit_code !== 0;
      return {
        kind: 'command',
        status: failed ? 'failed' : status,
        item_id,
        text: tidyCommand(item.command),
        exit_code: status === 'completed' ? (item.exit_code ?? null) : null,
        output: status === 'completed' ? clip(item.aggregated_output, MAX_OUTPUT) || null : null,
      };
    }

    case 'web_search': {
      // `item.started` arrives with an empty query — there is nothing to show yet.
      const queries = item.action?.queries?.length ? item.action.queries : item.query ? [item.query] : [];
      if (!queries.length) return null;
      return {
        kind: 'search',
        status,
        item_id,
        text: clip(queries.join(' · ')),
        queries: queries.slice(0, 6).map((q) => clip(q, 120)),
      };
    }

    case 'file_change': {
      if (status !== 'completed') return null;
      const changes = item.changes ?? [];
      if (!changes.length) return null;
      const files = changes.slice(0, 8).map((c) => fileName(c.path));
      return { kind: 'file', status, item_id, text: files.join(', '), files };
    }

    case 'agent_message': {
      if (status !== 'completed') return null;
      const text = clip(item.text, 400);
      return text ? { kind: 'message', status, item_id, text } : null;
    }

    case 'reasoning': {
      if (status !== 'completed') return null;
      const text = clip(item.text ?? item.summary, 240);
      return text ? { kind: 'thinking', status, item_id, text } : null;
    }

    case 'mcp_tool_call': {
      const text = clip([item.server, item.tool].filter(Boolean).join(' · '));
      return text ? { kind: 'tool', status, item_id, text } : null;
    }

    case 'todo_list': {
      if (status !== 'completed') return null;
      const items = (item.items ?? []).map((i) => (typeof i === 'string' ? i : i?.text)).filter(Boolean);
      return items.length ? { kind: 'plan', status, item_id, text: clip(items.join(' · ')) } : null;
    }

    default:
      return null;
  }
}

/**
 * Why did `codex exec` fail?
 *
 * Under `--json` — which every stage passes — **stdout is the JSONL event stream and that is
 * where Codex reports failure**: a `turn.failed` event carrying `error.message`, or a bare
 * `error` event. stderr generally holds nothing but operational chatter. Reporting stderr
 * alone (what this used to do) therefore threw away the one thing that says what went wrong
 * and left the operator with a bare exit code and a red herring.
 */
export function extractCodexError(stdout) {
  const found = [];
  for (const line of String(stdout ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const msg =
      (typeof ev?.error === 'string' ? ev.error : ev?.error?.message) ??
      (ev?.type === 'error' || ev?.type === 'stream_error' ? ev.message : null);
    if (msg) found.push(unwrapNestedError(msg));
  }
  return [...new Set(found)]; // all three attempts fail identically; say it once
}

/**
 * Codex hands the upstream API's error body through verbatim, so `message` is often itself
 * a JSON document with the sentence a human needs buried two levels down. Dig it out —
 * `{"type":"error","status":400,"error":{"message":"..."}}` should read as that message.
 */
function unwrapNestedError(msg) {
  let cur = String(msg).trim();
  for (let depth = 0; depth < 4 && cur.startsWith('{'); depth++) {
    let parsed;
    try {
      parsed = JSON.parse(cur);
    } catch {
      break;
    }
    const inner =
      (typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.message) ?? parsed?.message;
    if (typeof inner !== 'string' || !inner.trim()) break;
    const status = parsed?.status ?? parsed?.error?.status;
    cur = inner.trim();
    if (!cur.startsWith('{') && status) return `${status} — ${cur}`;
  }
  return cur;
}

/**
 * Codex announces that it is reading a prompt from stdin whenever stdin is not a terminal —
 * which it never is here, because we spawn it. It is not an error, but it IS the last line
 * on stderr, so a naive stderr tail surfaces it as the cause of the failure. It is not.
 */
const BENIGN_STDERR = [/^Reading additional input from stdin/i, /^Reading prompt from stdin/i];

export function meaningfulStderr(stderr) {
  const lines = String(stderr ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !BENIGN_STDERR.some((re) => re.test(l)));
  return lines.length ? lines.join(' | ').slice(-1500) : null;
}

/** The agent runtime failed before any artifact existed. Say what actually happened. */
export function describeProcessFailure(res, stage) {
  const out = [];
  out.push(
    res.timedOut
      ? `the agent was still running after ${(stage.timeoutMs ?? 900000) / 1000}s and was stopped`
      : `the agent runtime exited ${res.code} without writing ${stage.artifact}`
  );

  const reported = extractCodexError(res.stdout);
  for (const msg of reported.slice(-3)) out.push(`agent runtime: ${msg}`);

  const stderrTail = meaningfulStderr(res.stderr);
  if (stderrTail) out.push(`stderr: ${stderrTail}`);

  // Nothing structured and nothing on stderr — show the tail of what it did print, rather
  // than reporting a bare exit code and calling it a day.
  if (!reported.length && !stderrTail) {
    const tail = String(res.stdout ?? '').trim().split('\n').slice(-5).join(' | ').slice(-1500);
    out.push(tail ? `last output: ${tail}` : 'the agent runtime printed nothing at all');
  }

  out.push(`full transcript: ${stage.slug}.transcript.jsonl in the run folder`);
  return out;
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
