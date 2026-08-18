import YAML from 'yaml';

/**
 * The editor's allowlist — "run this column on these outlets only".
 *
 * WHY THIS EXISTS. The registry is a candidate universe, and on a normal news day most of
 * it is telling the same three stories. Harvesting all of it costs one agent per outlet and
 * buys duplicate coverage of the same wire copy. An editor who already knows the column is
 * being drawn from Ynet, Haaretz and N12 should be able to say so.
 *
 * WHAT IT IS NOT. It is not a claim about what exists. The pipeline never pretends an
 * outlet was consulted because it was allowed, nor that one was unavailable because it was
 * not — the artifact records what was actually harvested, and this module reports every
 * requested outlet it could not honour instead of quietly dropping it.
 *
 * The rule everywhere below: **allowed ∩ ranked**. An allowlist narrows; it never adds.
 */

/** The outlet ids the registry actually defines, in registry order. */
export function registryOutlets(outletsText) {
  let doc;
  try {
    doc = YAML.parse(outletsText ?? '');
  } catch {
    return [];
  }
  return (doc?.outlets ?? []).filter((o) => o && typeof o.id === 'string');
}

const fold = (s) => String(s ?? '').trim().toLowerCase();

/**
 * Turn whatever the editor typed into a list of ids.
 *
 * Accepts an array or a comma/whitespace-separated string, and matches an entry against an
 * outlet's id or either of its names — `haaretz`, `Haaretz`, and `הארץ` all mean the same
 * outlet, and refusing the last two would make the CLI flag unusable for a Hebrew desk.
 *
 * @returns {{ids: string[], unknown: string[]}} ids are registry ids, deduped, registry-ordered.
 */
export function resolveAllowlist(input, outletsText) {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[,\n]/)
      : [];
  const wanted = raw.map((s) => String(s).trim()).filter(Boolean);
  if (!wanted.length) return { ids: [], unknown: [] };

  const outlets = registryOutlets(outletsText);
  const byKey = new Map();
  for (const o of outlets) {
    for (const key of [o.id, o.name_en, o.name_he]) {
      if (key) byKey.set(fold(key), o.id);
    }
  }

  const ids = new Set();
  const unknown = [];
  for (const w of wanted) {
    const hit = byKey.get(fold(w));
    if (hit) ids.add(hit);
    else unknown.push(w);
  }

  // Registry order, not the order they were typed: it is the order every other stage and
  // every artifact uses, and a stable order makes runs comparable.
  const ordered = outlets.map((o) => o.id).filter((id) => ids.has(id));
  return { ids: ordered, unknown };
}

/**
 * The registry as S1 should see it, narrowed to the allowlist.
 *
 * `meta.allowlist` is stamped into the returned document on purpose: S1's charter presents
 * this YAML as "the candidate universe", and an agent handed five outlets with no
 * explanation may reasonably conclude the Israeli press has five outlets and say so in its
 * notes. Telling it the universe was narrowed by an editor is the difference between a
 * ranking of a selection and a ranking that claims to be of everything.
 */
export function narrowOutletsYaml(outletsText, ids) {
  if (!ids?.length) return outletsText;
  const doc = YAML.parse(outletsText ?? '');
  const keep = new Set(ids);
  const all = doc?.outlets ?? [];
  doc.outlets = all.filter((o) => keep.has(o?.id));
  doc.meta = {
    ...(doc.meta ?? {}),
    allowlist: {
      applied: true,
      kept: doc.outlets.length,
      of_registry: all.length,
      note:
        'An editor restricted this run to these outlets. This is a deliberately narrowed ' +
        'candidate universe, not the whole Israeli press — rank what is here, and do not ' +
        'describe the result as a ranking of the market.',
    },
  };
  return YAML.stringify(doc);
}

/**
 * S1 ranks at least five outlets (`01_outlets.schema.json`, `outlets.minItems`) so that a
 * ranking cannot come out thin by accident. An allowlist of three is not an accident, but
 * the schema cannot tell the two apart — so below the floor we leave S1 looking at the
 * whole registry and narrow only the harvest, which is where the per-outlet agents (and
 * the redundancy the editor is complaining about) actually are.
 */
export const MIN_RANKED_OUTLETS = 5;

export function narrowsRanking(ids) {
  return ids.length >= MIN_RANKED_OUTLETS;
}

/**
 * allowed ∩ ranked, for the harvest fan-out.
 *
 * @param {Array<{id: string}>} ranked outlets as S1 actually ranked them
 * @param {string[]} ids resolved allowlist ids ([] means "no allowlist")
 * @returns {{kept: any[], skipped: string[], missing: string[]}}
 *   skipped: ranked but not allowed. missing: allowed but never ranked.
 */
export function intersectRanked(ranked, ids) {
  const list = ranked ?? [];
  if (!ids?.length) return { kept: list, skipped: [], missing: [] };
  const allow = new Set(ids);
  const kept = list.filter((o) => allow.has(o?.id));
  const skipped = list.filter((o) => !allow.has(o?.id)).map((o) => o?.id);
  const rankedIds = new Set(list.map((o) => o?.id));
  const missing = ids.filter((id) => !rankedIds.has(id));
  return { kept, skipped, missing };
}
