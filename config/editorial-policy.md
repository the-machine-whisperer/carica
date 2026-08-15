# Editorial policy — political caricature column

**Status:** DRAFT — pending sign-off by the paper's standards desk and legal counsel.
**No caricature produced by this pipeline may be published before that sign-off.**

S9 (the editorial gate) adjudicates every prompt package against this document clause by
clause and must cite the specific clause for every verdict. The SHA of this file is
recorded in `09_gate.json`, so it is always knowable which version of the rules applied.

---

## §1 What this column is

Satire directed at **power**: officeholders, candidates, party leaders, senior officials,
and institutions, in respect of their **public conduct**. The licence to exaggerate,
ridicule and offend is at its widest here and it is the reason the column exists.

That licence narrows sharply as the target's power decreases. A caricature that punches
downward — at a minority, at the poor, at private individuals, at victims — is not spicy.
It is merely cruel, and it is outside this column's remit.

**The test, applied to every candidate:** *is the object of the ridicule the exercise of
power, or is it a group of people?* If the latter, BLOCK.

---

## §2 Hard prohibitions — automatic BLOCK

These are not balancing factors. A concept touching any of them is blocked outright and
does not proceed to revision.

### §2.1 Antisemitic visual tropes

This column caricatures Israeli politicians. The drawing will circulate internationally
and will be read by audiences who do not share its context. Imagery that is legible as
satire of a *government* in Tel Aviv can be legible as a slur against *Jews* in Paris or
Ohio. Major newspapers have destroyed careers and issued abject apologies over exactly
this failure — the *New York Times* international edition in 2019, the *Guardian* in 2023.
Both were about individual Israeli politicians. Neither cartoonist intended the reading.
**Intent is not a defence and is not considered by the gate.**

BLOCK on any of:

- Exaggerated or hooked noses, or any facial feature rendered in a way that codes "Jewish"
  rather than "this specific person"
- Blood, blood-drinking, child-harm or well-poisoning imagery in any form
- Puppetry, marionettes, strings, or a figure controlling a larger figure or a nation
- Octopuses, spiders, webs, tentacles, or any creature-with-global-reach metaphor
- Vermin, insects, rats, parasites, disease — applied to any person or group
- Money, gold, banking or usury imagery attached to a Jewish figure as such
- Hidden-hand, cabal, or shadow-government-controlling-world-events framing
- Religious symbols (Star of David, menorah, tefillin, kippah) used as a mark of villainy
  rather than as neutral factual detail

### §2.2 Dehumanising imagery of any ethnic, national or religious group

The same prohibitions apply, in full and without exception, to Arabs, Palestinians,
Mizrahi Jews, Ethiopian Israelis, Druze, Bedouin, Haredim, Russian-speaking Israelis,
migrants and asylum seekers. Animal metaphors, vermin imagery, physiognomic caricature
and mass-undifferentiated-horde depictions are prohibited for every group.

An individual Haredi politician may be caricatured for their conduct. "Haredim" as a
mass may not be caricatured at all.

### §2.3 Holocaust imagery applied to contemporary politics

No camps, cattle cars, striped uniforms, yellow stars, gas, selection ramps, or Nazi
uniforms and insignia placed on living political figures. This is prohibited regardless
of the politician's own rhetoric and regardless of who in the current debate has invoked
it first.

### §2.4 Religious desecration

No depiction of Torah scrolls, the Qur'an, prayer, holy sites or religious ritual being
defiled, mocked or destroyed. Religious *politics* is fully open to satire; religious
*sanctity* is not the target.

### §2.5 People who are not the story

- **Private individuals** — anyone not exercising public power. BLOCK.
- **Minors** — including politicians' children, in any depiction. BLOCK.
- **Victims of crime, terror, war or disaster**, and their families, as objects of
  ridicule. Their situation may be depicted with gravity; they may not be the joke. BLOCK.
- **Hostages and their families.** BLOCK as objects of ridicule, without exception.

### §2.6 Sexualised or bodily-degrading depiction

No sexualised depiction of any real person. No nudity, sexual humiliation, or focus on
bodily functions as the mechanism of the joke. Physical disability, illness, weight and
disfigurement are not caricature handles — see §3.

### §2.7 Incitement

Nothing that depicts, celebrates or invites violence against an identifiable person or
group. A figure depicted as *defeated* is satire; a figure depicted as *deserving harm* is
not, and the distinction is drawn conservatively.

---

## §3 Caricature craft — handles, not physiognomy

Recognisability must come from **signature attributes the subject has chosen or is
publicly known for**:

- Eyewear, hairstyle, a habitual gesture, posture, gait
- Characteristic dress, a known prop, a repeated verbal tic rendered visually
- Setting and role — the podium, the cabinet table, the courtroom

Recognisability must **never** come from:

- Nose, lips, skin tone, hair texture, cranial shape, or any feature that reads as ethnic
- Disability, illness, obesity, disfigurement, or ageing rendered as decay

This is both an ethics rule and a craft rule. Physiognomic caricature is lazy: it is what
a cartoonist reaches for when they have not found the actual joke. Concepts are required
to declare their `caricature_handles` explicitly at S7 so that this clause is mechanically
checkable rather than a matter of impression.

---

## §4 Factual discipline

- Every factual proposition the cartoon rests on must be **verified at S6 against at least
  two independent sources**. Outlets sharing an owner are not independent — see
  `ownership_groups` in `outlets.he.yaml`.
- Satire may exaggerate a fact. It may not **invent** one. A caricature implying a
  politician did something they did not do is a false statement dressed as a joke, and it
  is actionable as such.
- Unverified claims are stripped from the brief at S6, not softened.
- Where a caricature depicts a contested allegation, the brief must say so in
  `risk_notes`, and the published caption must not assert it as settled.

---

## §5 Legal constraints (Israel)

**These require counsel's review. The notes below are operating guidance for the
pipeline, not a legal opinion.**

### §5.1 Defamation — חוק איסור לשון הרע

Israeli defamation law is notably plaintiff-friendly: **statutory damages are available
without proof of actual harm**, which lowers the practical barrier to suit well below
what US-trained instincts assume. Opinion and satire attract protection; **a factual
imputation embedded inside a satirical image does not**.

Operating rule: the gate asks of every concept — *stripped of its humour, does this image
assert a fact about a named person?* If yes, that fact must be S6-verified or the concept
is REVISE.

### §5.2 Military censor

Israel operates prior military censorship over defined security matters. Where S4 flags
`censor_risk: likely`, the candidate does not proceed to concept work without a human
decision. Where flagged `possible`, `risk_notes` must record it and the standards desk is
notified before publication.

### §5.3 Sub judice

Active criminal or judicial proceedings constrain comment. Where S4 sets
`sub_judice: true`, the concept may satirise the *politics* around the case but may not
depict guilt, a verdict, or an outcome as established.

### §5.4 Right of reply and corrections

Any published caricature later found to rest on a false factual premise triggers the
paper's standard correction procedure. The run directory is the evidence record for that
review — which is the reason the evidence contract exists.

---

## §6 REVISE triggers — fixable, not fatal

The gate returns REVISE, with specific and actionable asks, when:

- The joke depends on a claim S6 marked `partially_verified` or `unverified`
- The metaphor is *adjacent* to a §2 trope without landing on it, and a different metaphor
  would carry the same joke at no cost — **the burden here is on the concept, not the
  reader**; ambiguity resolves against publication
- A caricature handle in §3's prohibited column can be swapped for a permitted one
- The concept requires Hebrew text rendered inside the generated image (see §7.2)
- The gag needs a caption to be legible at all, indicating a legibility failure upstream
- The concept is substantially a repeat of a ledger entry from the last 90 days

---

## §7 Production constraints the gate also enforces

### §7.1 Attribution and sourcing

Every brief carries its source URLs and its verified claim list. A brief without sources
does not pass, however good the drawing.

### §7.2 Hebrew lettering is a post-render layer

Generated images render Hebrew right-to-left text unreliably — reversed, malformed, or
as plausible-looking nonsense. Every prompt package therefore instructs the renderer to
leave label plates, placards and speech balloons **empty**, and supplies the Hebrew
strings separately in `lettering_spec` for the graphics team to typeset.

A package whose image prompt asks the model to render Hebrew text is REVISE.

### §7.3 Accessibility

Hebrew and English alt text is mandatory on every package.

---

## §8 Human authority

The pipeline never self-approves. S11 requires an editor's explicit decision on every
candidate, recorded with their name and the time. The gate's PASS is a filter, not a
publication decision, and nothing in this document transfers editorial judgement to the
system.

---

## §9 Review

This policy is reviewed after the first ten published columns, then quarterly. Amendments
are versioned; the SHA recorded in each run's `09_gate.json` identifies the version that
applied. Every BLOCK and every REVISE is retained in the run record and reviewed in
aggregate — a gate that never fires is not evidence of safety, it is evidence of a broken
gate.
