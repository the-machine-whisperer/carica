import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Repo root, resolved from this file's location so `carica` works from any cwd. */
export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..'
);

export const CONTRACTS_DIR = path.join(REPO_ROOT, 'contracts');
export const PROMPTS_DIR = path.join(REPO_ROOT, 'prompts');
export const CONFIG_DIR = path.join(REPO_ROOT, 'config');
export const FIXTURES_DIR = path.join(REPO_ROOT, 'fixtures');
export const RUNS_DIR = path.join(REPO_ROOT, 'runs');
export const HISTORY_DIR = path.join(REPO_ROOT, 'history');
export const LEDGER_PATH = path.join(HISTORY_DIR, 'ledger.jsonl');
