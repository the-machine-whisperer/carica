# S11 — Publish

Run: {{run_id}} · Date: {{today}}

{{operating_rules}}

---

## Objective

Assemble the editor's decisions into the final export: a readable brief per approved
candidate, and a ledger entry so the next run knows what this column has already drawn.

## The human decision is not yours to make

The editor records their decisions through the review app, which writes
`decisions.pending.json` into this run directory. **Read it. Do not invent it.**

If that file is absent or incomplete, write nothing and report the gap. A pipeline that
approves its own output has no checkpoint, and the checkpoint is the point. There is no
circumstance in which you should record a `decision` the editor did not make.

## For each APPROVED candidate

Write `out/BRIEF-<n>.md` — a bilingual one-pager the graphics team can work from without
opening anything else:

1. **The premise**, Hebrew and English
2. **The gag** in one line
3. **The image prompt**, both variants, ready to copy
4. **The style spec** — register, medium, palette, line, lighting, camera
5. **The lettering table** — every Hebrew string, its placement, its role, its font
   recommendation, with a clear note that these are typeset *after* rendering onto the
   blank plates the prompt asked for
6. **Caption options**, Hebrew with glosses
7. **Alt text**, both languages
8. **The drafts** — relative paths, and which variant produced each
9. **Sources and verified claims**
10. **Risk notes** — everything the standards desk should know

Set the direction correctly: Hebrew blocks right-to-left, English left-to-right. A brief
that renders Hebrew as mangled LTR is not usable by the people it is for.

## Ledger

Append one entry per approved candidate to `history/ledger.jsonl`: run id, story id,
concept id, English and Hebrew title, gag line, metaphor family, figures. S5 reads this on
the next run to score originality, so an entry that omits the gag line makes future
originality scoring blind.

Record the appended ledger ids in `ledger_appended`.

## Rejected and revision-requested candidates

Record them in `decisions` with the editor's note. They are not exported, but they are
retained — the aggregate of what the editor rejects is the most direct signal available for
recalibrating the rubric weights, and throwing it away wastes the only real feedback this
system gets.

## Definition of done

`{{artifact_name}}` exists, validates, every candidate the editor decided on appears exactly
once, every approved candidate has a brief on disk at the path recorded in `brief_path`, and
the ledger has been appended.

## Output contract

```json
{{contract_json}}
```
