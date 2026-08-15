# S2 — Harvest (one outlet)

Run: {{run_id}} · Date: {{today}}

{{operating_rules}}

---

## Objective

Fetch the recent **political** items from exactly one outlet: **{{shard_label}}**
(`{{shard_key}}`). Other agents are harvesting the other outlets in parallel. Stay in your
lane — do not fetch from outlets that are not yours, or the merge will double-count.

## Your outlet

```json
{{shard_context}}
```

## Window

Items published in the **last 72 hours**, as of {{today}}. A semi-weekly column publishes
against a 3-4 day horizon; older items are handled by the shelf-life dimension downstream,
but they should not dominate the harvest.

## Method

The fetching is your own work. There is no configured client and no API key anywhere in this
pipeline — you use the tools you have in this sandbox (HTTP fetch, a browser, a shell) and
what you can open is what this stage knows. When a route fails, try another **free, open,
no-login** one; never a paid archive, a syndication service or anything wanting an account.

1. Fetch the outlet's feeds — prefer the politics-specific section where one exists.
2. If the feeds are thin or dead, fall back to the outlet's politics index page, **only if
   robots.txt permits it**. Record `robots_allowed` honestly either way.
   Still nothing — a moved feed, a bot wall, a JS-only page? Work down the open routes: the
   site's own `sitemap.xml` / news sitemap, the section landing pages, the outlet's public
   social or Telegram web view, an open news-search or aggregator result that links back to
   the canonical URL, or the public web archive for a page that has since moved. Record which
   route produced each item in its evidence line — a title harvested from an aggregator is a
   weaker observation than one read off the outlet, and the editor should be able to see that.
3. For each item capture: title (verbatim, in its original language and script), dek,
   byline, canonical URL, publish time, section.
4. **Language and direction.** Hebrew titles are stored as-is with `dir: "rtl"`. Do not
   transliterate, do not translate here, and do not strip or reorder characters. Set
   `title_lang` accurately — Israeli outlets mix Hebrew, English and occasionally Arabic.
5. **Excerpts.** A fair-use excerpt of the opening only, capped at 1200 characters. If the
   outlet is paywalled, take the headline and dek and set `paywalled: true`. **Never
   circumvent a paywall** — not by AMP, not by cache, not by a print view, not by a
   googlebot user agent. This is a hard boundary, not a performance target.
6. **Engagement.** Where the outlet exposes comment or share counts cheaply, capture them
   with `observed_at`. Do not guess them. A missing count is fine; a fabricated one is a
   stage failure.

## Failure is reportable, not fatal

If your outlet is down, blocks you, or has no usable feed and the open routes above are
exhausted, write your artifact anyway with an empty `items` array and an `outlet_status` row
that says `ok: false` with the error — naming the routes you tried, so the next run does not
repeat them blind. A recorded gap is information. A silent omission is a lie about coverage.

## Definition of done

`{{artifact_name}}` exists, validates, and contains exactly one `outlet_status` row — for
your outlet — plus whatever items you found, each with an `evidence_id` resolving to the
fetch that produced it.

## Output contract

```json
{{contract_json}}
```
