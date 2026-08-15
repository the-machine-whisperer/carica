# S8 — Prompt synthesis (one candidate)

Run: {{run_id}} · Date: {{today}}

{{operating_rules}}

---

## Objective

Turn the selected concept into the **prompt package the graphics team works from**. This is
the pipeline's deliverable. Everything upstream exists to make this file good.

## Your candidate

`{{shard_label}}` (`{{shard_key}}`)

```json
{{shard_context}}
```

Build the package for `selected_primary`. If the gate previously returned REVISE for this
candidate, the revision asks are in `09_gate.json` — address every one and set
`revision_of`.

---

## Writing the image prompt

The renderer is whatever image model S10 can reach, and on a bad day it is a human at the
graphics desk reading this package instead. Write for both. Two things follow.

**Write prose, not tags.** These models respond to a described scene, not to comma-separated
keywords. "A cabinet room where the table has been sawn in half, the ministers on either
side still passing papers across the gap as though nothing has happened" beats
"cabinet, table, split, ministers, satire, ink drawing".

**Write two variants of the same scene.**

- **`named_variant`** — names the figures. Public-figure satire is permitted by current
  policy, but refusals remain nondeterministic and individuals can opt out of depiction.
- **`attribute_variant`** — the identical scene with subjects identified by their signature
  attributes and roles instead of names ("the prime minister, silver-haired, in a dark suit
  and blue tie"). This is the fallback S10 tries when the named variant is declined, and it
  must stand on its own as a complete prompt — not a diff against the first.

Both must be genuinely renderable: subject blocking, camera height, what is in the
foreground and background, what each figure is doing with their hands.

## Style

Fill `style` concretely. The register is a broadsheet editorial cartoon — the tradition of
Dosh, Ze'ev and Biderman in the Israeli press: economical line, strong silhouette, the joke
carried by drawing rather than by rendering. Specify medium, palette, line quality,
lighting, and camera height. **Camera height is not a detail** — eye level decides who reads
as powerful, and getting it backwards inverts the politics of the drawing.

## Hebrew lettering — the rule that decides whether the draft is usable

Image models render right-to-left Hebrew unreliably: reversed, malformed, or as
plausible-looking nonsense that a non-reader will not catch.

Therefore:

1. `blank_plate_instruction` is **mandatory** and must instruct the renderer to leave all
   label plates, placards, signs and speech balloons **empty** — drawn, positioned, sized,
   but blank.
2. Every piece of Hebrew text goes in `lettering_spec` instead, with the exact string, its
   placement relative to the blank plate, its role, and a font recommendation. The graphics
   team typesets it afterwards.
3. Your image prompt must **not** ask the model to render Hebrew text. A package that does
   is returned by the gate as REVISE.

## The rest of the package

- **`premise_he` / `premise_en`** — the editorial premise in one line each.
- **`negative_list`** — start from the §2 hard prohibitions relevant to this concept, then
  add concept-specific exclusions (things this particular scene could drift into).
- **`captions`** — two to four Hebrew kicker options with English glosses and a tone note.
  Give the editor a choice; do not pick for them.
- **`alt_text_he` / `alt_text_en`** — mandatory. Describe what is depicted for a reader who
  cannot see it, including the joke. Alt text that omits the joke is not accessible.
- **`sources`** — the URLs behind the story. A brief without sources does not pass.
- **`verified_claims`** — only claims S6 marked `verified`. Nothing else. Ever.
- **`risk_notes`** — everything the editor should know before saying yes: defamation
  exposure, censor or sub judice flags, any trope adjacency you deliberately steered away
  from, opt-out risk on a named figure.

## Definition of done

`{{artifact_name}}` exists, validates, holds exactly one package for your candidate, both
prompt variants stand alone, and no Hebrew text is requested inside the image.

## Output contract

```json
{{contract_json}}
```
