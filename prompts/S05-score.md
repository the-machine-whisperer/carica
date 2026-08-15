# S5 — Caricature fitness scoring

Run: {{run_id}} · Date: {{today}}

{{operating_rules}}

---

## Objective

Score every triaged story on nine dimensions and rank them. This artifact is what the
column editor actually reads, and it is the direct answer to the question *"why these
stories and not the others?"* — so the justifications matter as much as the numbers.

## Your input

`{{input_artifacts}}` plus the story clusters. No network.

## Weights

```yaml
{{weights_yaml}}
```

Echo these into your `weights` object verbatim. **Emit sub-scores and weights separately
and show the arithmetic** — the editor re-weights in the review app and re-ranks without
re-running you. A total you cannot decompose is a total nobody can argue with, which makes
it useless.

## What this column has already drawn

```json
{{ledger_digest}}
```

---

## The rubric

Score each dimension **0-10** with a justification saying why this score and not one point
higher or lower. Attach a verbatim Hebrew quote plus an English gloss wherever the score is
text-derived.

**Use the full range.** If every candidate scores 6-8 you have not ranked anything, you
have described a pile. A rubric that does not separate is a broken instrument. Expect a
typical slate to include genuine 2s and the occasional 9.

### 1. Legibility — *can it be read in one frame, without a caption?* (weight 0.20)

The highest-weighted dimension and the one most often forgotten. Ridiculousness and spice
pick topics; legibility decides whether the cartoon works.

- **0-2** — no visual handle at all. An abstraction, a percentage, a procedural step.
- **5** — a recognisable cast and a setting, but the idea needs explaining.
- **8-10** — a recognisable cast, an existing piece of iconography, and a physical object or
  place the metaphor can be built on. The reader gets it before they read the caption.

Ask concretely: *who is in the frame, what object is in their hands, where are they standing?*
If you cannot answer all three, it is below 5.

### 2. Absurdity (0.15)

Is there an **inherent contradiction** in the events themselves? Not "is this bad" but "is
this ridiculous". The best political cartoons find a story that has already caricatured
itself.

- **0-2** — serious, coherent, nothing self-undermining.
- **8-10** — the participants' own conduct contains the joke; a straight rendering would
  already look like satire.

### 3. Comedic mechanism (0.15)

Is there an actual **joke** — a reversal, an irony, a literalised metaphor, a gap between
stated and revealed motive — or merely a topic people are angry about?

Outrage is not comedy. If your justification here is "people are furious about this", the
score is low. Name the mechanism explicitly or score below 4.

### 4. Spice (0.12)

Does it **cut at power**? Direction matters more than intensity.

- **8-10** — aims squarely at an officeholder's exercise of power, and would make them
  uncomfortable to see over breakfast.
- **0-2** — aims at the powerless, or at nobody. A caricature that punches down is not
  spicy, it is cruel, and it is outside this column's remit.

### 5. Impact (0.12)

Consequence magnitude. Who is affected, how many, how irreversibly. A procedural squabble
with no consequence scores low however entertaining.

### 6. Shelf life (0.10)

Will this still land at publication, **3-4 days out**? The Israeli news cycle is fast.

- **0-2** — resolves tomorrow; dead on arrival.
- **8-10** — a structural or running story that will still be live next week.

### 7. Controversy (0.10)

Talkback volume, cross-outlet breadth, polarisation. Use the engagement numbers you were
given. Do not invent them — cite the cluster's totals.

### 8. Originality (0.06)

Check against the ledger above. Score low where this column has drawn the same gag,
metaphor family or cast in the last 90 days, and list the conflicts in
`originality_conflicts`. Readers notice repetition before editors do.

### 9. Legal risk — **negative weight** (-0.20)

Higher score means **more** risk. Consider: defamation exposure under Israeli law (statutory
damages without proof of harm — the bar is lower than US instincts suggest), `censor_risk`
and `sub_judice` flags from S4, whether the story pulls toward any §2 prohibited trope, and
whether the joke depends on a contested allegation.

- **0-2** — public conduct, on the record, uncontested.
- **8-10** — turns on an unproven allegation, or sits near a prohibited trope.

---

## Floors

Apply the floors in the weights file. A candidate below `legibility_min`, above
`legal_risk_max`, or below `shelf_life_min` is ranked but must say so plainly in
`verdict_summary` — the editor decides, not you.

## Definition of done

`{{artifact_name}}` exists, validates, every kept story from S4 is scored, `rank` is dense
and starts at 1, and `arithmetic` shows the actual sum for each candidate.

## Output contract

```json
{{contract_json}}
```
