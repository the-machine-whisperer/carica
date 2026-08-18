import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { REPO_ROOT, CONFIG_DIR, sha256, DIMENSION_KEYS } from '@carica/core';
import { codexAuthStatus, codexReadiness } from '@carica/codex';
import { listFixtures } from './run-manager.js';

/**
 * Readiness and tunable config — everything that used to mean editing a dotfile or a
 * YAML file in a text editor.
 *
 * Two rules run through this module:
 *   - **This project holds no credentials of its own.** There is no API key to paste,
 *     here or anywhere else: every stage runs as a `codex exec` invocation and the Codex
 *     CLI carries its own sign-in, made once with `codex login`. Nothing in the settings
 *     table is a secret, so nothing here needs to hide one.
 *   - A check that fails says what to do about it. "codex: false" is not an answer for
 *     someone who has never opened a terminal.
 */

const ENV_FILE = path.join(REPO_ROOT, '.env');
const POLICY_FILE = path.join(CONFIG_DIR, 'editorial-policy.md');
const WEIGHTS_FILE = path.join(CONFIG_DIR, 'weights.yaml');
const WEB_DIST = path.join(REPO_ROOT, 'packages', 'web', 'dist');

/**
 * Keys the app may write. Anything else in .env is left strictly alone.
 *
 * Both are ordinary operational settings. If you are ever tempted to add a key, token or
 * password here: don't — the pipeline never calls an API itself, and a credential on this
 * screen would be a credential this app has no use for.
 *
 * There is deliberately no drawing-model setting. The drawing step chooses whatever
 * renderer it can actually reach on this machine and records an honest fallback when it
 * can reach none, so the manifest says `models.image: agent-selected`. A box on this
 * screen would promise the editor a choice the step does not take.
 */
export const EDITABLE_KEYS = [
  { key: 'CARICA_CODEX_MODEL', label: 'Reasoning model', required: false, default: '',
    help: 'Leave blank — Codex then uses the model your sign-in actually has. Only name one if you have been told to, and only one your account is entitled to: a model it cannot use fails every step of a live run with a 400.' },
  { key: 'CARICA_CODEX_BIN', label: 'Path to the Codex command', required: false,
    help: 'Only needed if the Codex CLI is installed somewhere unusual.' },
];

const EDITABLE_BY_KEY = Object.fromEntries(EDITABLE_KEYS.map((k) => [k.key, k]));

// ------------------------------------------------------------------ .env

/** Parse a dotenv file into {key: value} plus the raw lines, so a rewrite keeps comments. */
export function readEnvFile(file = ENV_FILE) {
  if (!fs.existsSync(file)) return { values: {}, lines: [], exists: false };
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n');
  const values = {};
  for (const line of lines) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    values[m[1]] = v;
  }
  return { values, lines, exists: true };
}

/**
 * Update keys in .env in place, keeping every comment and every key we do not manage.
 * Also updates this process's own env, so a run started right afterwards sees the change
 * without anyone restarting anything.
 *
 * @param {Record<string,string>} updates  '' clears a key; an absent key is left untouched.
 */
export function writeEnvFile(updates, file = ENV_FILE) {
  const rejected = Object.keys(updates).filter((k) => !EDITABLE_BY_KEY[k]);
  if (rejected.length) {
    const err = new Error(`These settings are not editable here: ${rejected.join(', ')}`);
    err.status = 400;
    throw err;
  }

  const { lines, exists } = readEnvFile(file);
  const out = exists && lines.length ? [...lines] : ['# Written by the carica setup screen. Never commit this file.', ''];
  const seen = new Set();

  for (let i = 0; i < out.length; i++) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(out[i]);
    if (!m) continue;
    const key = m[1];
    if (!(key in updates)) continue;
    seen.add(key);
    out[i] = `${key}=${serialise(updates[key])}`;
  }
  for (const [key, value] of Object.entries(updates)) {
    if (seen.has(key)) continue;
    out.push(`${key}=${serialise(value)}`);
  }

  const text = out.join('\n').replace(/\n{3,}$/, '\n\n');
  fs.writeFileSync(file, text.endsWith('\n') ? text : text + '\n', { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600); // an existing .env may have been created with looser bits
  } catch {
    /* not fatal on filesystems without modes */
  }

  for (const [key, value] of Object.entries(updates)) {
    if (value === '') delete process.env[key];
    else process.env[key] = value;
  }

  return { written: Object.keys(updates), file };
}

function serialise(v) {
  const s = String(v ?? '');
  return /[\s#"']/.test(s) ? JSON.stringify(s) : s;
}

/** Effective value: the process environment wins, since that is what a run will actually use. */
function effective(key, fileValues) {
  return process.env[key] ?? fileValues[key] ?? '';
}

/**
 * What the Setup screen shows. Every value is returned in full, because every value is
 * a model name or a file path — there is nothing here to withhold.
 */
export function settingsView() {
  const { values, exists } = readEnvFile();
  return {
    env_file_exists: exists,
    settings: EDITABLE_KEYS.map((k) => {
      const v = effective(k.key, values);
      return {
        key: k.key,
        label: k.label,
        help: k.help,
        required: k.required,
        present: !!v,
        value: v,
        // What a run would actually use if this is left blank.
        fallback: k.default ?? null,
        from_environment: !!process.env[k.key] && !values[k.key],
      };
    }),
  };
}

// ------------------------------------------------------------------ readiness

/**
 * Sign-in detection lives in `@carica/codex`, next to the code that spawns the CLI, and
 * is re-exported here because that is what the app's own tests and callers reach for.
 * One implementation, deliberately: the readiness screen and the pipeline's live-run
 * preflight must not be able to disagree about whether this machine can do a run.
 */
export { codexAuthStatus };

let codexCache = { at: 0, value: null };

/**
 * `codexReadiness()` spawns `codex --version`, so a screen that polls does not re-spawn
 * it on every request. The sign-in half is only a file read, so it is checked every time
 * and busts the cache the moment it changes: an editor who has just run `codex login`
 * should not have to wait out a timer to be told it worked.
 *
 * Every field, `ready` included, still comes from @carica/codex — nothing is recomputed
 * here, because a second opinion is exactly the drift this is meant to avoid.
 */
async function codexStatus() {
  const now = Date.now();
  const signedIn = codexAuthStatus().state;
  const stale =
    !codexCache.value || now - codexCache.at >= 10_000 || codexCache.value.auth !== signedIn;
  if (stale) codexCache = { at: now, value: await codexReadiness() };
  return codexCache.value;
}

/**
 * The preflight the app shows before it will let anyone start a live run.
 * `state`: ok | warn | blocked. Only a check that `blocks: 'live'` and is not `ok` stops one.
 *
 * There is no key check here, and there is not meant to be one: the pipeline never calls
 * an API itself. Everything it does, it does through the Codex CLI's own sign-in.
 *
 * This is a *rendering* of `codexReadiness()`, not a second opinion about it —
 * `ready_for_live` reproduces its `ready`, so the app can never offer a run the pipeline
 * is about to refuse, nor withhold one it would have accepted.
 */
export async function systemStatus() {
  const codex = await codexStatus();
  const fixtures = listFixtures();
  const policy = policyStatus();

  // "Cannot tell" must not become "no" — the live run is offered and the CLI itself gets
  // to say no, clearly, in seconds. Practice runs are never affected either way.
  const authUnknown = codex.auth === 'unknown';

  const checks = [
    {
      id: 'codex',
      label: 'Agent runtime',
      state: codex.installed ? 'ok' : 'blocked',
      detail: codex.installed
        ? 'The Codex command is installed and answering.'
        : 'The Codex command was not found on this computer.',
      fix: codex.installed
        ? null
        : 'Ask whoever set this machine up to install the Codex CLI. Until then you can still do practice runs.',
      blocks: 'live',
    },
    {
      id: 'codex_auth',
      label: 'Codex sign-in',
      state: codex.auth === 'signed_in' ? 'ok' : authUnknown ? 'warn' : 'blocked',
      detail:
        codex.auth === 'signed_in'
          ? 'Codex is signed in on this computer.'
          : authUnknown
            ? 'Cannot tell whether Codex is signed in. A live run will say so straight away if it is not.'
            : 'Codex is not signed in, so a live run has nothing to work with.',
      fix:
        codex.auth === 'signed_in'
          ? null
          : 'Open a Terminal window and run: codex login. It is a one-off — the sign-in stays on this computer and this app never asks for it again. There is no key to paste anywhere.',
      // Unknown warns, it does not block. Only a definite "signed out" stands in the way,
      // which is exactly how codexReadiness() computes `ready`.
      blocks: authUnknown ? null : 'live',
    },
    {
      id: 'policy',
      label: 'Editorial policy',
      state: policy.draft ? 'warn' : 'ok',
      detail: policy.draft
        ? 'The policy the standards check adjudicates against is still marked DRAFT.'
        : 'Signed off.',
      fix: policy.draft
        ? 'Nothing may be published until the standards desk and legal counsel sign off config/editorial-policy.md. Runs still work; publication does not.'
        : null,
      blocks: 'publication',
    },
    {
      id: 'fixtures',
      label: 'Practice snapshot',
      state: fixtures.length ? 'ok' : 'warn',
      detail: fixtures.length
        ? `${fixtures.length} snapshot${fixtures.length === 1 ? '' : 's'} available for a free practice run.`
        : 'No practice snapshot on disk.',
      fix: fixtures.length ? null : 'Practice runs need a snapshot in fixtures/. Live runs are unaffected.',
      blocks: 'practice',
    },
  ];

  return {
    checks,
    ready_for_live: checks.filter((c) => c.blocks === 'live').every((c) => c.state === 'ok'),
    ready_for_practice: fixtures.length > 0,
    codex: {
      bin: codex.bin,
      present: codex.installed,
      auth: codex.auth,
      auth_method: codex.authMethod,
      auth_file: codex.authFile,
      ready: codex.ready,
      // Tri-state on the wire: true, false, or absent for "we could not tell". Never
      // collapse unknown to false — the app would then say "signed out" on a machine
      // that is signed in perfectly well.
      ...(authUnknown ? {} : { logged_in: codex.auth === 'signed_in' }),
    },
    policy,
    fixtures: fixtures.map((f) => ({ name: f.name, stages: f.stages })),
    node_version: process.version,
    web_built: fs.existsSync(WEB_DIST),
    repo_root: REPO_ROOT,
  };
}

export function policyStatus() {
  if (!fs.existsSync(POLICY_FILE)) return { present: false, draft: true, sha: null };
  const text = fs.readFileSync(POLICY_FILE, 'utf8');
  const head = text.slice(0, 600);
  return {
    present: true,
    draft: /\*\*Status:\*\*\s*DRAFT|^\s*status:\s*draft/im.test(head),
    sha: sha256(text).slice(0, 12),
    bytes: text.length,
  };
}

// ------------------------------------------------------------------ weights

export function readWeightsDoc() {
  const text = fs.readFileSync(WEIGHTS_FILE, 'utf8');
  return { text, doc: YAML.parseDocument(text), data: YAML.parse(text) };
}

/**
 * Persist edited rubric weights.
 *
 * Edited through the YAML document rather than re-serialised from the parsed object: the
 * comments in weights.yaml explain why each weight is what it is, and an editor who
 * re-weights the rubric from the Ranking screen should not silently delete the reasoning.
 *
 * @param {Record<string, number>} weights
 */
export function writeWeights(weights) {
  const errors = [];
  const clean = {};

  for (const key of DIMENSION_KEYS) {
    const v = Number(weights?.[key]);
    if (!Number.isFinite(v)) {
      errors.push(`${key}: not a number`);
      continue;
    }
    if (key === 'legal_risk' && v > 0) {
      // Also enforced by the S5 contract: a positive legal_risk weight would reward risk.
      errors.push('legal_risk must be zero or negative — risk subtracts from a score, it never adds to it');
      continue;
    }
    if (key !== 'legal_risk' && v < 0) {
      errors.push(`${key}: must not be negative`);
      continue;
    }
    if (Math.abs(v) > 1) {
      errors.push(`${key}: must be between -1 and 1`);
      continue;
    }
    clean[key] = Math.round(v * 1000) / 1000;
  }

  if (errors.length) {
    const err = new Error('Those weights cannot be saved.');
    err.status = 400;
    err.errors = errors;
    throw err;
  }

  const positiveSum = DIMENSION_KEYS.filter((k) => k !== 'legal_risk').reduce((a, k) => a + clean[k], 0);
  const { doc } = readWeightsDoc();
  for (const [k, v] of Object.entries(clean)) doc.setIn(['weights', k], v);
  doc.setIn(['edited_at'], new Date().toISOString());

  const text = doc.toString();
  const tmp = `${WEIGHTS_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, WEIGHTS_FILE);

  return {
    ok: true,
    weights: clean,
    positive_sum: Math.round(positiveSum * 1000) / 1000,
    // A warning, not a rejection: the editor may be mid-experiment, and the arithmetic is
    // still honest — the totals simply are not on a 0-10 scale any more.
    warning:
      Math.abs(positiveSum - 1) > 0.001
        ? `The positive weights add up to ${positiveSum.toFixed(3)}, not 1.00. Totals will no longer be on a 0–10 scale.`
        : null,
  };
}
