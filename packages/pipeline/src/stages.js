import { HISTORY_DIR } from '@carica/core';

/**
 * The stage registry — the pipeline's spine.
 *
 * `network: true`   the stage genuinely needs the internet; it gets it, nothing else does.
 *                   This is not decoration: it selects the sandbox mode in
 *                   `buildCodexArgs()`, and a net stage run without it does not fail —
 *                   it quietly gathers nothing. S1, S2, S6 and S10 all fetch for
 *                   themselves; nobody fetches on their behalf and no API key exists.
 * `writableRoots`   directories outside the run folder the agent must be able to write.
 *                   Only S11 has one, and only because the ledger lives repo-wide.
 * `fanout`          the stage is per-item and MUST run its shards in parallel.
 *                   Running independent shards serially is a defect, not a style choice.
 * `dependsOn`       genuine data dependency, the only legitimate reason to serialise.
 *
 * Gotcha: this array is a module-level literal, so anything it references must already be
 * initialised when it evaluates. An `import` binding is; a `const` declared in this file
 * is NOT (temporal dead zone). The merge helpers below are function declarations for
 * exactly that reason — keep them that way.
 */

/** @typedef {{key: string, label: string, ctx: any}} Shard */

export const STAGES = [
  {
    id: 'outlets',
    n: 1,
    slug: '01_outlets',
    artifact: '01_outlets.json',
    contract: '01_outlets.schema.json',
    charter: 'S01-outlets.md',
    title: 'Outlet ranking',
    blurb: 'Rank Israeli outlets by reach and engagement',
    // The reach numbers come from free, open, no-login sources the agent finds and reads
    // itself — public ranking pages, the outlets' own published figures, social counts on
    // the open web. There is no traffic-data subscription behind this stage and no key to
    // hold; `requiresEvidence` is what keeps the numbers honest.
    network: true,
    requiresEvidence: true,
    dependsOn: [],
  },
  {
    id: 'harvest',
    n: 2,
    slug: '02_items',
    artifact: '02_items.json',
    contract: '02_items.schema.json',
    charter: 'S02-harvest.md',
    title: 'Harvest',
    blurb: 'Fetch political items from the ranked outlets',
    network: true,
    requiresEvidence: true,
    dependsOn: ['outlets'],
    fanout: {
      from: '01_outlets.json',
      // One shard per outlet. These are independent — they fan out.
      select: (a) => (a.outlets ?? []).map((o) => ({ key: o.id, label: o.name_en, ctx: o })),
      merge: mergeHarvest,
      partKey: 'items',
    },
  },
  {
    id: 'cluster',
    n: 3,
    slug: '03_stories',
    artifact: '03_stories.json',
    contract: '03_stories.schema.json',
    charter: 'S03-cluster.md',
    title: 'Cluster',
    blurb: 'Merge articles into cross-outlet story clusters',
    network: false,
    dependsOn: ['harvest'],
  },
  {
    id: 'triage',
    n: 4,
    slug: '04_triage',
    artifact: '04_triage.json',
    contract: '04_triage.schema.json',
    charter: 'S04-triage.md',
    title: 'Triage',
    blurb: 'Political filter, figure identification, legal flags',
    network: false,
    dependsOn: ['cluster'],
  },
  {
    id: 'score',
    n: 5,
    slug: '05_scored',
    artifact: '05_scored.json',
    contract: '05_scored.schema.json',
    charter: 'S05-score.md',
    title: 'Score',
    blurb: 'Nine-dimension caricature fitness rubric',
    network: false,
    dependsOn: ['triage'],
  },
  {
    id: 'verify',
    n: 6,
    slug: '06_verified',
    artifact: '06_verified.json',
    contract: '06_verified.schema.json',
    charter: 'S06-verify.md',
    title: 'Verify',
    blurb: 'Adversarial fact check on the top candidates',
    network: true,
    requiresEvidence: true,
    dependsOn: ['score'],
    freshContext: true, // must NOT see the scorer's reasoning — it is checking it
  },
  {
    id: 'ideate',
    n: 7,
    slug: '07_concepts',
    artifact: '07_concepts.json',
    contract: '07_concepts.schema.json',
    charter: 'S07-ideate.md',
    title: 'Ideate',
    blurb: 'Three divergent visual concepts per candidate',
    network: false,
    dependsOn: ['verify'],
    fanout: {
      from: '06_verified.json',
      select: (a) =>
        (a.candidates ?? [])
          .filter((c) => c.verdict !== 'drop')
          .map((c) => ({ key: c.story_id, label: c.story_id, ctx: c })),
      merge: mergeByKey('candidates'),
      partKey: 'candidates',
    },
  },
  {
    id: 'prompt',
    n: 8,
    slug: '08_prompts',
    artifact: '08_prompts.json',
    contract: '08_prompts.schema.json',
    charter: 'S08-prompt.md',
    title: 'Prompt synthesis',
    blurb: 'The prompt package handed to graphics',
    network: false,
    dependsOn: ['ideate'],
    fanout: {
      from: '07_concepts.json',
      select: (a) => (a.candidates ?? []).map((c) => ({ key: c.story_id, label: c.story_id, ctx: c })),
      merge: mergeByKey('packages'),
      partKey: 'packages',
    },
  },
  {
    id: 'gate',
    n: 9,
    slug: '09_gate',
    artifact: '09_gate.json',
    contract: '09_gate.schema.json',
    charter: 'S09-gate.md',
    title: 'Editorial gate',
    blurb: 'Independent adjudication against the editorial policy',
    network: false,
    dependsOn: ['prompt'],
    freshContext: true,
  },
  {
    id: 'render',
    n: 10,
    slug: '10_render',
    artifact: '10_render.json',
    contract: '10_render.schema.json',
    charter: 'S10-render.md',
    title: 'Draft render',
    blurb: 'Generate first visual drafts, log refusals',
    // Best-effort, and honestly so. S10 is an agent, not a call to a drawing API: it uses
    // whatever free or local tooling it can find on this machine, and when it cannot draw
    // at all it records that as the result rather than pretending. It needs the network to
    // go looking.
    network: true,
    dependsOn: ['gate'],
    fanout: {
      from: '09_gate.json',
      select: (a) =>
        (a.verdicts ?? [])
          .filter((v) => v.verdict === 'PASS')
          .map((v) => ({ key: `${v.story_id}_${v.concept_id}`, label: v.concept_id, ctx: v })),
      merge: mergeByKey('renders'),
      partKey: 'renders',
    },
  },
  {
    id: 'publish',
    n: 11,
    slug: '11_publish',
    artifact: '11_publish.json',
    contract: '11_publish.schema.json',
    charter: 'S11-publish.md',
    title: 'Publish',
    blurb: 'Human checkpoint, brief export, ledger append',
    network: false,
    // The briefs go in the run folder, but the ledger is repo-wide and one directory up
    // from anything the confined sandbox grants by default. Without this the append is
    // denied and the next run's originality scoring goes blind.
    writableRoots: [HISTORY_DIR],
    dependsOn: ['render'],
    humanCheckpoint: true,
  },
];

export const STAGE_BY_ID = Object.fromEntries(STAGES.map((s) => [s.id, s]));

/**
 * The stage graph as plain data — no functions, so it survives JSON.
 *
 * This is what `carica stages` printed and what the app now reads over `/api/stages`,
 * so the rail, the "continue from…" picker and the CLI cannot disagree about the pipeline.
 */
export function stageGraph() {
  return STAGES.map((s) => ({
    id: s.id,
    n: s.n,
    title: s.title,
    blurb: s.blurb,
    artifact: s.artifact,
    contract: s.contract,
    charter: s.charter,
    network: !!s.network,
    fanout: !!s.fanout,
    freshContext: !!s.freshContext,
    humanCheckpoint: !!s.humanCheckpoint,
    requiresEvidence: !!s.requiresEvidence,
    dependsOn: s.dependsOn ?? [],
  }));
}

/** Merge harvest shards: concatenate items, and keep one status row per outlet. */
function mergeHarvest(parts, envelope) {
  const items = [];
  const outlet_status = [];
  for (const p of parts) {
    if (!p) continue;
    items.push(...(p.items ?? []));
    outlet_status.push(...(p.outlet_status ?? []));
  }
  return { ...envelope, items, outlet_status };
}

/** Generic: concatenate one named array across shards. */
function mergeByKey(key) {
  return (parts, envelope) => {
    const acc = [];
    for (const p of parts) if (p) acc.push(...(p[key] ?? []));
    return { ...envelope, [key]: acc };
  };
}

/**
 * @param {string} fromId
 * @returns {typeof STAGES} the stages from `fromId` onward
 */
export function stagesFrom(fromId) {
  if (!fromId) return STAGES;
  const i = STAGES.findIndex((s) => s.id === fromId);
  if (i === -1) throw new Error(`unknown stage: ${fromId}. Known: ${STAGES.map((s) => s.id).join(', ')}`);
  return STAGES.slice(i);
}
