import fs from 'node:fs';
import path from 'node:path';
import { LEDGER_PATH } from './paths.js';
import { stableId } from './ids.js';

/**
 * The history ledger: every candidate this column has ever drawn.
 *
 * Read by S5 to score the ORIGINALITY dimension — a column that redraws last
 * month's cartoon has a memory problem, not a talent problem. Written by S11
 * only after the human editor approves.
 */

/** @param {string} [file] */
export function readLedger(file = LEDGER_PATH) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip torn line */
    }
  }
  return out;
}

/**
 * @param {{run_id: string, story_id: string, concept_id: string, title_en: string,
 *          title_he?: string, gag_line: string, metaphor_family: string,
 *          figures?: string[], published_at?: string}} entry
 * @param {string} [file]
 */
export function appendLedger(entry, file = LEDGER_PATH) {
  const record = {
    ledger_id: stableId('lg', `${entry.run_id}:${entry.story_id}:${entry.concept_id}`),
    recorded_at: new Date().toISOString(),
    ...entry,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
  return record;
}

/**
 * Compact view handed to S5 so the scorer can judge originality without being
 * given the whole history.
 * @param {number} [limit]
 */
export function recentLedgerDigest(limit = 40, file = LEDGER_PATH) {
  return readLedger(file)
    .slice(-limit)
    .map((e) => ({
      ledger_id: e.ledger_id,
      recorded_at: e.recorded_at,
      title_en: e.title_en,
      gag_line: e.gag_line,
      metaphor_family: e.metaphor_family,
      figures: e.figures ?? [],
    }));
}
