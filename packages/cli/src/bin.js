#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { listRuns, readCheckpoint, resumePoints } from '@carica/core';
import { runPipeline, verifyRun, STAGES } from '@carica/pipeline';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const HELP = `
${C.bold('carica')} — political caricature synthesis pipeline

${C.bold('The app is the product.')} ${C.dim('`npm start` opens it; everything below is also a button in it.')}
${C.dim('This CLI exists for automation, CI and debugging — an editor never needs it.')}

${C.bold('USAGE')}
  carica start                 Open the app (build if needed, serve, open a browser)
  carica serve [--port n]      Review app + live SSE event stream
  carica run [options]         Run the pipeline headlessly
  carica verify [dir|--latest] Re-validate a run's artifacts against their contracts
  carica list                  List runs
  carica stages                Show the stage graph

${C.bold('RUN OPTIONS')}
  --replay <dir>       Offline run from a frozen fixture snapshot. No network, no cost.
  --from <stage>       Resume from a stage, reusing artifacts that still validate.
                       A fanned-out step resumes shard by shard: a harvest that got
                       14 of 18 outlets re-fetches 4 and keeps the 14.
  --run <run-id>       Resume into an existing run directory (use with --from).
  --retry-killed       On a resumed run, re-attempt the jobs somebody stopped on
                       purpose. Off by default: a killed shard left no artifact, so
                       every other signal says redo it, and only the control log
                       knows a person decided otherwise.
  --slug <name>        Label for the run directory.
  --concurrency <n>    Parallel shards for fanned-out stages (default 8).
  --only <a,b,c>       Harvest only these outlets (id, English or Hebrew name).
  --seed-from <run>    Start at --from, carrying earlier results over from this run/snapshot.
  --model <name>       Reasoning model (default $CARICA_CODEX_MODEL, else Codex's own).
  --auto-approve       Skip the human checkpoint. TESTING ONLY — never for a run that ships.
  --quiet              Only print the summary.

${C.bold('BEFORE A LIVE RUN')}
  ${C.dim('There is no API key, here or anywhere in this project. Every step runs as a')}
  ${C.dim('`codex exec` agent and the Codex CLI carries its own sign-in:')}
      codex login              ${C.dim('once per machine')}
  ${C.dim('A --replay run needs none of that — no runtime, no sign-in, no network, no bill.')}

${C.bold('EXAMPLES')}
  carica run --replay fixtures/2026-08-11_sample
  carica run --slug tuesday-column
  carica run --only ynet,haaretz,mako_n12   ${C.dim('three outlets instead of eighteen')}
  carica run --from score --run 2026-08-15T09-00-00Z_tuesday-column
  carica run --from harvest --run <id> --retry-killed        ${C.dim('and redo what you stopped')}
  carica run --from cluster --seed-from 2026-08-11_sample   ${C.dim('skip the fetching')}
  carica verify --latest

${C.dim('Pausing and killing individual jobs while a run is going is an interactive concern')}
${C.dim('and lives only in the app. This CLI can start, continue and inspect a run.')}
`;

async function main() {
  const cmd = process.argv[2];
  const rest = process.argv.slice(3);

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    return 0;
  }

  if (cmd === 'stages') {
    console.log('');
    for (const s of STAGES) {
      const tags = [
        s.network ? C.yellow('net') : C.dim('no-net'),
        s.fanout ? C.cyan('fan-out') : '',
        s.freshContext ? C.cyan('fresh-context') : '',
        s.humanCheckpoint ? C.red('human checkpoint') : '',
      ]
        .filter(Boolean)
        .join(' ');
      console.log(`  ${C.bold(`S${String(s.n).padStart(2, '0')}`)} ${s.id.padEnd(9)} ${s.blurb.padEnd(48)} ${tags}`);
    }
    console.log('');
    return 0;
  }

  if (cmd === 'list') {
    const runs = listRuns();
    if (!runs.length) {
      console.log(C.dim('  no runs yet'));
      return 0;
    }
    console.log('');
    for (const r of runs) {
      const st = r.manifest?.status ?? '?';
      console.log(`  ${statusColor(st)(st.padEnd(15))} ${r.runId}`);
      // One small read per run, which is the entire reason state.json exists: answering
      // "where could this be picked up?" from events.ndjson would mean folding a log of tens
      // of thousands of lines, thirty times over, to print one line each. A run with no
      // checkpoint — an older one, or one that never got going — simply says nothing here.
      const note = [resumeHint(r.dir), r.manifest?.cancelled_reason].filter(Boolean).join(' · ');
      if (note) console.log(`  ${' '.repeat(15)} ${C.dim(note)}`);
    }
    console.log('');
    return 0;
  }

  if (cmd === 'serve' || cmd === 'start') {
    const { values } = parseArgs({
      args: rest,
      options: {
        port: { type: 'string' },
        host: { type: 'string' },
        verbose: { type: 'boolean' },
        open: { type: 'boolean' },
        'no-open': { type: 'boolean' },
        build: { type: 'boolean' },
      },
      allowPositionals: false,
    });
    // 4317 is the IANA-registered OTLP/gRPC port: any machine running an OpenTelemetry
    // collector already has it, and `carica start` would lose the race. 4318 is OTLP/HTTP
    // and no better. 4417 is clear of both.
    const port = values.port ? Number(values.port) : 4417;
    const host = values.host ?? '127.0.0.1';

    const fsMod = await import('node:fs');
    const pathMod = await import('node:path');
    const { REPO_ROOT } = await import('@carica/core');
    const distIndex = pathMod.join(REPO_ROOT, 'packages', 'web', 'dist', 'index.html');

    // `carica start` is the one command a non-technical user may ever be shown, so it
    // must be self-sufficient: build the app if it is missing, serve it, open it.
    if ((cmd === 'start' || values.build) && !fsMod.existsSync(distIndex)) {
      console.log(`  ${C.dim('building the app (first run only)…')}`);
      const { spawnSync } = await import('node:child_process');
      const r = spawnSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
      if (r.status !== 0) {
        console.error(`\n  ${C.red('the app failed to build')} — run ${C.bold('npm install')} and try again\n`);
        return 1;
      }
    }

    const { startServer } = await import('@carica/server');
    await startServer({ port, host, logger: !!values.verbose });

    const url = `http://${host}:${port}`;
    console.log(`\n  ${C.bold('carica')}  ${C.cyan(url)}`);
    if (!fsMod.existsSync(distIndex)) {
      console.log(
        `  ${C.yellow('app not built')} — API and SSE are live. For the UI run:\n` +
          `    ${C.dim('npm run dev --workspace @carica/web')}   ${C.dim('(dev server, proxies /api here)')}\n` +
          `    ${C.dim('npm start')}                            ${C.dim('(build once, then serve)')}`
      );
    }

    const wantOpen = values.open || (cmd === 'start' && !values['no-open']);
    if (wantOpen) await openBrowser(url);

    console.log(`  ${C.dim('ctrl-c to stop')}\n`);
    await new Promise(() => {}); // serve until interrupted
    return 0;
  }

  if (cmd === 'verify') {
    const target = rest[0] ?? '--latest';
    const { dir, rows, ok } = verifyRun(target);
    console.log(`\n  ${C.bold('verify')} ${C.dim(dir)}\n`);
    for (const r of rows) {
      if (!r.present) {
        console.log(`  ${C.dim('·')} ${r.stage.padEnd(9)} ${C.dim('not present')}`);
        continue;
      }
      if (r.ok) {
        const ev = r.evidence ? C.dim(`${r.evidence.records} evidence records, ${r.evidence.refs} refs`) : '';
        console.log(`  ${C.green('✓')} ${r.stage.padEnd(9)} ${ev}`);
      } else {
        console.log(`  ${C.red('✗')} ${r.stage.padEnd(9)}`);
        for (const e of r.errors.slice(0, 6)) console.log(`      ${C.red(e)}`);
        if (r.errors.length > 6) console.log(C.dim(`      … ${r.errors.length - 6} more`));
      }
    }
    console.log('');
    console.log(ok ? C.green('  all present artifacts satisfy their contracts') : C.red('  CONTRACT VIOLATIONS'));
    // Verifying a run is usually the prelude to deciding what to do about it, so the answer
    // to "and where would it pick up?" belongs on the same screen. It comes from state.json,
    // which is a cache: absent means nothing more than that this run predates it, or never
    // wrote one. Nothing above depends on it.
    const hint = resumeHint(dir);
    if (hint) console.log(`  ${C.dim(hint)}`);
    console.log('');
    return ok ? 0 : 1;
  }

  if (cmd === 'run') {
    const { values } = parseArgs({
      args: rest,
      options: {
        replay: { type: 'string' },
        from: { type: 'string' },
        run: { type: 'string' },
        slug: { type: 'string' },
        concurrency: { type: 'string' },
        only: { type: 'string' },
        'seed-from': { type: 'string' },
        model: { type: 'string' },
        'auto-approve': { type: 'boolean' },
        'retry-killed': { type: 'boolean' },
        quiet: { type: 'boolean' },
      },
      allowPositionals: false,
    });

    const onEvent = values.quiet ? undefined : printEvent;

    const res = await runPipeline({
      replay: values.replay,
      from: values.from,
      resumeRunId: values.run,
      slug: values.slug,
      concurrency: values.concurrency ? Number(values.concurrency) : undefined,
      allowlist: values.only,
      seedFrom: values['seed-from'],
      model: values.model,
      autoApprove: values['auto-approve'],
      retryKilled: values['retry-killed'],
      onEvent,
    });

    console.log('');
    console.log(`  ${C.bold('run')} ${res.runId}  ${statusLabel(res.status)}`);
    console.log(`  ${C.dim(res.dir)}`);
    // A cancelled run is a normal outcome — somebody pressed stop — so it says why and it
    // exits 0. Printing it as a failure would blame the machine for an editorial decision
    // and, in CI, would turn a deliberate stop into a broken build.
    if (res.status === 'cancelled' && res.reason) {
      console.log(`  ${C.dim(res.reason)}`);
    }
    if (res.failed) {
      console.log(`\n  ${C.red(`stage ${res.failed.stage} failed:`)}`);
      for (const e of (res.failed.errors ?? []).slice(0, 10)) console.log(`    ${C.red(e)}`);
    }
    const hint = resumeHint(res.dir);
    if (hint && res.status !== 'complete') console.log(`\n  ${C.dim(hint)}`);
    console.log('');
    return res.status === 'failed' ? 1 : 0;
  }

  console.error(`unknown command: ${cmd}`);
  console.log(HELP);
  return 2;
}

/**
 * How a run's outcome is coloured — and the one distinction that matters here.
 *
 * `cancelled` is not a failure. It is the machine reporting that it did exactly what a
 * person told it to do: somebody stopped a step, or the whole run, on purpose. Painting it
 * red says the pipeline broke, which is untrue, and buries the one useful fact — that the
 * work is still on disk and can be picked up. Only `failed` is red.
 */
function statusColor(status) {
  if (status === 'complete') return C.green;
  if (status === 'failed') return C.red;
  return C.yellow; // running, awaiting_human, cancelled, or a status this build has not met
}

/** The same outcome, in words rather than a status token. */
function statusLabel(status) {
  const words =
    status === 'awaiting_human'
      ? 'awaiting human approval'
      : status === 'cancelled'
        ? 'stopped'
        : status;
  return statusColor(status)(words);
}

/**
 * Where a run could be picked up, read from its `state.json`.
 *
 * Cheap by construction — one small file, already written — which is the only reason this
 * belongs in `list`, where it is done once per run. It is a CACHE and is treated as one:
 * unreadable, absent or written by an older build all mean the same thing, which is that
 * this run says nothing about resuming. Nothing here recomputes it from the events; that is
 * the app's job, and it costs a fold of the whole log.
 */
function resumeHint(dir) {
  const cp = readCheckpoint(dir);
  if (!cp) return null;
  const points = resumePoints(cp);
  if (!points.length) return null;
  // The step people actually want is the first one that has not finished — "the next thing
  // to do", which deriveMilestones deliberately includes. A run with no such step is simply
  // finished, and saying "resumable from publish" about it would be technically true and
  // useless; what is worth knowing there is only that any of it could be re-run.
  const next = points.find((p) => {
    const st = cp.stages?.[p.stage]?.status;
    return st !== 'ok' && st !== 'skipped';
  });
  const killed = cp.control?.killed_jobs?.length ?? 0;
  const parts = [
    next
      ? `continue from ${next.stage} — carica run --from ${next.stage} --run ${cp.run_id ?? '<id>'}`
      : `nothing left to do; any of ${points.length} steps could be re-run`,
  ];
  if (killed) parts.push(`${killed} job${killed === 1 ? '' : 's'} you stopped (--retry-killed to try again)`);
  return parts.join(' · ');
}

/** Open the default browser. Best-effort: a failure here is a printed URL, not an error. */
async function openBrowser(url) {
  const { spawn } = await import('node:child_process');
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* the URL is on screen either way */
  }
}

/** One terminal line, whatever the agent pasted into it. */
function clipLine(s, n = 96) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function printEvent(e) {
  switch (e.type) {
    case 'run.start':
      console.log(`\n  ${C.bold('carica')} ${C.dim(e.run_id)}  ${C.dim(`[${e.mode}]`)}\n`);
      break;
    case 'stage.start':
      process.stdout.write(`  ${C.cyan('▸')} ${e.label.padEnd(22)} ${C.dim(e.artifact ?? '')}\n`);
      break;
    case 'stage.progress':
      console.log(`    ${C.dim(e.message ?? '')}`);
      break;
    case 'agent.spawn':
      console.log(`    ${C.dim(`agent ${e.label ?? e.stage} attempt ${e.attempt}${e.network ? ' [net]' : ''}`)}`);
      break;
    case 'agent.activity': {
      // A live stage runs for minutes. Without this the terminal shows one line and then
      // nothing at all, which is indistinguishable from a hang.
      if (e.kind === 'thinking') break;
      const shard = typeof e.label === 'string' && e.label.includes(':') ? `${e.label.split(':').slice(1).join(':')} ` : '';
      const mark =
        e.status === 'failed' ? C.red('✕') : e.status === 'started' ? C.dim('·') : C.dim('✓');
      const verb = { command: '$', search: '⌕', file: 'wrote', message: '»', tool: '⚙', plan: '☰' }[e.kind] ?? e.kind;
      const tail = e.exit_code != null && e.exit_code !== 0 ? C.red(` exit ${e.exit_code}`) : '';
      console.log(`      ${mark} ${C.dim(shard)}${C.dim(verb)} ${clipLine(e.text)}${tail}`);
      break;
    }
    case 'agent.retry':
      console.log(`    ${C.yellow(`retry ${e.attempt} — ${e.reason}`)}`);
      for (const err of (e.errors ?? []).slice(0, 3)) console.log(`      ${C.dim(err)}`);
      break;
    case 'artifact.write':
      if (e.carried_over_from) {
        console.log(
          `  ${C.dim('↳')} ${C.dim((e.stage ?? '').padEnd(22))} ${C.dim(`${e.artifact} carried over from ${e.carried_over_from}`)}`
        );
        break;
      }
      console.log(
        `    ${C.green('wrote')} ${e.artifact} ${C.dim(
          [
            e.merged_from ? `merged from ${e.merged_from} shards` : null,
            e.evidence_records != null ? `${e.evidence_records} evidence records` : null,
          ]
            .filter(Boolean)
            .join(', ')
        )}`
      );
      break;
    case 'stage.error':
      console.log(`    ${C.red('FAILED')}`);
      for (const err of (e.errors ?? []).slice(0, 6)) console.log(`      ${C.red(err)}`);
      break;
    case 'human.required':
      console.log(`\n  ${C.yellow('⏸ human checkpoint')} — ${e.message}\n`);
      break;
    default:
      break;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`\n  ${C.red('error:')} ${err.message}\n`);
    process.exit(1);
  });
