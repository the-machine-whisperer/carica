# S7 — Concept ideation (one candidate)

Run: {{run_id}} · Date: {{today}}

{{operating_rules}}

---

## Objective

Invent **three genuinely different cartoons** for one story, then pick the best one and say
why. Other agents are working the other candidates in parallel.

## Your candidate

`{{shard_label}}` (`{{shard_key}}`)

```json
{{shard_context}}
```

Read the story cluster, the scoring rationale and the verification result from the
artifacts in this directory. **Claims listed in `stripped_claims` are off the table** — you
may not build a joke on them, and you may not gesture at them either.

## Three concepts, from three different metaphor families

Pick from: classical allegory · mundane domestic · machine/apparatus · theatre/stage ·
natural force · sport/contest · medical/clinical · childhood/playground.

Three variations on one idea is a **failure of this stage**. If all three of your concepts
put the same people in the same room doing slightly different things, you have produced one
concept and two drafts of it. Force yourself onto genuinely different ground: if concept A
is a courtroom, concept B should not be a tribunal.

## Each concept needs

- **`gag_line`** — the joke in one sentence. If you cannot say it in one sentence, it will
  not read in one frame. Write this first; if it is not funny or pointed as a sentence, no
  amount of rendering will save it.
- **`metaphor`** — what stands for what, and why that mapping is apt rather than arbitrary.
- **`cast`** — who is in the frame and, for each, their `caricature_handles`.
- **`composition`** — the physical arrangement. Who is large, who is small, who is centre.
- **`read_order`** — what the eye hits first, second, third. Legibility is designed, not
  hoped for. A cartoon where the joke is discovered fourth has failed.
- **`lettering_plan`** — any Hebrew text in the frame, and where. Keep it minimal: a label,
  a placard, at most one short speech balloon. Text carrying the whole joke means the image
  is not carrying it.

## Caricature handles — read this carefully

Recognisability comes from **signature attributes the subject has chosen or is publicly
known for**: eyewear, hairstyle, posture, gait, a habitual gesture, characteristic dress, a
known prop, the setting of their office.

It **never** comes from nose, lips, skin tone, hair texture, cranial shape, disability,
illness, weight, or ageing rendered as decay.

This is an ethics rule and a craft rule at once. Physiognomic caricature is what a
cartoonist reaches for when they have not found the actual joke. You are declaring your
handles in a structured field precisely so this is checkable rather than a matter of
impression.

## The prohibitions

The full editorial policy is below. §2 is absolute — a concept touching it is not revised,
it is destroyed. Note especially §2.1: this column draws Israeli politicians, the drawing
will travel internationally, and imagery legible as satire of a government in one country
is legible as a racial slur in another. **Intent is not a defence.** If a metaphor is merely
*adjacent* to a prohibited trope and a different metaphor would carry the same joke, use the
different metaphor — the burden is on the concept, not on the reader.

```markdown
{{editorial_policy}}
```

## Then choose

Set `selected_primary` and `selected_alternate`, and write a `critique` that gives the
reason the primary won **and the strongest objection to it**. An honest objection here is
worth more to the editor than a confident endorsement.

## Definition of done

`{{artifact_name}}` exists, validates, holds exactly one entry for your candidate with at
least three concepts from distinct metaphor families, and every cast member has declared
handles.

## Output contract

```json
{{contract_json}}
```
