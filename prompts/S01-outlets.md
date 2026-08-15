# S1 — Outlet ranking

Run: {{run_id}} · Date: {{today}}

{{operating_rules}}

---

## Objective

Rank Israeli news outlets by how much they actually matter **right now**, so downstream
stages harvest from the outlets that shape the national conversation rather than from an
alphabetical list.

## Your inputs

The curated registry below. It is a **candidate universe with slow-moving metadata**, not a
ranking, and its feed URLs are **seeds that go stale**.

```yaml
{{outlets_yaml}}
```

## What "reach" honestly means here

Measured traffic is a paid product. **This pipeline holds no API keys and never will** —
there is no credentialled data service waiting behind an environment variable, and you are
not going to be handed one. What you can get for free is a *proxy* for traffic, gathered by
reading open, no-login sources yourself. That is enough to rank outlets. It is not enough to
call the numbers measured.

Set `data_basis` truthfully:

- `public_ranking_pages` — every reach number came from open ranking or analytics preview
  pages you read yourself. A proxy, and the honest default.
- `mixed` — reach numbers came from more than one class of free source: a ranking page for
  one outlet, the outlet's own published audience figures for another, a survey summary for a
  third. Say which is which in `notes`.

A ranking built from proxies and labelled as such is useful. A ranking built from proxies
and presented as measured traffic is a lie that a newspaper would have to correct.

**A proxy must be labelled a proxy at the point of use, not only in `data_basis`.** Every
signal's `unit` says what the number literally is — "free-tier global rank", "modelled
monthly visits, vendor estimate", "self-reported monthly uniques, outlet media kit" — so a
reader of the artifact can tell a measurement from a guess without leaving the row.

## You are the fetcher

Nothing in this pipeline fetches on your behalf. There is no client, no key, no configured
account: whatever you can reach with the tools in your own sandbox — an HTTP fetch, a
browser, a shell — is what this stage knows. Where a source will not open to you, go around
it through **another free, open, no-login source**. Never reach for anything that wants a
login, a key or a card. If a number exists only behind one of those, then for this run that
number does not exist, and you say so instead of estimating it into being.

## Method — yours to choose, but cover these

1. **Verify the feeds.** Fetch each feed in the registry. Set `verified: true` only for
   feeds that returned 200 and parsed as RSS/Atom. A dead feed is a finding: record it, do
   not quietly drop the outlet. If you find a working replacement path, use it and record
   how you found it.
2. **Reach** — per outlet, from whatever open sources you can actually open today. The
   durable classes, roughly in order of how much they are worth:
   - **Public ranking and analytics preview pages.** The traffic-analytics vendors put a
     domain's rank, and often a modelled visit estimate, on a public page before the sign-up
     wall. Open web-ranking lists and statistical/encyclopaedic summaries carry the same kind
     of figure with a date attached. Record a position as `public_traffic_rank` and a modelled
     visit count as `estimated_monthly_visits`; where the page is a named vendor's own free
     preview, `semrush_rank` and `ahrefs_traffic` say so more precisely — use them.
   - **The outlet's own published figures.** Media kits, rate cards, advertising and
     "about" pages, audience claims made in its own reporting. Self-reported and
     self-interested — worth having, worth labelling as such in `unit`.
   - **Survey and panel summaries** published openly (TGI/Kantar exposure percentages and the
     press coverage of them) → `tgi_exposure_pct`.
   - **Open aggregators and directories** of Israeli media, and cross-citation counts — how
     often the rest of the press cites this outlet → `cross_citation`. A small outlet everyone
     quotes has reach that no traffic figure shows.

   **This charter deliberately names no URLs.** Ranking sites rename, redirect and move
   things behind sign-up walls without notice, so a hard-coded address is a stale address and
   a stale address is a dead stage. Find the source yourself each run, and record the URL you
   actually opened in the evidence line. Where you can only get a rank and not a visit
   count, record the rank; a real rank beats an invented number every time.
3. **Engagement** — the signal reach misses. Talkback/comment volume where exposed
   (Ynet and Mako make this cheap) → `talkback_volume`; publicly displayed share and reaction
   counts → `social_footprint`; presence on Rotter.net Scoops → `rotter_mentions`; public
   Telegram channels, which have an open web view that needs no account. Rotter is a
   **velocity** signal for controversy and is wildly unrepresentative — never treat it as
   public opinion.
4. **Authority** — start from `authority_prior` (TGI/Kantar exposure, annual, print-and-radio).
   Adjust only with evidence. Note that free-distribution papers over-index on print
   exposure relative to web reach, and that agenda-setting outlets like Haaretz punch above
   their traffic.
5. **Composite** — combine into `composite_score` and rank. State your combination rule in
   `notes`, including how you traded a rank off against a visit estimate when an outlet had
   only one of them. Any weighting is defensible if it is stated; none is defensible if it is
   hidden.

## Respect these boundaries

- No key, no login, no payment, no trial sign-up. A source that asks for an account is not a
  source for this pipeline.
- Check robots.txt before fetching anything beyond a declared feed, and record the result.
- Rate-limit yourself. You are a guest on these servers.
- Never attempt to get behind a paywall. Haaretz is `paywall: hard` — headline and dek only.

## Definition of done

`{{artifact_name}}` exists, validates against the contract below, and:

- every outlet in the registry is either ranked or listed in `excluded` with a reason
- every score traces to at least one signal, and every signal carries an `evidence_id`
  resolving to a line in the evidence file that names the page you actually opened — an
  evidence record you wrote for a fetch you did not make is worse than no number at all
- every signal's `unit` says what the figure literally is, so a proxy reads as a proxy
- `data_basis` states honestly where the reach numbers came from
- feeds are marked `verified` only if you actually fetched them

## Output contract

Your file must validate against this schema:

```json
{{contract_json}}
```
