# Fixtures

Frozen snapshots for offline runs: `carica run --replay fixtures/<snapshot>`.

A replay copies each artifact into a fresh run directory and puts it through **exactly the
same validation** a live agent's output faces — schema plus evidence contract. No network,
no API cost, no Codex CLI required. This is what the Phase 0 gate exercises and what CI runs.

## `2026-08-11_sample`

**Synthetic test data.** The outlet names are real; the stories, quotes, figures and
engagement numbers are invented for testing and describe nothing that happened. It exists
to exercise the contracts end to end, not to be believed.

It deliberately includes the awkward cases:

- a **failed outlet** in `outlet_status` (a recorded gap, not a silent omission)
- a **Hebrew name merge** in `name_variants_merged` — the judgement naive dedup cannot make
- a `partially_verified` claim and a **stripped claim** carried through to S8
- a **REVISE** verdict with actionable asks alongside a PASS
- a **refused named variant** falling back to the attribute variant in S10
- a **rejected** candidate at the human checkpoint, retained rather than discarded

If you change a contract, run the replay first. It will tell you what you broke.
