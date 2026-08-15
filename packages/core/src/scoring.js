/**
 * The rubric arithmetic — ONE implementation, shared by the pipeline and the review app.
 *
 * S5 emits sub-scores and weights separately precisely so the editor can re-weight in the
 * UI and re-rank instantly. That only works if the UI computes the total exactly the way
 * the artifact did; two implementations would drift and the sliders would quietly lie.
 */

/** Canonical order — used for display and for the arithmetic string. */
export const DIMENSIONS = [
  {
    key: 'legibility',
    label: 'Legibility',
    short: 'Reads in one frame',
    blurb: 'Can it be understood in a single frame without a caption? The dimension most often forgotten and the one that decides whether the cartoon works.',
  },
  {
    key: 'absurdity',
    label: 'Absurdity',
    short: 'Ridiculousness',
    blurb: 'Is there an inherent visual contradiction in the events themselves?',
  },
  {
    key: 'comedic_mechanism',
    label: 'Comedic mechanism',
    short: 'Is there a joke',
    blurb: 'A reversal, an irony, a literalised metaphor — not merely a topic people are angry about.',
  },
  {
    key: 'spice',
    label: 'Spice',
    short: 'Cuts at power',
    blurb: 'Does it aim at an officeholder’s exercise of power? Direction matters more than intensity.',
  },
  {
    key: 'impact',
    label: 'Impact',
    short: 'Stakes',
    blurb: 'Consequence magnitude — who is affected, how many, how irreversibly.',
  },
  {
    key: 'shelf_life',
    label: 'Shelf life',
    short: 'Still live at press',
    blurb: 'Will it still land 3–4 days out? The Israeli news cycle is fast and the column is semi-weekly.',
  },
  {
    key: 'controversy',
    label: 'Controversy',
    short: 'Debate volume',
    blurb: 'Talkback volume, cross-outlet breadth, polarisation.',
  },
  {
    key: 'originality',
    label: 'Originality',
    short: 'Not drawn before',
    blurb: 'Checked against the ledger. Readers notice repetition before editors do.',
  },
  {
    key: 'legal_risk',
    label: 'Legal risk',
    short: 'Risk — subtracts',
    blurb: 'Defamation exposure, censor scope, sub judice, proximity to a prohibited trope. Higher is worse.',
    negative: true,
  },
];

export const DIMENSION_KEYS = DIMENSIONS.map((d) => d.key);

/**
 * @param {Record<string, {score:number}>} dimensions
 * @param {Record<string, number>} weights
 * @returns {number} weighted total, rounded to 2dp the same way S5 reports it
 */
export function weightedTotal(dimensions, weights) {
  let total = 0;
  for (const key of DIMENSION_KEYS) {
    const score = dimensions?.[key]?.score;
    const weight = weights?.[key];
    if (typeof score !== 'number' || typeof weight !== 'number') continue;
    total += score * weight;
  }
  return Math.round(total * 100) / 100;
}

/**
 * Human-readable arithmetic, in the same shape S5 writes into the artifact.
 * @param {Record<string, {score:number}>} dimensions
 * @param {Record<string, number>} weights
 */
export function arithmeticString(dimensions, weights) {
  const terms = [];
  const products = [];
  for (const key of DIMENSION_KEYS) {
    const score = dimensions?.[key]?.score;
    const weight = weights?.[key];
    if (typeof score !== 'number' || typeof weight !== 'number') continue;
    const sign = weight < 0 ? '-' : terms.length ? '+' : '';
    const w = Math.abs(weight);
    terms.push(`${sign} ${w}*${score}`.trim());
    products.push(`${weight < 0 ? '-' : ''}${(Math.abs(weight * score)).toFixed(2)}`);
  }
  return `${terms.join(' ')} = ${products.join(' ')} = ${weightedTotal(dimensions, weights).toFixed(2)}`;
}

/**
 * Re-rank a candidate list under a (possibly edited) weight vector.
 * Ties break on legibility, then on lower legal risk — the same priorities the rubric encodes.
 *
 * @param {Array<{story_id:string, dimensions:object}>} candidates
 * @param {Record<string, number>} weights
 * @returns {Array<{story_id:string, weighted_total:number, rank:number, dimensions:object}>}
 */
export function rerank(candidates, weights) {
  return [...(candidates ?? [])]
    .map((c) => ({ ...c, weighted_total: weightedTotal(c.dimensions, weights) }))
    .sort(
      (a, b) =>
        b.weighted_total - a.weighted_total ||
        (b.dimensions?.legibility?.score ?? 0) - (a.dimensions?.legibility?.score ?? 0) ||
        (a.dimensions?.legal_risk?.score ?? 0) - (b.dimensions?.legal_risk?.score ?? 0)
    )
    .map((c, i) => ({ ...c, rank: i + 1 }));
}

/**
 * Floors are gates, not preferences — a candidate below them is excluded regardless of total.
 * @param {Record<string, {score:number}>} dimensions
 * @param {{legibility_min?:number, legal_risk_max?:number, shelf_life_min?:number}} floors
 * @returns {string[]} the floors breached, empty if none
 */
export function floorBreaches(dimensions, floors = {}) {
  const out = [];
  const leg = dimensions?.legibility?.score;
  const risk = dimensions?.legal_risk?.score;
  const shelf = dimensions?.shelf_life?.score;
  if (floors.legibility_min != null && typeof leg === 'number' && leg < floors.legibility_min) {
    out.push(`legibility ${leg} is below the floor of ${floors.legibility_min} — it will not read in one frame`);
  }
  if (floors.legal_risk_max != null && typeof risk === 'number' && risk > floors.legal_risk_max) {
    out.push(`legal risk ${risk} exceeds the ceiling of ${floors.legal_risk_max} — standards desk before concept work`);
  }
  if (floors.shelf_life_min != null && typeof shelf === 'number' && shelf < floors.shelf_life_min) {
    out.push(`shelf life ${shelf} is below the floor of ${floors.shelf_life_min} — stale by publication`);
  }
  return out;
}
