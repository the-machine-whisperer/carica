import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Codex CLI invocation — the ONE place this project talks to a model.
 *
 * Two rules govern this file:
 *
 * **1. This project holds no credentials.** There is no OpenAI key, no Similarweb key,
 * no bearer token, anywhere. Every stage is an autonomous `codex exec` agent and the
 * Codex CLI carries its own sign-in, made once with `codex login` and stored under
 * `$CODEX_HOME` (default `~/.codex`). The pipeline never reads, requires, injects,
 * validates or forwards a key — and to make that structural rather than aspirational,
 * anything credential-shaped in the environment is *stripped* on the way into the child
 * (see `childEnv`). The agent cannot leak what it was never given.
 *
 * **2. The flag set is centralised here on purpose.** `codex` is not installed on the
 * Linux box this was written on, so the exact flags have never been run. They live in
 * `buildCodexArgs()` alone so reconciling them against `codex exec --help` on the target
 * machine is a one-line correction, not an archaeology exercise. Nothing downstream
 * depends on the CLI's stdout shape — agents write files, and files are what get
 * validated.
 */

/** Sandbox mode for stages that must reach the open web (S1, S2, S6, S10). */
export const SANDBOX_NET = 'danger-full-access';
/** Sandbox mode for stages that only reason over artifacts already on disk. */
export const SANDBOX_OFFLINE = 'workspace-write';

/**
 * NETWORK — READ THIS BEFORE CHANGING THE SANDBOX MODE.
 *
 * Under Codex's `workspace-write` sandbox, **network access is off**. The four
 * net-marked stages do their own fetching and scraping — S1 reads free public ranking
 * pages, S2 harvests the outlets, S6 fact-checks against live sources, S10 goes looking
 * for something that can draw — so running any of them under `workspace-write` does not
 * produce an error, it produces a *quiet* stage that gathered nothing. `requiresEvidence`
 * catches that for S1/S2/S6 (an empty evidence log fails the stage); S10 has no such
 * backstop and would simply record a fallback and look like a bad news day.
 *
 * So net stages get `danger-full-access`, which turns the sandbox off outright and is the
 * one setting that needs no config-key spelling to be correct. If you would rather keep
 * the filesystem confined, `workspace-write` plus
 * `-c sandbox_workspace_write.network_access=true` is the narrower equivalent and is
 * already wired below — set CARICA_CODEX_SANDBOX_NET=workspace-write and it is used.
 */
function sandboxFor(o) {
  if (o.sandbox) return o.sandbox;
  if (o.network) return process.env.CARICA_CODEX_SANDBOX_NET || SANDBOX_NET;
  return process.env.CARICA_CODEX_SANDBOX_OFFLINE || SANDBOX_OFFLINE;
}

/**
 * @param {{prompt: string, cwd: string, model?: string, sandbox?: string, network?: boolean,
 *          writableRoots?: string[], extraArgs?: string[]}} o
 */
export function buildCodexArgs(o) {
  const args = ['exec'];
  args.push('--json');
  args.push('--cd', o.cwd);
  if (o.model) args.push('--model', o.model);

  const sandbox = sandboxFor(o);
  args.push('--sandbox', sandbox);

  if (sandbox === 'workspace-write') {
    // Only meaningful for the confined sandbox; `danger-full-access` already has both.
    if (o.network) args.push('-c', 'sandbox_workspace_write.network_access=true');
    // A stage whose deliverable lives outside its run directory — S11 appends to
    // history/ledger.jsonl — is otherwise silently denied the write.
    if (o.writableRoots?.length) {
      args.push('-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(o.writableRoots)}`);
    }
  }

  args.push('--skip-git-repo-check');
  if (o.extraArgs?.length) args.push(...o.extraArgs);
  args.push(o.prompt);
  return args;
}

/**
 * Does this environment variable look like a credential?
 *
 * Used to strip the child's environment. The project has no keys of its own, but the
 * operator's shell may well have some, and an agent that can see a key can spend it.
 * `CODEX_*` is left alone: that namespace belongs to the CLI's own authentication, which
 * is the one thing we deliberately do not touch.
 */
export function isCredentialEnvVar(name) {
  if (/^CODEX_/i.test(name)) return false;
  return /(API_?KEY|_TOKEN$|^TOKEN$|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i.test(name);
}

/**
 * The environment that crosses into `codex exec`: the operator's environment minus
 * anything credential-shaped. HOME, PATH, CODEX_HOME, TMPDIR and the rest survive, which
 * is everything the CLI needs to find its own sign-in.
 */
export function childEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (isCredentialEnvVar(k)) continue;
    env[k] = v;
  }
  // An explicit override is a deliberate act by the caller (tests), not an inherited secret.
  return { ...env, ...(extra ?? {}) };
}

export function codexBin(bin) {
  return bin ?? process.env.CARICA_CODEX_BIN ?? 'codex';
}

/**
 * Spawn one `codex exec` and stream its output.
 *
 * The agent's job is to WRITE its artifact file to the run directory — not to
 * return JSON in a chat message. That keeps large outputs off the stdout path
 * entirely and means we validate a real file, not a parse of a transcript.
 *
 * ADDRESSABILITY. A run is a thing an editor watches, and watching without being able to
 * intervene is a spectator sport. Three additions make a spawned agent reachable, none of
 * which change what a normal, uninterrupted call does:
 *
 *   - `onSpawn(child, controls)` fires synchronously the instant the process exists, so a
 *     job registry can record the pid before the first line of output arrives. `controls`
 *     carries `pauseTimer` / `resumeTimer` / `markKilled` (see below).
 *   - `abort` — any object with an `aborted` boolean (a getter is fine) — is checked BEFORE
 *     spawning. A job the editor killed while it was queued must not be started at all.
 *   - the resolved shape gains `killed` / `killReason`, because "the editor stopped this",
 *     "it ran out of time" and "it exited non-zero" are three different things that owe the
 *     operator three different sentences.
 *
 * THE TIMEOUT AND PAUSE. `timeoutMs` exists to catch an agent that has hung, and a paused
 * agent has not hung — it was SIGSTOPped on purpose by someone who intends to come back. So
 * the timer is not a fixed deadline from spawn: it is a budget of *running* time. Pausing
 * banks whatever is left of it and resuming re-arms exactly that much, which means a job
 * suspended over lunch resumes with all the time it started with and a genuinely stuck agent
 * is still stopped after its fifteen minutes of actually running.
 *
 * @param {{prompt: string, cwd: string, model?: string, network?: boolean,
 *          writableRoots?: string[], timeoutMs?: number,
 *          onLine?: (line: string, parsed: any|null) => void,
 *          onStderr?: (chunk: string) => void,
 *          onSpawn?: (child: any, controls: {pauseTimer: () => void, resumeTimer: () => void, markKilled: (reason?: string) => void}) => void,
 *          abort?: {aborted: boolean, reason?: string},
 *          bin?: string, env?: Record<string,string>}} o
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, timedOut: boolean,
 *                    killed: boolean, killReason: string|null, spawned: boolean}>}
 */
export function runCodex(o) {
  const bin = codexBin(o.bin);
  const args = buildCodexArgs(o);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killed = false;
    let killReason = null;

    // Killed while queued: never spawn it. Starting an agent the editor has already stopped
    // would burn tokens on work nobody wants and then have to be killed anyway.
    if (o.abort?.aborted) {
      resolve({
        code: null,
        stdout,
        stderr,
        timedOut: false,
        killed: true,
        killReason: o.abort.reason ?? 'stopped by the editor before it started',
        spawned: false,
      });
      return;
    }

    const child = spawn(bin, args, {
      cwd: o.cwd,
      env: childEnv(o.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // ---- the running-time budget (see the note about pause, above) ----
    let timer = null;
    let remainingMs = o.timeoutMs ?? 0;
    let armedAt = 0;

    const expire = () => {
      timer = null;
      remainingMs = 0;
      timedOut = true;
      try {
        child.kill('SIGTERM');
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }, 5000).unref();
      } catch {
        /* already gone */
      }
    };

    const armTimer = () => {
      if (timer || remainingMs <= 0) return;
      armedAt = Date.now();
      timer = setTimeout(expire, remainingMs);
    };
    const disarmTimer = (bank) => {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
      if (bank) remainingMs = Math.max(1, remainingMs - (Date.now() - armedAt));
    };

    const controls = {
      /** The job was suspended; stop the clock rather than call the pause a timeout. */
      pauseTimer: () => disarmTimer(true),
      resumeTimer: () => armTimer(),
      /** Somebody outside is about to signal this child on purpose. Record why. */
      markKilled: (reason) => {
        killed = true;
        killReason = reason ?? 'stopped by the editor';
        disarmTimer(false);
      },
    };

    armTimer();

    // Synchronous, before any output: the registry must be able to address this pid from
    // the moment it exists, not from the moment it first says something.
    try {
      o.onSpawn?.(child, controls);
    } catch {
      /* a registry that throws must not sink the agent it was registering */
    }

    let buf = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      buf += text;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let parsed = null;
        try {
          parsed = JSON.parse(line);
        } catch {
          /* codex may interleave non-JSON lines; pass them through raw */
        }
        o.onLine?.(line, parsed);
      }
    });

    child.stderr.on('data', (c) => {
      const text = c.toString();
      stderr += text;
      o.onStderr?.(text);
    });

    child.on('error', (err) => {
      disarmTimer(false);
      resolve({
        code: null,
        stdout,
        stderr: stderr + `\nspawn error: ${err.message}`,
        timedOut,
        killed,
        killReason,
        spawned: true,
      });
    });

    child.on('close', (code, signal) => {
      disarmTimer(false);
      // A child that died from a signal we did not schedule was killed by somebody —
      // the registry, an operator with `kill`, a supervisor. Say so honestly instead of
      // reporting it as a mysterious non-zero exit, which is what it would look like.
      if (!timedOut && !killed && signal) {
        killed = true;
        killReason = `the agent process was terminated (${signal})`;
      }
      resolve({ code, stdout, stderr, timedOut, killed, killReason, spawned: true });
    });
  });
}

/**
 * Is the codex CLI actually on PATH and answering? Checked once at run start so failures
 * are early and clear. Timed out rather than trusted: a binary that never answers must
 * not hang the preflight of a run nobody has started yet.
 */
export function codexAvailable(bin = codexBin(), timeoutMs = 5000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const child = spawn(bin, ['--version'], { stdio: 'ignore', env: childEnv() });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false);
    }, timeoutMs);
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

/**
 * Is the Codex CLI signed in on this machine?
 *
 * Answered by reading what `codex login` leaves on disk — `auth.json` under `$CODEX_HOME`
 * (default `~/.codex`) — rather than by asking the network. A readiness check must not
 * cost a round trip, let alone money, and that file is the same thing the CLI consults.
 *
 * Deliberately conservative: `unknown` when we cannot tell, never a guess. The one thing
 * this must never do is turn "cannot tell" into "not signed in" and block a run over it.
 *
 * @returns {{state: 'signed_in'|'signed_out'|'unknown', method: string|null, file: string, reason?: string}}
 */
export function codexAuthStatus() {
  let home;
  try {
    home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  } catch {
    return { state: 'unknown', method: null, file: '', reason: 'no home directory' };
  }
  const file = path.join(home, 'auth.json');

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // ENOENT is a real answer: the CLI writes this file the moment a login succeeds.
    // Anything else (a permission problem, a directory in its place) is genuinely unknown.
    if (err?.code === 'ENOENT') return { state: 'signed_out', method: null, file };
    return { state: 'unknown', method: null, file, reason: err?.code ?? 'unreadable' };
  }

  let auth;
  try {
    auth = JSON.parse(raw);
  } catch {
    return { state: 'unknown', method: null, file, reason: 'unreadable sign-in file' };
  }

  const tokens = auth?.tokens ?? {};
  if (tokens.access_token || tokens.id_token || tokens.refresh_token) {
    return { state: 'signed_in', method: 'chatgpt', file };
  }
  // `codex login --api-key` stores a credential here. That credential belongs to the
  // Codex CLI, not to this project: we note that it exists and never read its value.
  if (auth && typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.trim()) {
    return { state: 'signed_in', method: 'stored_credential', file };
  }
  return { state: 'signed_out', method: null, file, reason: 'sign-in file holds no credential' };
}

/**
 * Everything a live run's preflight needs, in one call: is the agent runtime installed,
 * and has anybody signed in to it.
 *
 * `ready` is false only for a *definite* no. An indeterminate sign-in lets the run start
 * and lets the CLI itself say no, clearly, in seconds — which is better than this project
 * guessing and refusing to start on a machine that was actually fine.
 *
 * @returns {Promise<{bin: string, installed: boolean, auth: 'signed_in'|'signed_out'|'unknown',
 *                    authMethod: string|null, authFile: string, ready: boolean}>}
 */
export async function codexReadiness(bin = codexBin()) {
  const installed = await codexAvailable(bin);
  const auth = codexAuthStatus();
  return {
    bin,
    installed,
    auth: auth.state,
    authMethod: auth.method,
    authFile: auth.file,
    ready: installed && auth.state !== 'signed_out',
  };
}
