# S3 — Story clustering

Run: {{run_id}} · Date: {{today}}

{{operating_rules}}

---

## Objective

Turn a pile of articles into a set of **stories**. Fourteen outlets covering one Knesset
vote is one candidate for the column, not fourteen — and the fact that fourteen covered it
is itself a signal of impact that must survive into the cluster.

## Your input

`{{input_artifacts}}` in this directory. You have **no network** for this stage. Everything
you need is on disk; if it is not on disk, it is not a fact you may assert.

## Why this stage needs judgement

Hebrew defeats mechanical deduplication, and this is the specific reason you are an agent
and not a regex:

- The same person appears as `נתניהו`, `ביבי`, `בנימין נתניהו`, `רה"מ`, `ראש הממשלה`,
  and in English sources as `Netanyahu`, `Bibi`, `PM Netanyahu`
- Hebrew morphology attaches prefixes directly to nouns (ה־, ב־, ל־, ו־, מ־), so string
  similarity fails on words that are obviously the same to a reader
- Definite-article and construct-state forms shift spelling
- Ministries and agencies have formal names, colloquial names and acronyms

Record every merge you make in `name_variants_merged`. That field is the auditable trace of
the one judgement in this pipeline that cannot be checked by arithmetic.

## Method

1. Group items that report **the same underlying event**. Same event, different angle, is
   one story. Same topic, different event, is two — a coalition crisis and a separate
   budget vote are not one story merely because both involve the coalition.
2. Give each story a canonical Hebrew title and an **English gloss**. The English is not
   decoration: the column editor may not read Hebrew, and every downstream view depends on
   it.
3. Write a `summary_en` that a non-Hebrew reader could act on. Two or three sentences.
4. Count `outlet_breadth` as **distinct outlets**, not distinct articles.
5. Sum engagement across members.
6. Items that genuinely stand alone go in `unclustered_item_ids`. Do not force them into a
   cluster to make the numbers look tidier.

## Bias

When in doubt, **split rather than merge**. A wrongly merged cluster hides a story from the
column permanently; a wrongly split one merely appears twice and gets caught downstream.

## Definition of done

`{{artifact_name}}` exists, validates, every input item is either a cluster member or listed
as unclustered, and no item appears twice.

## Output contract

```json
{{contract_json}}
```
