import fs from 'node:fs';
import path from 'node:path';
import { PROMPTS_DIR, CONTRACTS_DIR, CONFIG_DIR, sha256 } from '@carica/core';

/**
 * A stage charter is the agent's whole brief. It carries, inline:
 *   - what the stage is for and what "done" means
 *   - the EXACT JSON Schema it must satisfy (agents cannot honour a contract they cannot see)
 *   - the evidence rules
 *   - shard context, when the stage is fanned out
 *
 * Placeholders are {{name}}. Missing placeholders are an error, not a silent blank —
 * a charter with a hole in it produces confidently wrong work.
 */

export function loadCharter(charterFile) {
  const file = path.join(PROMPTS_DIR, charterFile);
  if (!fs.existsSync(file)) throw new Error(`missing charter: ${file}`);
  const text = fs.readFileSync(file, 'utf8');
  return { text, sha: sha256(text), file };
}

export function renderCharter(template, ctx) {
  const missing = [];
  const out = template.replace(/\{\{(\w+)\}\}/g, (_m, key) => {
    if (!(key in ctx) || ctx[key] === undefined || ctx[key] === null) {
      missing.push(key);
      return '';
    }
    return typeof ctx[key] === 'string' ? ctx[key] : JSON.stringify(ctx[key], null, 2);
  });
  if (missing.length) {
    throw new Error(`charter placeholders not supplied: ${[...new Set(missing)].join(', ')}`);
  }
  return out;
}

export function readContract(contractFile) {
  return fs.readFileSync(path.join(CONTRACTS_DIR, contractFile), 'utf8');
}

export function readConfigFile(name) {
  const file = path.join(CONFIG_DIR, name);
  if (!fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8');
}

/** Every charter gets the same non-negotiable preamble. Authored once, not per stage. */
export function evidencePreamble(stage) {
  return `## Non-negotiable operating rules

You are an autonomous agent running one stage of a newspaper's caricature pipeline.
You choose your own approach and tools. Three things are NOT yours to choose:

1. **Where you write.** Your single deliverable is the file \`${stage.artifact}\` in your
   working directory. Write it with a real file write. Do not print it as your reply.

2. **The output contract.** \`${stage.artifact}\` MUST validate against the JSON Schema
   reproduced below. It is checked mechanically the moment you exit. If it fails you will
   be re-invoked with the exact errors, and you will have wasted a cycle.

3. **The evidence contract.** Every number, ranking, engagement count and factual claim you
   emit must carry an \`evidence_id\` that resolves to a line you appended to
   \`${stage.slug}.evidence.jsonl\`. Each line is one JSON object recording either a URL you
   actually fetched or a shell command you actually ran, with the timestamp and a one-line
   summary of what it establishes.

   **An unsourced number is a stage failure.** If you cannot source a figure, you have two
   honest options: omit it, or record it as an explicit estimate with the reasoning in the
   summary field. You must never fabricate an evidence record for a number you did not
   observe. This pipeline's output goes into a newspaper; a made-up figure is a correction.

Write your evidence lines AS YOU GO, not at the end. If you are interrupted, the evidence
you already gathered must still be on disk.`;
}
