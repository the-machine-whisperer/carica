# S10 — Draft render (one approved concept)

Run: {{run_id}} · Date: {{today}}

{{operating_rules}}

---

## Objective

Generate the **first visual draft**. The graphics team should open their morning to a
validated prompt and a real image, not a speculative paragraph — and, where no image could be
made, to a validated prompt and an honest one-line account of why.

## Your concept

`{{shard_label}}` (`{{shard_key}}`)

```json
{{shard_context}}
```

The prompt package is in `08_prompts.json`. Only gate-PASSED concepts reach you — if this
one is not PASS, stop and report it as an error rather than rendering it.

## Method

You do the rendering yourself. **There is no image API and no key** — this pipeline holds no
credentials of any kind. Use whatever image generation you can actually reach from your
sandbox: an image tool in your own toolset, a model or CLI installed on this machine, any
free generator you can drive without a login. Look before you conclude there is nothing, and
record what you tried either way. Render at the package's `aspect_ratio`, 2-3 drafts.
Whatever you used goes in each attempt's `model` field, so the trail says what drew this.

**Try the variants in order and record every attempt:**

1. `named_variant` — names the figures.
2. `attribute_variant` — on refusal, the same scene with subjects described by their
   signature attributes.
3. `archetype` — only if both are declined: the scene with generic officeholders. Note
   clearly that this loses the likeness and the graphics team will need reference images.

## Three ways an attempt can fail, and why the difference matters

Each attempt's `status` is one of `ok`, `refused`, `error` or `unavailable`. They are not
interchangeable, because the editor does something different with each:

- **`refused`** — a model looked at this request and declined it. That is a *policy signal*,
  and the editor reads the refusal text verbatim to decide whether they hit a hard boundary,
  a per-person opt-out, or a nondeterministic decline. Do not smooth it into "error".
- **`error`** — a timeout, a crash, a rate limit, a malformed response. *Transient and
  retryable*: the identical request may well work in ten minutes. Nothing has been said about
  the cartoon.
- **`unavailable`** — you could reach **no renderer at all**. Nothing looked at the request,
  so nothing has judged it. The graphics desk simply draws this one by hand.

Collapsing these three is the failure mode to avoid: it turns "the newspaper's tooling was
offline" into "a model refused to draw this minister", which is a very different conversation
to have with an editor.

## Refusals are data

When the model declines, capture the **verbatim** refusal text in `refusal_text`. Do not
paraphrase it and do not swallow it. The editor needs to know whether they hit a policy
boundary, a per-person opt-out, or a transient decline — those have completely different
remedies, and the refusal text is the only thing that distinguishes them.

Never attempt to talk the model out of a refusal by disguising the subject, splitting the
request, or reframing the intent. If all variants are declined, set
`outcome: "all_variants_refused"` and stop. That is a legitimate, reportable result and the
graphics team will render it by hand.

## When there is no renderer

If nothing in reach can generate an image, record one attempt with `variant: "named"`,
`status: "unavailable"` and an `error` string saying plainly what you looked for and what was
missing. Set the render's `outcome` to `"no_renderer_available"` and **stop there.** Do not
walk the variant ladder: the ladder exists to get around a refusal, and nothing has refused
you — three identical failures to reach a renderer are not three data points.

**A run that produces no image is still a complete, valid, useful run.** Say so, and behave
that way. The deliverable of this pipeline is the prompt package, and it is intact: both
prompt variants, the style spec, the lettering spec, the captions, the alt text, the sources
and the risk notes are all there and all gate-passed. The graphics desk draws from that
brief, as it did before this stage existed. What you must not do is fail the stage, invent an
`asset_path` for a file that does not exist, or describe an image you did not make.

## Blank plates

The prompt package instructs the renderer to leave labels, placards and speech balloons
**empty**. That is deliberate — Hebrew is typeset afterwards from `lettering_spec`. If a
draft comes back with text scrawled into the plates anyway, note it in the draft's `note`
field so the graphics team knows to clear it.

## Save the drafts

Write image files to `10_drafts/` inside this run directory, named
`<story_id>_<concept_id>_<n>.png`, and reference them by **relative** path.

## Definition of done

`{{artifact_name}}` exists, validates, holds one entry for your concept, every attempt is
recorded in order with its status, and every referenced asset actually exists on disk. An
entry with no drafts is done when its `outcome` says which of the three reasons applies.

## Output contract

```json
{{contract_json}}
```
