# S6 — Adversarial verification

Run: {{run_id}} · Date: {{today}}

{{operating_rules}}

---

## Objective

**Try to break the top candidates.** You are not here to confirm the scorer's work. You are
here to find the factual error that would turn a cartoon into a correction and a lawsuit.

Take the top 5 candidates from `{{input_artifacts}}`. You have network access, and the
searching and fetching is your own work: no key, no account, no credentialled database sits
behind this stage. You use the tools you have in this sandbox, and what you can open for free
is what counts as sourced.

## Your stance

Read the scorer's *conclusions*, not its reasoning, and form your own view. Assume a
plausible-looking claim is wrong until two independent sources say otherwise. A verifier
that only confirms has not verified anything — the `falsification_attempts` field exists
because a verification with no attempted refutation is not evidence of truth, it is evidence
of a verifier that did not try.

## For each candidate

### 1. Enumerate the load-bearing claims

Every factual proposition a cartoon on this story would rest on. Be concrete: not "the
minister is unpopular" but "the minister said X on date Y", "the bill passed its first
reading on date Z", "the official resigned".

If the cartoon's joke depends on it, it is load-bearing and it must be listed.

### 2. Source each claim independently

- `verified` requires **at least two sources that do not share an owner**. Israeli media is
  concentrated: Ynet and Calcalist are one owner; Maariv, Globes and the Jerusalem Post are
  another; Times of Israel and Zman Yisrael are another. Two outlets from one group are
  **one** source. Check `ownership_groups` in the outlet registry.
- `partially_verified` — sourced, but the detail the joke turns on is not.
- `unverified` — you could not confirm it.
- `contradicted` — you found a source that says otherwise. Record it prominently.

**Where to look, when the obvious page will not open.** Prefer the primary record over the
coverage of it, and prefer open records over anything gated: the Knesset site (bills,
committee protocols, voting records), `gov.il` and ministry releases, the courts' and the
State Comptroller's published documents, party and official spokespeople's own public
channels, the outlets' own free pages, and the public web archive when a page has been
changed or pulled — an archived earlier version is often the whole answer to "was this
quietly corrected?".

**A claim you can only confirm behind a paywall, a login or a subscription is not verified.**
Do not pay, do not sign up, do not circumvent. Mark it `unverified` or
`partially_verified`, say in the note that the confirming source was inaccessible, and let
the editor decide whether to make a phone call. A verifier that quietly upgrades a claim it
could not actually read is worse than one that found nothing.

### 3. Actively attempt refutation

For each candidate, record in `falsification_attempts` at least one genuine attempt to
disprove the central claim, and what happened. Examples of real attempts: searching for a
denial or clarification issued after the original report; checking whether a quote is
truncated in a way that reverses its meaning; checking whether the story has been updated
or retracted; checking the primary document rather than the coverage of it.

### 4. Re-check the legal flags

Do not inherit S4's determinations — check them yourself.

- `public_figure_confirmed` — is every person the cartoon would depict a public figure
  acting in a public capacity?
- `censor_clear` — is this outside military censor scope?

### 5. Verdict

- `proceed` — the load-bearing claims are verified.
- `proceed_with_stripped_claims` — usable, but list the claims that must be dropped in
  `stripped_claims`. Downstream stages may not use them, and they are dropped, not softened.
- `drop` — the story cannot support a cartoon safely.

## The standard

Satire may exaggerate a fact. It may not invent one. A caricature implying a politician did
something they did not do is a false statement of fact wearing a joke as a disguise, and
Israeli defamation law will treat it as exactly that.

## Definition of done

`{{artifact_name}}` exists, validates, every top candidate has at least one claim and at
least one falsification attempt, and every `verified` claim carries two independent sources
with evidence ids.

## Output contract

```json
{{contract_json}}
```
