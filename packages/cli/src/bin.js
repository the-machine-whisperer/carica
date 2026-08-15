#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { listRuns } from '@carica/core';
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
  --run <run-id>       Resume into an existing run directory (use with --from).
  --slug <name>        Label for the run directory.
  --concurrency <n>    Parallel shards for fanned-out stages (default 4).
  --model <name>       Reasoning model (default $CARICA_CODEX_MODEL or gpt-5-codex).
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
  carica run --from score --run 2026-08-15T09-00-00Z_tuesday-column
  carica verify --latest
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
      const color = st === 'complete' ? C.green : st === 'failed' ? C.red : C.yellow;
      console.log(`  ${color(st.padEnd(15))} ${r.runId}`);
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
    const port = values.port ? Number(values.port) : 4317;
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
    console.log(ok ? C.green('  all present artifacts satisfy their contracts\n') : C.red('  CONTRACT VIOLATIONS\n'));
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
        model: { type: 'string' },
        'auto-approve': { type: 'boolean' },
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
      model: values.model,
      autoApprove: values['auto-approve'],
      onEvent,
    });

    console.log('');
    const statusLine =
      res.status === 'complete'
        ? C.green('complete')
        : res.status === 'awaiting_human'
          ? C.yellow('awaiting human approval')
          : C.red('failed');
    console.log(`  ${C.bold('run')} ${res.runId}  ${statusLine}`);
    console.log(`  ${C.dim(res.dir)}`);
    if (res.failed) {
      console.log(`\n  ${C.red(`stage ${res.failed.stage} failed:`)}`);
      for (const e of (res.failed.errors ?? []).slice(0, 10)) console.log(`    ${C.red(e)}`);
    }
    console.log('');
    return res.status === 'failed' ? 1 : 0;
  }

  console.error(`unknown command: ${cmd}`);
  console.log(HELP);
  return 2;
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
    case 'agent.retry':
      console.log(`    ${C.yellow(`retry ${e.attempt} — ${e.reason}`)}`);
      for (const err of (e.errors ?? []).slice(0, 3)) console.log(`      ${C.dim(err)}`);
      break;
    case 'artifact.write':
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
