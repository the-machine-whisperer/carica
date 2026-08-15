import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { CONTRACTS_DIR } from './paths.js';

let _ajv = null;

/**
 * One Ajv instance with every contract registered, so relative $refs
 * ("_defs.schema.json#/definitions/...") resolve against each schema's $id.
 */
export function getAjv() {
  if (_ajv) return _ajv;
  const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
  addFormats(ajv);
  for (const file of fs.readdirSync(CONTRACTS_DIR)) {
    if (!file.endsWith('.schema.json')) continue;
    const schema = JSON.parse(fs.readFileSync(path.join(CONTRACTS_DIR, file), 'utf8'));
    ajv.addSchema(schema, schema.$id);
  }
  _ajv = ajv;
  return ajv;
}

/**
 * Validate a stage artifact against its contract.
 * @param {string} contractFile e.g. '05_scored.schema.json'
 * @param {unknown} data
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateArtifact(contractFile, data) {
  const ajv = getAjv();
  const validate = ajv.getSchema(`https://carica.local/contracts/${contractFile}`);
  if (!validate) return { ok: false, errors: [`no such contract: ${contractFile}`] };
  const ok = validate(data);
  if (ok) return { ok: true, errors: [] };
  return {
    ok: false,
    errors: (validate.errors || []).map(
      (e) => `${e.instancePath || '/'} ${e.message}${e.params ? ' ' + JSON.stringify(e.params) : ''}`
    ),
  };
}

/** Recursively collect every evidence_id referenced anywhere in an artifact. */
export function collectEvidenceRefs(node, acc = new Set()) {
  if (Array.isArray(node)) {
    for (const n of node) collectEvidenceRefs(n, acc);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'evidence_id' && typeof v === 'string') acc.add(v);
      else collectEvidenceRefs(v, acc);
    }
  }
  return acc;
}

/** Parse a <stage>.evidence.jsonl file into records. */
export function readEvidence(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      out.push({ __malformed: line.slice(0, 120) });
    }
  }
  return out;
}

/**
 * THE ANTI-HALLUCINATION CHECK.
 *
 * An agentic pipeline can invent numbers. We do not prevent that by taking work
 * away from the agent — we make it structurally detectable: every evidence_id the
 * artifact cites must resolve to a real fetch or command in the evidence log, and
 * every evidence record must itself be well-formed.
 *
 * An unsourced number is a stage failure.
 *
 * @param {object} artifact
 * @param {string} evidenceFile
 * @returns {{ok: boolean, errors: string[], refCount: number, recordCount: number}}
 */
export function checkEvidenceContract(artifact, evidenceFile) {
  const refs = collectEvidenceRefs(artifact);
  const records = readEvidence(evidenceFile);
  const errors = [];

  const ajv = getAjv();
  const validateRecord = ajv.compile({
    $ref: 'https://carica.local/contracts/_defs.schema.json#/definitions/evidenceRecord',
  });

  const known = new Set();
  records.forEach((rec, i) => {
    if (rec.__malformed) {
      errors.push(`evidence line ${i + 1} is not valid JSON: ${rec.__malformed}`);
      return;
    }
    if (!validateRecord(rec)) {
      errors.push(
        `evidence record ${rec.evidence_id || `#${i + 1}`} malformed: ` +
          (validateRecord.errors || []).map((e) => `${e.instancePath} ${e.message}`).join('; ')
      );
      return;
    }
    known.add(rec.evidence_id);
  });

  for (const ref of refs) {
    if (!known.has(ref)) {
      errors.push(`unsourced claim: evidence_id ${ref} is cited but has no record in ${path.basename(evidenceFile)}`);
    }
  }

  return { ok: errors.length === 0, errors, refCount: refs.size, recordCount: records.length };
}
