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
  readEvents,
  deriveCheckpoint,
  writeCheckpoint,
  sha256,
} from '@carica/core';
import { runStage, validateStageOutput, codexReadiness, createJobRegistry } from '@carica/codex';
import { STAGES, STAGE_META, stagesFrom } from './stages.js';
import { loadCharter, renderCharter, readContract, readConfigFile, evidencePreamble } from './charter.js';
import { parallelLimit, PAUSE_POLL_MS } from './limit.js';
import { createControlApplier, createCheckpointer } from './control.js';
import { resolveAllowlist, narrowOutletsYaml, narrowsRanking, MIN_RANKED_OUTLETS } from './allowlist.js';

/**
 * How many shards of a fanned-out stage run at once.
 *
 * Every shard is an independent `codex exec` that spends nearly all its wall-clock waiting
 * on a network fetch or a model round trip — not on this machine's CPU. At 4, an 18-outlet
 * harvest is five sequential waves and the run is dominated by queueing. The cap exists to
 * stay inside the sign-in's rate limits, so it belongs somewhere well above the number of
 * cores and well below the number of outlets.
 */
const DEFAULT_CONCURRENCY = 8;

/**
 * @param {{
 *   from?: string, slug?: string, replay?: string, runsDir?: string,
 *   concurrency?: number, model?: string, autoApprove?: boolean,
 *   resumeRunId?: string, seedFrom?: string, allowlist?: string|string[],
 *   retryKilled?: boolean,
 *   onEvent?: (e:any)=>void,
 *   onStart?: (info: {runId: string, dir: string, resumed: boolean}) => void,
 *   onControlReady?: (applyControl: (record: any) => any) => void,
 *   signal?: {aborted: boolean}
 * }} opts
 *
 * Two of these options exist only because a run is something a person watches:
 *
 * `onControlReady` is handed the run's control applier the moment there is a run to control.
 * The worker uses it to feed in records that arrive over IPC; nothing else needs it, because
 * every other route into a run goes through `control.ndjson`, which this reads by itself.
 *
 * `retryKilled` decides what a CONTINUED run does about jobs somebody stopped on purpose.
 * Default false, and the default is the important half: a killed shard left no artifact, so
 * every signal on disk except the control log says it still needs doing, and re-running it
 * would spend money undoing an editorial decision. True is the explicit "I killed that by
 * mistake" case.
 */
export async function runPipeline(opts = {}) {
  const mode = opts.replay ? 'replay' : 'live';
  const runsDir = opts.runsDir ?? RUNS_DIR;
  // No default model, deliberately.
  //
  // This pinned `gpt-5-codex`, which a ChatGPT sign-in is not entitled to: every live run
  // died on `400 invalid_request_error — The 'gpt-5-codex' model is not supported when
  // using Codex with a ChatGPT account`, three attempts a stage, before anything fetched.
  // The project's whole premise is that the Codex CLI carries its own sign-in; naming a
  // model here overrides the one choice that sign-in is guaranteed to be able to honour.
  // Left null, `buildCodexArgs()` omits `--model` and the CLI uses its own default.
  const model = opts.model ?? process.env.CARICA_CODEX_MODEL ?? null;
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

  // ---- the editor's allowlist ----
  //
  // Resolved once, here, against the registry on disk, so a typo is caught before a run
  // directory exists rather than by an agent halfway through step 2. `outlets_sha` below
  // stays the sha of the FILE — the allowlist is a property of this run, not of the
  // registry, and conflating them would make two runs of the same registry look different.
  const { ids: allowlist, unknown: unknownAllowlist } = resolveAllowlist(opts.allowlist, outletsText);
  if (unknownAllowlist.length && !allowlist.length) {
    throw new Error(
      `None of the outlets you asked for are in the registry: ${unknownAllowlist.join(', ')}. ` +
        `Check config/outlets.he.yaml for the ids in use, or leave the list empty to use every outlet.`
    );
  }

  // Below the ranking floor the allowlist cannot narrow S1 without making its artifact
  // fail its own contract — so it narrows the harvest only. See MIN_RANKED_OUTLETS.
  const narrowRanking = narrowsRanking(allowlist);
  const charterOutletsText = narrowRanking ? narrowOutletsYaml(outletsText, allowlist) : outletsText;

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
        allowlist: allowlist.length ? allowlist : null,
        // Provenance: this run did not do the steps before `from` — another one did.
        seeded_from: opts.seedFrom ? String(opts.seedFrom) : null,
        started_at_stage: opts.from ?? null,
      },
      charterShas,
      // S10 is an agent, not an API call: it draws with whatever free or local tooling it
      // can find on this machine and records honestly when it cannot draw at all. Nothing
      // names a renderer for it, so nothing may claim one here — 10_render.json records
      // what actually produced each draft, and that is the only honest answer.
      models: { reasoning: model ?? 'codex-default', image: 'agent-selected' },
    });
    runId = created.runId;
    dir = created.dir;
  }

  // Announced before the first event so a caller (the review server) can hand the run id
  // to the browser and start streaming while stage 1 is still spinning up.
  opts.onStart?.({ runId, dir, resumed: !!opts.resumeRunId });

  const bus = new EventBus(dir);
  if (opts.onEvent) bus.onEvent(opts.onEvent);

  // state.json — the cheap read the runs list and the resume picker live on. Built before
  // anything can go wrong, so that even a run that dies in its first second leaves one
  // behind: a run with no checkpoint is a row on the home screen that has to be recovered
  // the expensive way, and the expensive way is what this exists to avoid.
  const checkpoint = createCheckpointer({ dir, bus });

  bus.emit('run.start', {
    run_id: runId,
    mode,
    model,
    from: opts.from ?? null,
    concurrency,
    allowlist: allowlist.length ? allowlist : null,
  });

  // Everything the allowlist did, said once, in the run's own log. An editor who restricts
  // a run and then sees an outlet they did not ask for — or does not see one they did —
  // must be able to find out why here rather than by reading the artifacts.
  if (allowlist.length) {
    bus.emit('stage.progress', {
      stage: 'outlets',
      message: narrowRanking
        ? `restricted to ${allowlist.length} outlets you allowed: ${allowlist.join(', ')}`
        : `${allowlist.length} outlets allowed — fewer than the ${MIN_RANKED_OUTLETS} a ranking needs, so step 1 still ranks the whole registry and only the harvest is narrowed`,
      allowlist,
    });
  }
  if (unknownAllowlist.length) {
    bus.emit('stage.progress', {
      stage: 'outlets',
      message: `not in the registry, so not used: ${unknownAllowlist.join(', ')}`,
    });
  }

  // ---- carry earlier results over from another run ----
  //
  // Steps 1 and 2 are the expensive half of the pipeline: they are the only ones that fan
  // out to an agent per outlet, and they are the ones that go to the open web. Re-reading
  // this morning's news to try a different rubric is waste. Seeding copies the artifacts
  // BEFORE `from` out of a finished run (or a fixture) and starts here — after checking
  // each one against its contract, because starting a run on results that do not validate
  // is how you get a failure five steps later with no obvious cause.
  if (opts.seedFrom) {
    if (!opts.from) throw new Error('Carrying results over needs a step to start at.');
    if (opts.resumeRunId) {
      throw new Error(
        'Continuing a run and carrying results over from another one are different things — ' +
          'a run being continued already has its earlier results.'
      );
    }
    const sourceDir = resolveSeedSource(opts.seedFrom, runsDir);
    const seeded = seedEarlierStages({ dir, fromId: opts.from, sourceDir, bus });
    if (seeded.problems.length) {
      bus.emit('run.end', { run_id: runId, status: 'failed', failed_stage: null });
      finalizeRun(dir, 'failed', { stage_summary: [] });
      checkpoint.write('run.end');
      bus.close();
      throw new Error(
        `Cannot start at ${opts.from} using ${path.basename(sourceDir)}:\n  ` + seeded.problems.join('\n  ')
      );
    }
  }

  // ---- the control plane ----
  //
  // Three things. The checkpoint is already built, above, because a run must leave one
  // behind even if it dies before it gets this far; the other two belong here, after the
  // last thing that can refuse to start.
  //
  // The REGISTRY is the only thing that knows which pid belongs to which job, so it is what
  // a pause or a kill ultimately acts on. Its events go into this run's log like any other,
  // which is what makes "why was Ynet never harvested" answerable months later.
  //
  // The CHECKPOINT (built above, with the bus) is wired to the registry's `onChange`, so a
  // shard being killed updates state.json — throttled there, so eight shards finishing at
  // once is one write rather than eight.
  //
  // The APPLIER turns records into actions. It replays what the editor said before this
  // process existed, then follows the file for the rest of the run.
  const jobs = createJobRegistry({
    bus,
    onChange: () => checkpoint.write('job', { force: false }),
  });
  const control = createControlApplier({
    dir,
    bus,
    jobs,
    // Every applied instruction is a state change worth being able to read back in one go —
    // and the moment after an editor kills something is exactly when they refresh the page.
    onApplied: () => checkpoint.write('control', { force: true }),
  });

  const replayed = control.replayLog({ retryKilled: !!opts.retryKilled });
  if (replayed.count) {
    bus.emit('stage.progress', {
      message: opts.retryKilled
        ? `read ${replayed.count} earlier instruction${replayed.count === 1 ? '' : 's'} from this run — you asked for the jobs you stopped to be tried again`
        : `read ${replayed.count} earlier instruction${replayed.count === 1 ? '' : 's'} from this run; anything you stopped stays stopped`,
    });
  }
  control.follow();
  // Announced before the first stage: a record arriving over IPC one millisecond after the
  // server learned the run id must have somewhere to land. (It has a second route anyway —
  // the file — which is why a lost or late IPC message is a latency problem and not a
  // correctness one.)
  opts.onControlReady?.((record) => control.apply(record, { source: 'ipc' }));

  const todo = stagesFrom(opts.from);
  const summary = [];
  let failed = null;
  let awaitingHuman = false;
  let cancelled = false;
  let cancelReason = null;

  // A run being CONTINUED may find work from a previous attempt already on disk. That is
  // the whole point of continuing one, and it is also why a fresh run must never look:
  // a reused run directory with a stale `02_items.part-ynet.json` in it would be picked up
  // as this morning's harvest, and nothing downstream would ever notice.
  const isResume = !!(opts.resumeRunId || opts.from);

  for (const stage of todo) {
    // Cancellation is checked between stages: a stage in flight is allowed to finish
    // writing its artifact rather than leaving a half-written run directory behind.
    if (opts.signal?.aborted) {
      cancelled = true;
      cancelReason = 'stopped by the editor';
      bus.emit('stage.progress', { stage: stage.id, message: 'stopped by the editor before this stage started' });
      break;
    }

    // A held run holds BETWEEN steps as well as inside them. Pausing during step 4 and
    // coming back to find step 7 running would make the button a lie: the editor paused the
    // run, not the agent that happened to be in flight when they pressed it.
    await holdWhilePaused({ bus, control, jobs, signal: opts.signal, stage });

    // Checked after the hold, not before it: pausing a run and then stopping it is the
    // ordinary way an editor changes their mind, and the kill must not sit behind the pause.
    if (opts.signal?.aborted || control.isRunKilled()) {
      cancelled = true;
      cancelReason = control.runKillReason() ?? 'stopped by the editor';
      bus.emit('stage.progress', { stage: stage.id, message: 'stopped by the editor before this stage started' });
      break;
    }

    // Resume: a stage whose artifact already validates is not re-run.
    if (opts.from && stageAlreadyGood(dir, stage)) {
      bus.emit('stage.end', { stage: stage.id, label: stage.id, ok: true, skipped: true, reason: 'artifact already valid' });
      summary.push({ stage: stage.id, ok: true, skipped: true });
      checkpoint.write('stage.end');
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

    const ctx = buildCharterContext({
      stage, dir, runId, policyText, weightsText,
      // S1 is handed the narrowed registry when the allowlist is large enough to rank.
      outletsText: charterOutletsText,
    });

    // A stage that THROWS is still that stage's failure, and has to be reported as one.
    //
    // Everything below this line assumes a stage answers with `{ok, errors}`. A bug in the
    // pipeline's own code — not the agent's — answers by throwing instead, and an exception
    // here used to unwind straight out of `runPipeline`: no `stage.error`, no `run.end`,
    // `failed_stage: null`, the worker process dead with exit code 1 and an event log that
    // simply stopped mid-run. The app could then only say the run "exited unexpectedly",
    // which is true and useless — it names neither the step nor the reason, and the step it
    // could not name is the one the editor is looking at.
    //
    // Caught here, a crash becomes what it always should have been: this stage failed, this
    // is the message, the run stops for the ordinary reason that the next step has no
    // artifact to read. The stack goes to the event log too — a TypeError's message alone
    // ("Cannot read properties of undefined") does not say where, and this is the record
    // somebody debugs from later.
    let result;
    try {
      result = stage.fanout
        ? await runFannedStage({
            stage, dir, bus, model, mode, fixtureDir, charters, ctx, concurrency, allowlist,
            jobs, control, checkpoint, resume: isResume, signal: opts.signal,
          })
        : await runStage({
            stage,
            runDir: dir,
            bus,
            model,
            mode,
            fixtureDir,
            charter: renderCharter(charters[stage.id].text, ctx),
            // A plain stage IS its own job: `job_id === stage.id`, which is what makes
            // "pause step 4" and "pause this shard" the same instruction with two targets.
            jobs,
            jobId: stage.id,
          });
    } catch (err) {
      result = { ok: false, errors: describeStageCrash(err, stage) };
      bus.emit('stage.error', {
        stage: stage.id,
        label: stage.id,
        errors: result.errors,
        crash: true,
        stack: String(err?.stack ?? '').split('\n').slice(0, 12).join('\n') || null,
      });
    }

    summary.push({
      stage: stage.id,
      ok: result.ok,
      killed: result.killed ? true : undefined,
      durationMs: result.durationMs,
      errors: result.errors,
    });
    checkpoint.write('stage.end');

    if (!result.ok) {
      // FAILED and STOPPED are different endings and the difference matters to the person
      // reading it. A failure is the machine reporting that it could not do the work; a kill
      // is the machine reporting that it did exactly as it was told. Calling the second one
      // a failure paints a red banner over a button the editor themself pressed, and buries
      // the one useful fact — that the work is still there to be picked up.
      //
      // Either way the run stops here, and for a reason that has nothing to do with blame:
      // every later step reads this step's artifact, and there isn't one.
      if (result.killed) {
        cancelled = true;
        cancelReason = result.errors?.[0] ?? 'stopped by the editor';
        bus.emit('stage.progress', {
          stage: stage.id,
          message:
            `you stopped ${stage.title}, so the run stops here — the steps after it need its results. ` +
            `Continue this run from ${stage.title} when you are ready.`,
        });
        break;
      }
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

  // The run is over; nothing may be left suspended. A SIGSTOPped agent whose parent has
  // exited is a process that will never be scheduled again and never exit — the one piece of
  // wreckage this control plane could leave on the machine. Releasing them costs nothing
  // when there are none, which is nearly always.
  try {
    jobs.resumeAll('system');
  } catch {
    /* a registry that objects at closing time is not a reason to leave the run open */
  }
  control.stop();

  bus.emit('run.end', {
    run_id: runId,
    status,
    failed_stage: failed?.stage ?? null,
    reason: cancelled ? cancelReason : null,
  });
  finalizeRun(dir, status, {
    stage_summary: summary,
    ...(cancelled ? { cancelled_reason: cancelReason } : {}),
  });
  // Last, so state.json's own status matches the run.json beside it. This is the read the
  // runs list does thirty times over on the home screen; it should never be the stale one.
  checkpoint.write('run.end');
  bus.close();

  return { runId, dir, status, summary, failed, reason: cancelled ? cancelReason : null };
}

/**
 * A fanned-out stage: independent shards run in PARALLEL, then merge, then validate as one.
 *
 * Three things happen here that do not happen anywhere else in the pipeline, and all three
 * are about a stage being made of parts rather than being one indivisible thing:
 *
 * **A shard is addressable.** `job_id` is `<stage>:<shardKey>` — the key, not the display
 * label, because "pause that one" has to name something stable and a label is chosen for
 * readability. That id is what the editor's Kill button targets and what the registry
 * signals, so it is passed explicitly on every invocation; `shardStageFor()` deliberately
 * keeps `stage.id` as the parent's, since a shard satisfies the parent's contract.
 *
 * **A missing shard is a recorded gap, not a failure.** That was already true of a shard
 * that failed; it is now equally true of one the editor stopped. Both flow into the same
 * partial-coverage path, and the difference between them is reported rather than flattened.
 *
 * **A shard that already ran is not run again.** On a CONTINUED run, a part file that still
 * validates is reused where it lies. This is the difference between a harvest that died on
 * outlet 15 costing four more fetches and costing eighteen.
 *
 * Exported for the tests, which drive it directly: everything interesting here is a fan-out
 * of live agents, and reaching it through `runPipeline` would mean standing up eleven stages
 * to look at one. Nothing in the shipped system calls it from outside this file.
 *
 * @param {any} o
 */
export async function runFannedStage(o) {
  const { stage, dir, bus, model, mode, fixtureDir, charters, ctx, concurrency, allowlist } = o;
  const jobs = o.jobs ?? null;
  const control = o.control ?? null;
  const checkpoint = o.checkpoint ?? null;
  const signal = o.signal ?? null;

  // Replay short-circuits: the snapshot holds the already-merged artifact.
  if (mode === 'replay') {
    return runStage({ stage, runDir: dir, bus, model, mode, fixtureDir, charter: '(replay)', jobs, jobId: stage.id });
  }

  const sourcePath = path.join(dir, stage.fanout.from);
  if (!fs.existsSync(sourcePath)) {
    return { ok: false, errors: [`fan-out source missing: ${stage.fanout.from}`] };
  }
  const { shards, skipped, missing } = selectShards(stage, readJson(sourcePath), allowlist);

  // Allowed but never ranked. Not an error — an outlet can be dropped by S1 for a good
  // reason — but the editor asked for it, so the run must say it did not happen.
  if (missing?.length) {
    bus.emit('stage.progress', {
      stage: stage.id,
      message: `you allowed ${missing.join(', ')}, but step 1 did not rank ${missing.length === 1 ? 'it' : 'them'} — not harvested`,
      degraded: true,
    });
  }

  if (!shards.length) {
    return {
      ok: false,
      errors: [
        allowlist?.length
          ? `none of the outlets you allowed (${allowlist.join(', ')}) came through step 1, so there is nothing to harvest`
          : `fan-out produced zero shards from ${stage.fanout.from}`,
      ],
    };
  }

  bus.emit('stage.progress', {
    stage: stage.id,
    message: skipped?.length
      ? `fanning out ${shards.length} shards — ${skipped.length} ranked outlets skipped, not on your allowlist`
      : `fanning out ${shards.length} shards`,
    shards: shards.length,
  });

  const jobIdFor = (shard) => `${stage.id}:${shard.key}`;

  // ---- what this run does not have to do again ----
  //
  // Only on a CONTINUED run. A part file is written by exactly one shard invocation and is
  // never edited, so one that still satisfies the contract is as good as one written thirty
  // seconds ago — but only if it belongs to this run. A fresh run in a reused directory must
  // never adopt one, which is why this is gated rather than merely opportunistic.
  const reusable = shards.map((shard) =>
    o.resume ? shardPartAlreadyGood(dir, stage, shard.key) : null
  );
  const reusedCount = reusable.filter(Boolean).length;
  if (reusedCount) {
    bus.emit('stage.progress', {
      stage: stage.id,
      message:
        `${reusedCount} of ${shards.length} were already gathered by an earlier attempt at this run ` +
        `and are being reused as they are`,
      reused: reusedCount,
    });
  }

  const tasks = shards.map((shard, i) => async () => {
    const shardStage = shardStageFor(stage, shard.key);
    const jobId = jobIdFor(shard);
    const label = `${stage.id}:${shard.label}`;

    if (reusable[i]) {
      // No agent, no spawn, no cost — and said out loud, because a step that finishes in a
      // second when it took four minutes yesterday must explain itself or it looks broken.
      bus.emit('job.skipped', {
        stage: stage.id,
        job_id: jobId,
        label,
        shard_key: shard.key,
        shard_label: shard.label,
        artifact: shardStage.artifact,
        reason: 'already gathered',
      });
      return { ok: true, artifact: reusable[i], reused: true };
    }

    const shardCharter = renderCharter(charters[stage.id].text, shardContext(ctx, shardStage, shard));
    const res = await runStage({
      stage: shardStage,
      runDir: dir,
      bus,
      model,
      mode,
      charter: shardCharter,
      label,
      // The identity triple. `shardStageFor` keeps the parent's `stage.id`, so nothing below
      // can work out on its own which shard it is — it has to be told.
      jobId,
      shardKey: shard.key,
      shardLabel: shard.label,
      jobs,
    });
    // A shard finishing is a state change somebody may be watching, and there can be an
    // hour between the first and the last. Throttled: a wave of eight is one write.
    checkpoint?.write('shard.end', { force: false });
    return res;
  });

  const results = await parallelLimit(concurrency, tasks, {
    // A run-wide or stage-wide hold stops new shards being dispatched. It does NOT reach the
    // agents already running — the registry SIGSTOPs those — see the note in limit.js.
    // Both authorities are asked: the registry knows about every hold that was applied to
    // it, and the applier knows the run is held even in the corner where the two could
    // disagree (a registry that refused a pause it could not deliver).
    isPaused: jobs || control ? () => !!control?.isRunPaused() || !!jobs?.isPaused(stage.id) : undefined,
    // The kill that lands while a shard is still in the queue. This is the one the editor
    // cares about most: eighteen outlets, four at a time, and the fourteenth can be called
    // off before it costs anything at all.
    isCancelled: jobs ? (i) => jobs.isKilled(jobIdFor(shards[i])) : undefined,
    onSkip: jobs
      ? (i) => {
          jobs.markSkipped(jobIdFor(shards[i]), { stage: stage.id, reason: 'stopped before it started' });
          return { ok: false, killed: true, skipped: true, errors: ['stopped by the editor'] };
        }
      : undefined,
    signal,
  });

  const okResults = results.filter((r) => r?.ok);
  const killedResults = results.filter((r) => r && !r.ok && r.killed);
  const failedResults = results.filter((r) => r && !r.ok && !r.killed);
  // Nulls: shards this loop never reached because the whole run was being stopped.
  const unreached = results.filter((r) => r == null).length;

  if (!okResults.length) {
    // NOTHING CAME BACK. The run cannot continue either way — every later step reads this
    // step's artifact and there is no honest artifact to write — but WHY it cannot continue
    // is a different sentence depending on who decided, and only one of the two is a fault.
    if (!failedResults.length && (killedResults.length || unreached)) {
      const errors = killedResults.length
        ? [
            `you stopped ${killedResults.length === shards.length ? 'every piece' : 'every piece that was left'} ` +
              `of ${stage.title}, so it produced nothing to pass on`,
          ]
        : [`${stage.title} was stopped before any of its ${shards.length} pieces had started`];
      if (unreached && killedResults.length) {
        errors.push(`${unreached} more had not been started when the run was stopped`);
      }
      return { ok: false, killed: true, cancelled: true, errors };
    }
    return {
      ok: false,
      errors: [
        killedResults.length
          ? `${failedResults.length} of ${shards.length} shards failed and ${killedResults.length} were stopped, so none came through`
          : `all ${shards.length} shards failed`,
        ...(failedResults[0]?.errors ?? []),
      ],
    };
  }

  if (okResults.length < shards.length) {
    // A missing shard is a RECORDED GAP, not a silent omission — and a gap somebody asked
    // for reads differently from one the web handed us. Both are named.
    const gaps = [
      failedResults.length ? `${failedResults.length} failed` : null,
      killedResults.length ? `${killedResults.length} stopped by you` : null,
      unreached ? `${unreached} never started` : null,
    ].filter(Boolean);
    bus.emit('stage.progress', {
      stage: stage.id,
      message: `${shards.length - okResults.length} of ${shards.length} shards missing (${gaps.join(', ')}); continuing with partial coverage`,
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
    agent: { model: mergedModel(model, parts), charter_sha: charters[stage.id].sha, attempt: 1 },
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

/**
 * A crash in the pipeline's own code, said in the run's voice.
 *
 * Two audiences, one string list. The editor needs to know that this is not their doing and
 * not the agent's — retrying it will fail identically, which is exactly what "it refuses to
 * run" felt like from the outside — so that is said first, in words. Whoever fixes it needs
 * the error and the first frame that belongs to this project, so those follow verbatim.
 */
export function describeStageCrash(err, stage) {
  const message = String(err?.message ?? err ?? 'unknown error').trim();
  const out = [
    `${stage.title} could not run: the pipeline itself hit an error before the step could ` +
      `do any work. This is a defect in this app, not something wrong with your run or your ` +
      `settings — continuing will hit it again until it is fixed.`,
    `${err?.name ?? 'Error'}: ${message}`,
  ];

  // The first frame inside this project, which is the one that names the file to open.
  // node internals and node_modules frames are noise at the top of a stack.
  const frame = String(err?.stack ?? '')
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .find((l) => l.includes('/packages/') && !l.includes('node_modules'));
  if (frame) out.push(frame.replace(/^at\s+/, 'thrown at '));

  return out;
}

/**
 * What a fanned-out stage's `select` gave us, in ONE shape.
 *
 * There are two shapes in the registry and there always will be. Only the harvest can be
 * narrowed by the editor's allowlist, so only its `select` has anything to say about what it
 * left out — it answers `{shards, skipped, missing}`. Ideate, prompt and render have no such
 * question to answer and return a plain array of shards, which is the honest signature for
 * what they do.
 *
 * The allowlist work taught the call site to destructure, and it was only ever tested
 * through the harvest. On the three array-returning stages `shards` came back `undefined`
 * and the next line — `shards.length` — threw a TypeError out of `runPipeline` entirely.
 * Nothing in the event log, no failed stage, the whole run process gone with exit code 1:
 * the Concepts step "refusing to run" with nothing to read anywhere.
 *
 * So the shapes are reconciled here, once, before anything reads them. A stage may answer
 * either way; a new stage that returns a bare array cannot bring a run down again.
 */
export function selectShards(stage, source, allowlist) {
  const selected = stage.fanout.select(source, { allowlist });
  const norm = Array.isArray(selected) ? { shards: selected } : (selected ?? {});
  return {
    shards: norm.shards ?? [],
    skipped: norm.skipped ?? [],
    missing: norm.missing ?? [],
  };
}

/**
 * What to record as `agent.model` on a MERGED artifact.
 *
 * The merged envelope is written by this file, not by an agent, so it is held to the same
 * contract the agents are — and `agent.model` is a required **string**. `model` is null on
 * every run that does not name one, which is the normal case and deliberately so (see
 * `runPipeline`: naming a model overrides the one choice the CLI's sign-in is guaranteed to
 * honour). That null went straight into the envelope, so a fanned stage whose every shard
 * had already succeeded then failed its own schema check on `/agent/model must be string` —
 * three identical attempts, none of which an agent could have fixed, because the offending
 * field was never the agent's to write.
 *
 * What ran does not have to be guessed at. Each shard recorded the model it was, so: the
 * configured name when there is one, else the shards' own answer when they agree, else all
 * of them (they are provenance, and a run that spanned two models should say so), else the
 * `codex-default` sentinel the run manifest already uses for exactly this case.
 *
 * Agents answer this question in whatever case they feel like — one real run came back
 * `gpt-5`, `GPT-5` and `gpt-5.6` across six shards. Casing is not a disagreement, so it is
 * folded away and the first spelling seen is kept; `gpt-5.6` is a different claim and stays.
 */
export function mergedModel(model, parts) {
  if (typeof model === 'string' && model.trim()) return model.trim();
  const seen = new Map();
  for (const p of parts) {
    const m = p?.agent?.model;
    if (typeof m !== 'string' || !m.trim()) continue;
    const name = m.trim();
    if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  }
  return seen.size ? [...seen.values()].join(', ') : 'codex-default';
}

/**
 * Where "carry results over from" is allowed to point: a run directory, a fixture snapshot,
 * or an explicit path. Anything else is refused by name rather than by silently reading a
 * directory the editor did not mean.
 */
export function resolveSeedSource(seedFrom, runsDir = RUNS_DIR) {
  const raw = String(seedFrom ?? '').trim().replace(/\/+$/, '');
  if (!raw) throw new Error('No run to carry results over from.');

  const candidates = path.isAbsolute(raw)
    ? [raw]
    : [
        path.join(runsDir, raw),
        path.join(FIXTURES_DIR, raw),
        path.join(FIXTURES_DIR, path.basename(raw)),
        path.resolve(process.cwd(), raw),
      ];

  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
  }
  throw new Error(
    `No run or snapshot called "${raw}". Give a run id from the runs list, or the name of a practice snapshot.`
  );
}

/**
 * Copy every artifact before `fromId` out of `sourceDir` into this run.
 *
 * Two things make this honest rather than a shortcut:
 *   1. Every copied artifact is validated against its own contract here. A run that starts
 *      on unvalidated inputs fails later, somewhere confusing.
 *   2. `run_id` is rewritten to this run, exactly as a replayed stage does, so an artifact
 *      never claims to belong to a run it was not part of.
 *
 * The stages are reported as `skipped` in the event log — not as work this run did.
 */
export function seedEarlierStages({ dir, fromId, sourceDir, bus }) {
  const cut = STAGES.findIndex((s) => s.id === fromId);
  if (cut === -1) throw new Error(`unknown stage: ${fromId}`);

  const copied = [];
  const problems = [];
  const from = path.basename(sourceDir);

  for (const stage of STAGES.slice(0, cut)) {
    const srcArtifact = path.join(sourceDir, stage.artifact);
    if (!fs.existsSync(srcArtifact)) {
      problems.push(`${stage.title} has no ${stage.artifact} in ${from}`);
      continue;
    }

    let data;
    try {
      data = readJson(srcArtifact);
    } catch (err) {
      problems.push(`${stage.artifact} in ${from} is not readable JSON: ${err.message}`);
      continue;
    }
    data.run_id = path.basename(dir);
    writeJsonAtomic(path.join(dir, stage.artifact), data);

    const srcEvidence = evidencePath(sourceDir, stage.slug);
    if (fs.existsSync(srcEvidence)) fs.copyFileSync(srcEvidence, evidencePath(dir, stage.slug));

    const check = validateStageOutput({
      artifactFile: path.join(dir, stage.artifact),
      evFile: evidencePath(dir, stage.slug),
      stage,
    });
    if (!check.ok) {
      problems.push(`${stage.title}: ${check.errors.slice(0, 3).join('; ')}`);
      continue;
    }

    copied.push(stage.id);
    bus?.emit('artifact.write', {
      stage: stage.id,
      label: stage.id,
      artifact: stage.artifact,
      evidence_records: check.evidence.recordCount,
      evidence_refs: check.evidence.refCount,
      carried_over_from: from,
    });
    bus?.emit('stage.end', {
      stage: stage.id,
      label: stage.id,
      ok: true,
      skipped: true,
      reason: `carried over from ${from}`,
    });
  }

  return { copied, problems };
}

/** The stage a single shard believes it is: same contract, its own two files. */
export function shardStageFor(stage, key) {
  const slug = `${stage.slug}.part-${safeKey(key)}`;
  return { ...stage, slug, artifact: `${slug}.json` };
}

/**
 * The parent charter context, re-pointed at one shard's files.
 *
 * EVERY placeholder that names a file has to move together. The preamble is the one that
 * gets forgotten, and forgetting it is not a cosmetic slip: it is the half of the charter
 * headed "Non-negotiable operating rules", so an agent that reads a contradiction resolves
 * it in favour of the preamble, writes its evidence to the parent log, and is then failed
 * for citing evidence it really did gather. Keep this function the single place a shard's
 * filenames are decided.
 */
export function shardContext(ctx, shardStage, shard) {
  return {
    ...ctx,
    shard_key: shard.key,
    shard_label: shard.label,
    shard_context: shard.ctx,
    artifact_name: shardStage.artifact,
    evidence_name: `${shardStage.slug}.evidence.jsonl`,
    operating_rules: evidencePreamble(shardStage),
  };
}

/**
 * Every placeholder a charter can name, filled once per stage.
 *
 * Exported for the tests, which must build the context the same way the pipeline does. A
 * test that hand-rolls its own copy passes until somebody adds a placeholder here, and then
 * fails for a reason that has nothing to do with what it was testing.
 */
export function buildCharterContext({ stage, dir, runId, policyText, weightsText, outletsText }) {
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

/**
 * Did ONE SHARD of a fanned-out stage already come through, in an earlier attempt at this
 * same run? Returns the artifact if so, null otherwise.
 *
 * This is `stageAlreadyGood` at the resolution the work is actually done at, and it is the
 * whole of shard-level resume. A harvest that reached fourteen outlets of eighteen before
 * the machine went to sleep left fourteen part files behind; the stage as a whole never
 * validated, so the coarse check offers nothing, and every one of those fourteen fetches is
 * repeated. Asking the question per part instead turns that into four.
 *
 * The check is the SAME check the shard's own agent had to satisfy — schema and evidence,
 * through `shardStageFor`, against the parent's contract — because "it is on disk" is not
 * the question. A part half-written by an agent that was killed mid-write is on disk too,
 * and adopting one of those would put a fabricated gap into a merged artifact and call it
 * gathered. It fails validation, it is not reused, and the shard runs again.
 *
 * @returns {any|null} the validated artifact, ready to merge
 */
export function shardPartAlreadyGood(dir, stage, key) {
  const shardStage = shardStageFor(stage, key);
  const artifactFile = path.join(dir, shardStage.artifact);
  if (!fs.existsSync(artifactFile)) return null;
  const check = validateStageOutput({
    artifactFile,
    evFile: evidencePath(dir, shardStage.slug),
    stage: shardStage,
  });
  return check.ok ? check.data : null;
}

function safeKey(k) {
  return String(k).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 48);
}

/**
 * Hold between stages while the run is paused.
 *
 * The pause that matters to an editor is not "the agent that happens to be running stops" —
 * it is "the run stops". A hold that only reached inside a stage would let a run paused
 * during step 4 quietly start step 7, which is both a surprise and, on a live run, a bill.
 * So this sits in the loop next to the abort check, for the same reason that one does.
 *
 * Polled, and for the same reason the dispatch loop polls: the authority on "is this paused"
 * is a boolean somebody sets from an HTTP handler, and a poll of a boolean cannot miss an
 * edge. `signal.aborted` breaks the wait as well — a run being stopped must not be sitting
 * here being patient — and so does a run-wide kill, which is a decision that supersedes a
 * hold rather than queueing behind it.
 */
async function holdWhilePaused({ bus, control, jobs, signal, stage }) {
  // A hold on THIS STEP counts as well as a hold on the whole run. The registry would
  // suspend the agent a millisecond after it spawned anyway, and the outcome would look the
  // same on screen — but on a live run that millisecond is a `codex exec` process started
  // for work somebody has already said they do not want yet. Better not to start it.
  const held = () => !!control?.isRunPaused() || !!jobs?.isPaused(stage.id);
  if (!held()) return;

  bus.emit('stage.progress', {
    stage: stage.id,
    message: `held — ${stage.title} will start when you let it go`,
  });
  while (held() && !signal?.aborted && !control.isRunKilled()) {
    await new Promise((r) => setTimeout(r, PAUSE_POLL_MS));
  }
  if (!signal?.aborted && !control.isRunKilled()) {
    bus.emit('stage.progress', { stage: stage.id, message: `going again — starting ${stage.title}` });
  }
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

/**
 * Rebuild a run's `state.json` from its events, for a caller that is not the run itself.
 *
 * A live run keeps its own checkpoint current. This is for everybody else: the runs list
 * meeting a directory from before checkpoints existed, a run whose process was killed
 * between a stage ending and the write, someone who deleted the file to prove they could.
 * Deleting every state.json under runs/ must cost speed and no information at all, and this
 * is the function that makes that true.
 *
 * Never throws, for the same reason `readCheckpoint` never throws: a cache that can take
 * down the page it is supposed to make fast is not worth having.
 *
 * @param {string} runDir
 * @param {{write?: boolean}} [opts] `write: false` derives without touching the directory
 * @returns {any|null} the checkpoint, or null if the run has no readable events
 */
export function refreshRunCheckpoint(runDir, opts = {}) {
  try {
    const events = readEvents(path.join(runDir, 'events.ndjson'));
    if (!events.length) return null;
    let manifest = null;
    try {
      manifest = readJson(path.join(runDir, 'run.json'));
    } catch {
      /* a run with no readable manifest still has events, which is what matters */
    }
    const checkpoint = deriveCheckpoint(events, { manifest, stageMeta: STAGE_META });
    if (opts.write !== false) writeCheckpoint(runDir, checkpoint);
    return checkpoint;
  } catch {
    return null;
  }
}

export { FIXTURES_DIR };
