import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validateArtifact, checkEvidenceContract, FIXTURES_DIR } from '../src/index.js';

const SNAP = path.join(FIXTURES_DIR, '2026-08-11_sample');
const load = (f) => JSON.parse(fs.readFileSync(path.join(SNAP, f), 'utf8'));

const PAIRS = [
  ['01_outlets.json', '01_outlets.schema.json'],
  ['02_items.json', '02_items.schema.json'],
  ['03_stories.json', '03_stories.schema.json'],
  ['04_triage.json', '04_triage.schema.json'],
  ['05_scored.json', '05_scored.schema.json'],
  ['06_verified.json', '06_verified.schema.json'],
  ['07_concepts.json', '07_concepts.schema.json'],
  ['08_prompts.json', '08_prompts.schema.json'],
  ['09_gate.json', '09_gate.schema.json'],
  ['10_render.json', '10_render.schema.json'],
  ['11_publish.json', '11_publish.schema.json'],
];

describe('contracts accept the fixture snapshot', () => {
  for (const [file, contract] of PAIRS) {
    test(`${file} validates`, () => {
      const r = validateArtifact(contract, load(file));
      assert.equal(r.ok, true, r.errors.join('\n'));
    });
  }
});

/**
 * A validator that accepts everything is not a validator. Each of these mutates a
 * fixture into something an agent might plausibly emit and asserts it is REJECTED.
 */
describe('contracts reject what they are supposed to reject', () => {
  test('missing required envelope field', () => {
    const a = load('05_scored.json');
    delete a.generated_at;
    assert.equal(validateArtifact('05_scored.schema.json', a).ok, false);
  });

  test('unknown top-level property (agent drift)', () => {
    const a = load('05_scored.json');
    a.extra_thoughts = 'the model decided to add a field';
    assert.equal(validateArtifact('05_scored.schema.json', a).ok, false);
  });

  test('rubric score out of range', () => {
    const a = load('05_scored.json');
    a.candidates[0].dimensions.legibility.score = 11;
    assert.equal(validateArtifact('05_scored.schema.json', a).ok, false);
  });

  test('a dimension justification that is a shrug', () => {
    const a = load('05_scored.json');
    a.candidates[0].dimensions.spice.justification = 'good';
    assert.equal(validateArtifact('05_scored.schema.json', a).ok, false);
  });

  test('legal_risk given a positive weight (risk must subtract)', () => {
    const a = load('05_scored.json');
    a.weights.legal_risk = 0.2;
    assert.equal(validateArtifact('05_scored.schema.json', a).ok, false);
  });

  test('a dimension silently dropped from the rubric', () => {
    const a = load('05_scored.json');
    delete a.candidates[0].dimensions.legal_risk;
    assert.equal(validateArtifact('05_scored.schema.json', a).ok, false);
  });

  test('claim marked verified on a single source', () => {
    const a = load('06_verified.json');
    a.candidates[0].claims[0].sources = [a.candidates[0].claims[0].sources[0]];
    assert.equal(
      validateArtifact('06_verified.schema.json', a).ok,
      false,
      'one source must not satisfy the two-independent-sources bar'
    );
  });

  test('REVISE verdict with no actionable asks', () => {
    const a = load('09_gate.json');
    const revise = a.verdicts.find((v) => v.verdict === 'REVISE');
    delete revise.revision_asks;
    assert.equal(validateArtifact('09_gate.schema.json', a).ok, false);
  });

  test('BLOCK verdict with no reason', () => {
    const a = load('09_gate.json');
    a.verdicts[0].verdict = 'BLOCK';
    delete a.verdicts[0].revision_asks;
    assert.equal(validateArtifact('09_gate.schema.json', a).ok, false);
  });

  test('gate verdict with no clause citations', () => {
    const a = load('09_gate.json');
    a.verdicts[1].checks = [];
    assert.equal(validateArtifact('09_gate.schema.json', a).ok, false);
  });

  test('prompt package missing the blank-plate instruction', () => {
    const a = load('08_prompts.json');
    delete a.packages[0].image_prompt.blank_plate_instruction;
    assert.equal(validateArtifact('08_prompts.schema.json', a).ok, false);
  });

  test('prompt package with only one caption option', () => {
    const a = load('08_prompts.json');
    a.packages[0].captions = [a.packages[0].captions[0]];
    assert.equal(validateArtifact('08_prompts.schema.json', a).ok, false);
  });

  test('prompt package missing alt text', () => {
    const a = load('08_prompts.json');
    a.packages[0].alt_text_he = '';
    assert.equal(validateArtifact('08_prompts.schema.json', a).ok, false);
  });

  test('ideation offering fewer than three concepts', () => {
    const a = load('07_concepts.json');
    a.candidates[0].concepts = a.candidates[0].concepts.slice(0, 2);
    assert.equal(validateArtifact('07_concepts.schema.json', a).ok, false);
  });

  test('a cast member with no declared caricature handles', () => {
    const a = load('07_concepts.json');
    a.candidates[0].concepts[0].cast[0].caricature_handles = [];
    assert.equal(
      validateArtifact('07_concepts.schema.json', a).ok,
      false,
      'handles must be declared so §3 is mechanically checkable'
    );
  });

  test('a harvested item with a placeholder timestamp', () => {
    const a = load('02_items.json');
    a.items[0].published_at = 'sometime yesterday';
    assert.equal(validateArtifact('02_items.schema.json', a).ok, false);
  });

  test('an outlet ranked with no supporting signal', () => {
    const a = load('01_outlets.json');
    a.outlets[0].signals = [];
    assert.equal(validateArtifact('01_outlets.schema.json', a).ok, false);
  });

  // The key-based design must not creep back in. There is no API key anywhere in this
  // pipeline, so an agent claiming it measured traffic through a paid API is claiming
  // something it cannot have done — and the reach numbers would be presented to the
  // editor as measured rather than as the proxies they are.
  test('data_basis claiming a paid measured-traffic API', () => {
    const a = load('01_outlets.json');
    a.data_basis = 'similarweb_api';
    assert.equal(
      validateArtifact('01_outlets.schema.json', a).ok,
      false,
      'there is no keyed API in this pipeline; every reach number is an honest proxy'
    );
  });

  test('a signal sourced from a paid traffic API', () => {
    const a = load('01_outlets.json');
    a.outlets[0].signals[0].kind = 'similarweb_rank';
    assert.equal(
      validateArtifact('01_outlets.schema.json', a).ok,
      false,
      'signal kinds are limited to what a keyless agent can actually read'
    );
  });

  // 'unavailable' (nothing was reachable) and 'refused' (a renderer declined on policy)
  // are different facts about a concept. Collapsing the render-level vocabulary into the
  // attempt-level one is exactly the mistake that would indict a concept nothing looked at.
  test('a render outcome value used as an attempt status', () => {
    const a = load('10_render.json');
    a.renders[0].attempts[0].status = 'no_renderer_available';
    assert.equal(validateArtifact('10_render.schema.json', a).ok, false);
  });
});

/**
 * The renderer is best-effort and keyless: it uses whatever free or local tooling it
 * finds. "I could not reach any renderer" must be expressible, and must be expressible
 * as something other than a refusal.
 */
describe('the no-renderer path is a first-class outcome', () => {
  test('an honest "nothing could render this" record validates', () => {
    const a = load('10_render.json');
    a.renders.push({
      story_id: 'st_recycled_renders',
      concept_id: 'cp_rr_copier',
      attempts: [
        {
          variant: 'named',
          status: 'unavailable',
          model: 'local ComfyUI (http://127.0.0.1:8188)',
          error: 'nothing listening on 127.0.0.1:8188',
          duration_ms: 190,
        },
        {
          variant: 'attribute',
          status: 'unavailable',
          model: 'ImageMagick + local diffusion CLI',
          error: 'no sd/comfy binary on PATH',
          duration_ms: 40,
        },
      ],
      outcome: 'no_renderer_available',
    });
    const r = validateArtifact('10_render.schema.json', a);
    assert.equal(r.ok, true, r.errors.join('\n'));
  });

  test('the fixture itself exercises an unavailable attempt', () => {
    const a = load('10_render.json');
    const statuses = a.renders.flatMap((r) => r.attempts.map((x) => x.status));
    assert.ok(
      statuses.includes('unavailable'),
      'the offline gate should carry a real example of a renderer that was simply not there'
    );
  });
});

/** The anti-hallucination check, tested directly. */
describe('evidence contract', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'carica-ev-'));

  test('accepts the fixture evidence log', () => {
    const r = checkEvidenceContract(load('01_outlets.json'), path.join(SNAP, '01_outlets.evidence.jsonl'));
    assert.equal(r.ok, true, r.errors.join('\n'));
    assert.ok(r.refCount > 0, 'fixture should actually cite evidence');
  });

  test('rejects a cited evidence_id with no record — the fabricated number case', () => {
    const a = load('01_outlets.json');
    a.outlets[0].signals[0].evidence_id = 'ev_invented999';
    const r = checkEvidenceContract(a, path.join(SNAP, '01_outlets.evidence.jsonl'));
    assert.equal(r.ok, false);
    assert.match(r.errors.join('\n'), /unsourced claim/);
  });

  test('rejects an evidence record with no url or command', () => {
    const dir = tmp();
    const ev = path.join(dir, 'x.evidence.jsonl');
    fs.writeFileSync(
      ev,
      JSON.stringify({
        evidence_id: 'ev_bare01',
        kind: 'fetch',
        observed_at: '2026-08-11T06:00:00Z',
        summary: 'I just know this',
      }) + '\n'
    );
    const r = checkEvidenceContract({ signals: [{ evidence_id: 'ev_bare01' }] }, ev);
    assert.equal(r.ok, false, 'a fetch record with no URL is not evidence');
  });

  test('rejects a malformed evidence line', () => {
    const dir = tmp();
    const ev = path.join(dir, 'x.evidence.jsonl');
    fs.writeFileSync(ev, 'this is not json\n');
    const r = checkEvidenceContract({}, ev);
    assert.equal(r.ok, false);
  });

  test('finds evidence ids at any depth', () => {
    const r = checkEvidenceContract(
      { a: { b: [{ c: { evidence_id: 'ev_deep01' } }] } },
      path.join(SNAP, '01_outlets.evidence.jsonl')
    );
    assert.equal(r.refCount, 1);
    assert.equal(r.ok, false);
  });
});
